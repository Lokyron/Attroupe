import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { racineServeur } from '../config/paquet.js';
import type { Base } from './base.js';
import { connexionBrute, fermerConnexion, ouvrirBase } from './connection.js';
import { preparer } from './sql.js';

// Exécution ordonnée et idempotente des migrations (ADR-0005, ADR-0008). Une migration jouée
// est suivie dans `schema_migrations` avec le checksum de son contenu : si le fichier change
// après coup, le démarrage échoue au lieu de rejouer ou d'ignorer en silence.

/** Migration impossible ou incohérente : le service ne doit pas démarrer. */
export class ErreurMigration extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurMigration';
  }
}

export interface OptionsMigration {
  /** Dossier des fichiers `NNNN_nom.sql` (par défaut : app/migrations). */
  readonly dossierMigrations?: string;
  /** Dossier des sauvegardes d'avant migration (par défaut : « sauvegardes » à côté de la base). */
  readonly dossierSauvegardes?: string;
}

export interface ResultatMigration {
  /** Versions jouées par cet appel, dans l'ordre. */
  readonly appliquees: readonly string[];
  /** Chemin de la sauvegarde d'avant migration, si une migration était en attente sur une base déjà migrée. */
  readonly sauvegarde: string | undefined;
}

export const DOSSIER_MIGRATIONS: string = join(racineServeur, '..', 'migrations');

const FICHIER_MIGRATION = /^(\d{4}_[a-z0-9_]+)\.sql$/;
const schemaLigne = z.object({ version: z.string(), checksum: z.string() });

interface Migration {
  readonly version: string;
  readonly sql: string;
  readonly checksum: string;
}

/** Les fins de ligne sont normalisées : un checkout Windows (CRLF) ne doit pas changer le checksum. */
function checksum(sql: string): string {
  return createHash('sha256').update(sql.replaceAll('\r\n', '\n')).digest('hex');
}

function lireMigrations(dossier: string): Migration[] {
  if (!existsSync(dossier)) throw new ErreurMigration(`Dossier des migrations introuvable : ${dossier}`);
  return readdirSync(dossier)
    .filter((nom) => nom.endsWith('.sql'))
    .map((nom) => {
      const version = FICHIER_MIGRATION.exec(nom)?.[1];
      if (version === undefined) {
        throw new ErreurMigration(`Nom de migration invalide : « ${nom} » (attendu : NNNN_nom.sql).`);
      }
      const sql = readFileSync(join(dossier, nom), 'utf8');
      return { version, sql, checksum: checksum(sql) };
    })
    .sort((a, b) => a.version.localeCompare(b.version));
}

/** Versions déjà jouées. La table est créée par 0001 elle-même : absente, rien n'a encore été joué. */
function lireAppliquees(base: Base): Map<string, string> {
  const existe = preparer(base, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (existe === undefined) return new Map();
  const lignes = preparer(base, 'SELECT version, checksum FROM schema_migrations ORDER BY version').all();
  return new Map(lignes.map((l) => schemaLigne.parse(l)).map((l) => [l.version, l.checksum]));
}

function horodatageFichier(): string {
  return new Date().toISOString().replaceAll(/[-:]/g, '').replace('.', '');
}

/** Sauvegarde cohérente à chaud (`VACUUM INTO`, correct en mode WAL) avant de toucher au schéma. */
function sauvegarder(base: Base, dossier: string, premiereVersion: string): string {
  mkdirSync(dossier, { recursive: true });
  // pid + aléa : deux processus qui migrent ensemble ne se disputent pas le même fichier (VACUUM INTO refuse d'écraser).
  const unique = `${String(process.pid)}-${randomBytes(3).toString('hex')}`;
  const chemin = join(dossier, `avant-${premiereVersion}-${horodatageFichier()}-${unique}.sqlite`);
  preparer(base, 'VACUUM INTO ?').run(chemin);
  return chemin;
}

/**
 * Joue, dans l'ordre, les migrations pas encore jouées. Sans effet si tout est à jour.
 * Échoue si une migration déjà jouée a changé (checksum) ou a disparu du dossier.
 */
export function migrer(base: Base, cheminBase: string, options: OptionsMigration = {}): ResultatMigration {
  const migrations = lireMigrations(options.dossierMigrations ?? DOSSIER_MIGRATIONS);
  const appliquees = lireAppliquees(base);

  const connues = new Set(migrations.map((m) => m.version));
  for (const version of appliquees.keys()) {
    if (!connues.has(version)) {
      throw new ErreurMigration(`La migration « ${version} » est enregistrée en base mais son fichier a disparu.`);
    }
  }
  for (const m of migrations) {
    const attendu = appliquees.get(m.version);
    if (attendu !== undefined && attendu !== m.checksum) {
      throw new ErreurMigration(
        `La migration « ${m.version} » a été modifiée après avoir été jouée (checksum ${m.checksum.slice(0, 12)}… ` +
          `au lieu de ${attendu.slice(0, 12)}…). Ne modifiez jamais une migration jouée : ajoutez-en une nouvelle.`,
      );
    }
  }

  const enAttente = migrations.filter((m) => !appliquees.has(m.version));
  const premiere = enAttente[0];
  if (premiere === undefined) return { appliquees: [], sauvegarde: undefined };

  // Une base vierge n'a rien à sauvegarder ; sinon, c'est ce qui rend le retour arrière possible.
  const sauvegarde =
    appliquees.size > 0
      ? sauvegarder(base, options.dossierSauvegardes ?? join(dirname(cheminBase), 'sauvegardes'), premiere.version)
      : undefined;

  const jouees: string[] = [];
  for (const m of enAttente) {
    // Une transaction par migration : un échec ne laisse pas un schéma à moitié appliqué. Le verrou
    // d'écriture est pris AVANT de relire schema_migrations : un autre processus qui démarre en même
    // temps a pu jouer cette migration entre notre première lecture et maintenant.
    const jouee = connexionBrute(base)
      .transaction(() => {
        const dejaJouee = lireAppliquees(base).get(m.version);
        if (dejaJouee !== undefined) {
          if (dejaJouee !== m.checksum) {
            throw new ErreurMigration(`La migration « ${m.version} » jouée par un autre processus diffère de ce fichier (checksum).`);
          }
          return false;
        }
        connexionBrute(base).exec(m.sql);
        // Préparée après exec : sur une base vierge, la table naît avec la migration 0001.
        preparer(base, 'INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)').run(m.version, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), m.checksum);
        return true;
      })
      .immediate();
    if (jouee) jouees.push(m.version);
  }
  return { appliquees: jouees, sauvegarde };
}

/**
 * Point d'entrée de la base pour le reste de l'application : ouvre (PRAGMA vérifiés) puis migre.
 * La connexion est fermée si la migration échoue.
 */
export function ouvrirEtMigrer(chemin: string, options: OptionsMigration = {}): Base {
  const base = ouvrirBase(chemin);
  try {
    migrer(base, chemin, options);
  } catch (erreur) {
    fermerConnexion(base);
    throw erreur;
  }
  return base;
}

/** Ferme la connexion (arrêt du service). Idempotent. */
export function fermer(base: Base): void {
  fermerConnexion(base);
}
