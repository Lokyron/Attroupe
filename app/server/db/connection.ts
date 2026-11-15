import Database from 'better-sqlite3';
import type { Base } from './base.js';

// Seul fichier du dépôt autorisé à importer la bibliothèque SQLite (ADR-0008, verrou n° 5).
// Hors de ce fichier, la connexion est un `Base` opaque (voir base.ts) : la vraie connexion n'en
// sort que par `connexionBrute`, que l'ESLint réserve à sql.ts et migrate.ts.

/** Requête préparée (usage interne à db/). */
export type Requete = Database.Statement;
/** Connexion de la bibliothèque (usage interne à db/). */
export type ConnexionBrute = Database.Database;

const connexions = new WeakMap<Base, ConnexionBrute>();

/** Ouvre la vraie connexion derrière un `Base` opaque. */
function envelopper(connexion: ConnexionBrute): Base {
  const base = Object.freeze({}) as Base;
  connexions.set(base, connexion);
  return base;
}

/** La vraie connexion de ce `Base`. Un objet qui n'a pas été fabriqué ici est refusé. */
export function connexionBrute(base: Base): ConnexionBrute {
  const connexion = connexions.get(base);
  if (connexion === undefined) throw new ErreurBase("Connexion inconnue : seule ouvrirBase fabrique un Base.");
  return connexion;
}

/** Pose ou vérification des PRAGMA impossible : le service ne doit pas démarrer. */
export class ErreurBase extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurBase';
  }
}

export interface OptionsBase {
  /** Attente maximale d'un verrou d'écriture, en millisecondes. */
  readonly busyTimeoutMs?: number;
}

const BUSY_TIMEOUT_DEFAUT_MS = 5000;
/** Valeur numérique de `PRAGMA synchronous = NORMAL`. */
const SYNCHRONOUS_NORMAL = 1;
/** Passage en WAL : tentatives et pause entre deux (deux processus qui démarrent ensemble se le disputent). */
const TENTATIVES_WAL = 20;
const PAUSE_WAL_MS = 100;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** La base est occupée par un autre processus (SQLITE_BUSY / SQLITE_LOCKED). */
function estOccupee(erreur: unknown): boolean {
  if (!(erreur instanceof Error)) return false;
  const code = 'code' in erreur ? String(erreur.code) : '';
  return /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(`${erreur.message} ${code}`);
}

/**
 * `journal_mode = WAL` demande un verrou exclusif bref : si un autre processus démarre en même
 * temps, il peut échouer en « database is locked » malgré le busy_timeout. On réessaie, et on
 * n'abandonne qu'après `TENTATIVES_WAL` essais. Un mode refusé (volume réseau sans mémoire
 * partagée : NFS, SMB) n'est PAS réessayé : c'est un échec voulu du démarrage.
 */
function passerEnWal(base: ConnexionBrute): unknown {
  for (let essai = 1; ; essai++) {
    try {
      return base.pragma('journal_mode = WAL', { simple: true });
    } catch (erreur) {
      if (!estOccupee(erreur) || essai >= TENTATIVES_WAL) throw erreur;
      pause(PAUSE_WAL_MS);
    }
  }
}

/**
 * Pose les PRAGMA de connexion puis les RELIT. `foreign_keys` n'est pas persistant : un PRAGMA
 * ignoré en silence ferait tomber les clés étrangères composites (verrou n° 4) sans que
 * personne ne le voie, d'où la relecture et le refus de démarrer.
 */
function poserPragmas(base: ConnexionBrute, chemin: string, busyTimeoutMs: number): void {
  // Le délai d'attente d'abord : il couvre déjà la plupart des courses au démarrage (relu plus bas).
  base.pragma(`busy_timeout = ${String(busyTimeoutMs)}`);

  const modeJournal = passerEnWal(base);
  const modeAttendu = chemin === ':memory:' ? 'memory' : 'wal';
  if (modeJournal !== modeAttendu) {
    throw new ErreurBase(
      `PRAGMA journal_mode : « ${String(modeJournal)} » obtenu, « ${modeAttendu} » attendu ` +
        '(le mode WAL est indisponible sur ce volume : NFS et SMB ne sont pas pris en charge).',
    );
  }

  base.pragma('foreign_keys = ON');
  const cles = base.pragma('foreign_keys', { simple: true });
  if (cles !== 1) {
    throw new ErreurBase(
      `PRAGMA foreign_keys inactif (valeur ${String(cles)}) : les clés étrangères composites ne protégeraient plus les groupes. Démarrage refusé.`,
    );
  }

  const attente = base.pragma('busy_timeout', { simple: true });
  if (attente !== busyTimeoutMs) {
    throw new ErreurBase(`PRAGMA busy_timeout : ${String(attente)} obtenu, ${String(busyTimeoutMs)} attendu.`);
  }

  base.pragma('synchronous = NORMAL');
  const synchro = base.pragma('synchronous', { simple: true });
  if (synchro !== SYNCHRONOUS_NORMAL) {
    throw new ErreurBase(`PRAGMA synchronous : ${String(synchro)} obtenu, ${String(SYNCHRONOUS_NORMAL)} (NORMAL) attendu.`);
  }
}

/** Ouvre la base, pose et vérifie les PRAGMA. La connexion est fermée si une vérification échoue. */
export function ouvrirBase(chemin: string, options: OptionsBase = {}): Base {
  const connexion = new Database(chemin);
  try {
    poserPragmas(connexion, chemin, options.busyTimeoutMs ?? BUSY_TIMEOUT_DEFAUT_MS);
  } catch (erreur) {
    connexion.close();
    throw erreur;
  }
  return envelopper(connexion);
}

/** Ferme la connexion (idempotent). */
export function fermerConnexion(base: Base): void {
  const connexion = connexionBrute(base);
  if (connexion.open) connexion.close();
}
