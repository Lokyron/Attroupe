import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOSSIER_MIGRATIONS, ErreurMigration, fermer, migrer, ouvrirEtMigrer } from '../../server/db/migrate.js';
import { brut } from '../fixtures/brut.js';
import { listerTables } from '../fixtures/schema.js';

// Migrations ordonnées, idempotentes, protégées par checksum et précédées d'une sauvegarde.
describe('migrations', () => {
  let dossier: string;
  let migrations: string;
  let chemin: string;

  beforeEach(() => {
    dossier = mkdtempSync(join(tmpdir(), 'attroupe-migr-'));
    // Copie du dossier réel : on peut y modifier un fichier ou en ajouter un sans toucher au dépôt.
    migrations = join(dossier, 'migrations');
    mkdirSync(migrations);
    for (const f of readdirSync(DOSSIER_MIGRATIONS)) copyFileSync(join(DOSSIER_MIGRATIONS, f), join(migrations, f));
    chemin = join(dossier, 'base.sqlite');
  });
  afterEach(() => rmSync(dossier, { recursive: true, force: true }));

  it('le schéma initial donne 37 tables STRICT et 45 index', () => {
    const base = ouvrirEtMigrer(chemin, { dossierMigrations: migrations });
    const sql = brut(base);
    try {
      expect(listerTables(sql)).toHaveLength(37);
      const strictes = sql
        .prepare("SELECT count(*) FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%' AND strict = 1")
        .pluck()
        .get();
      expect(strictes).toBe(37);
      const index = sql
        .prepare("SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
        .pluck()
        .get();
      expect(index).toBe(45);
      expect(sql.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      fermer(base);
    }
  });

  it('jouées deux fois de suite, la seconde est sans effet', () => {
    const base = ouvrirEtMigrer(chemin, { dossierMigrations: migrations });
    const sql = brut(base);
    try {
      const avant = sql.prepare('SELECT version, applied_at, checksum FROM schema_migrations').all();
      expect(avant).toHaveLength(8);
      const second = migrer(base, chemin, { dossierMigrations: migrations });
      expect(second).toEqual({ appliquees: [], sauvegarde: undefined });
      expect(sql.prepare('SELECT version, applied_at, checksum FROM schema_migrations').all()).toEqual(avant);
    } finally {
      fermer(base);
    }
  });

  it('survit à une réouverture de la base (démarrage suivant du conteneur)', () => {
    fermer(ouvrirEtMigrer(chemin, { dossierMigrations: migrations }));
    fermer(ouvrirEtMigrer(chemin, { dossierMigrations: migrations }));
    expect(existsSync(join(dossier, 'sauvegardes'))).toBe(false);
  });

  it('un checksum modifié fait échouer le démarrage, et rien n’est rejoué', () => {
    fermer(ouvrirEtMigrer(chemin, { dossierMigrations: migrations }));
    const fichier = join(migrations, '0001_socle.sql');
    writeFileSync(fichier, `${readFileSync(fichier, 'utf8')}\n-- modifié après coup\n`);
    expect(() => ouvrirEtMigrer(chemin, { dossierMigrations: migrations })).toThrow(ErreurMigration);
    expect(() => ouvrirEtMigrer(chemin, { dossierMigrations: migrations })).toThrow(/modifiée après avoir été jouée/);
  });

  it('les fins de ligne CRLF ne changent pas le checksum', () => {
    fermer(ouvrirEtMigrer(chemin, { dossierMigrations: migrations }));
    const fichier = join(migrations, '0001_socle.sql');
    writeFileSync(fichier, readFileSync(fichier, 'utf8').replaceAll('\n', '\r\n'));
    fermer(ouvrirEtMigrer(chemin, { dossierMigrations: migrations }));
  });

  it('une migration jouée dont le fichier a disparu fait échouer le démarrage', () => {
    fermer(ouvrirEtMigrer(chemin, { dossierMigrations: migrations }));
    rmSync(join(migrations, '0001_socle.sql'));
    writeFileSync(join(migrations, '0009_autre.sql'), 'CREATE TABLE autre (id TEXT NOT NULL PRIMARY KEY) STRICT;');
    expect(() => ouvrirEtMigrer(chemin, { dossierMigrations: migrations })).toThrow(/fichier a disparu/);
  });

  it('un nom de fichier invalide est refusé', () => {
    writeFileSync(join(migrations, 'oups.sql'), 'SELECT 1;');
    expect(() => ouvrirEtMigrer(chemin, { dossierMigrations: migrations })).toThrow(/Nom de migration invalide/);
  });

  it('une nouvelle migration est jouée dans l’ordre, après une sauvegarde cohérente de l’état précédent', () => {
    fermer(ouvrirEtMigrer(chemin, { dossierMigrations: migrations }));
    writeFileSync(join(migrations, '0009_ajout.sql'), 'CREATE TABLE ajout (id TEXT NOT NULL PRIMARY KEY) STRICT;');

    const base = ouvrirEtMigrer(chemin, { dossierMigrations: migrations });
    const sql = brut(base);
    try {
      const versions = sql.prepare('SELECT version FROM schema_migrations ORDER BY version').pluck().all();
      expect(versions).toEqual(['0001_socle', '0002_verification_email', '0003_profil_et_push', '0004_agenda_externe', '0005_agenda_externe_details', '0006_notifications_reglement', '0007_listes_type', '0008_preferences_notifications_heritage', '0009_ajout']);
      expect(listerTables(sql)).toContain('ajout');

      const sauvegardes = readdirSync(join(dossier, 'sauvegardes'));
      expect(sauvegardes).toHaveLength(1);
      expect(sauvegardes[0]).toMatch(/^avant-0009_ajout-.*-\d+-[0-9a-f]{6}\.sqlite$/);

      // La sauvegarde est l'état d'AVANT : complète (37 tables) et sans la table de la migration 0009.
      sql.prepare('ATTACH DATABASE ? AS sauvegarde').run(join(dossier, 'sauvegardes', sauvegardes[0] ?? ''));
      const tablesSauvegardees = sql
        .prepare("SELECT name FROM sauvegarde.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .pluck()
        .all();
      expect(tablesSauvegardees).toHaveLength(37);
      expect(tablesSauvegardees).not.toContain('ajout');
      expect(sql.prepare('SELECT version FROM sauvegarde.schema_migrations').pluck().all()).toEqual(['0001_socle', '0002_verification_email', '0003_profil_et_push', '0004_agenda_externe', '0005_agenda_externe_details', '0006_notifications_reglement', '0007_listes_type', '0008_preferences_notifications_heritage']);
    } finally {
      fermer(base);
    }
  });

  it('une migration qui échoue est annulée en entier', () => {
    fermer(ouvrirEtMigrer(chemin, { dossierMigrations: migrations }));
    writeFileSync(
      join(migrations, '0009_cassee.sql'),
      'CREATE TABLE moitie (id TEXT NOT NULL PRIMARY KEY) STRICT;\nCREATE TABLE moitie (id TEXT) STRICT;',
    );
    expect(() => ouvrirEtMigrer(chemin, { dossierMigrations: migrations })).toThrow();
    writeFileSync(join(migrations, '0009_cassee.sql'), 'SELECT 1;');
    const base = ouvrirEtMigrer(chemin, { dossierMigrations: migrations });
    const sql = brut(base);
    try {
      expect(listerTables(sql)).not.toContain('moitie');
    } finally {
      fermer(base);
    }
  });
});
