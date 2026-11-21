import { z } from 'zod';
import { egalTempsConstant, empreinteJeton, nouveauJeton } from '../../domain/jetons.js';
import { verifier } from '../../services/mot-de-passe.js';
import type { Base } from '../base.js';
import { nouvelIdentifiant } from '../identifiant.js';
import { baseDe, type PorteeUtilisateur } from '../portee-utilisateur.js';
import { executerEnTransaction, preparer } from '../sql.js';
import { urlAvatar } from './avatar.js';
import { enfilerEmail, type EmailAEnfiler } from './transverse.js';

// Comptes, sessions et jetons d'authentification (lot 2). Ces tables n'ont pas de groupe : on y accède
//  - AVANT d'être authentifié par une clé naturelle (adresse e-mail, empreinte d'un jeton), jamais par un
//    identifiant venu d'une requête ;
//  - APRÈS, par la `PorteeUtilisateur`, qui fournit l'identifiant du compte (jamais un paramètre libre).
// Les rares fonctions qui manipulent un identifiant de compte avant la portée reçoivent un compte typé :
//  - `CompteAuthentifiable` : trouvé par son adresse e-mail, SANS aucune preuve (n'importe qui connaissant
//    l'adresse en obtient un). Il ne donne le droit de rien faire d'autre que d'être vérifié ;
//  - `CompteProuve` : produit UNIQUEMENT par `prouverParMotDePasse` après une vérification réussie. C'est lui
//    qu'exigent `creerSession` et `remplacerEmpreinteMotDePasse` : une route qui voudrait ouvrir une session sans
//    mot de passe (invitation par lien, retour OIDC en V2…) ne compile pas sans passer par une preuve.
// Les deux sont fabriqués par ce module seul, à partir d'une ligne lue en base.
//
// Les instants (`maintenant`, `expireLe`) sont passés par l'appelant au format du modèle (domain/instant.ts).

const MARQUE: unique symbol = Symbol('CompteAuthentifiable');
const MARQUE_PREUVE: unique symbol = Symbol('CompteProuve');

/** Compte trouvé par son adresse e-mail, en attente de preuve (mot de passe) : non fabricable hors de ce module. */
export interface CompteAuthentifiable {
  readonly [MARQUE]: true;
  readonly display_name: string;
  /** `null` : compte sans mot de passe (connexion externe, V2). */
  readonly password_hash: string | null;
}

/** Compte dont l'identité vient d'être PROUVÉE (mot de passe vérifié) : non fabricable hors de ce module. */
export interface CompteProuve {
  readonly [MARQUE_PREUVE]: true;
  readonly password_hash: string;
}

/** Les identifiants des comptes ne sortent pas de ce module. Deux tables distinctes : un compte non prouvé ne sert jamais de preuve, même à l'exécution. */
const IDENTIFIANTS = new WeakMap<CompteAuthentifiable, string>();
const IDENTIFIANTS_PROUVES = new WeakMap<CompteProuve, string>();

function fabriquer(ligne: { id: string; display_name: string; password_hash: string | null }): CompteAuthentifiable {
  const compte: CompteAuthentifiable = Object.freeze({
    [MARQUE]: true as const,
    display_name: ligne.display_name,
    password_hash: ligne.password_hash,
  });
  IDENTIFIANTS.set(compte, ligne.id);
  return compte;
}

function identifiantDe(compte: CompteAuthentifiable): string {
  const id = IDENTIFIANTS.get(compte);
  if (id === undefined) throw new Error('CompteAuthentifiable forgé : seule chercherCompteActifParEmail en fabrique.');
  return id;
}

function identifiantProuve(compte: CompteProuve): string {
  const id = IDENTIFIANTS_PROUVES.get(compte);
  if (id === undefined) throw new Error('CompteProuve forgé ou non prouvé : seule prouverParMotDePasse en fabrique.');
  return id;
}

const ligneCompte = z.object({ id: z.string(), display_name: z.string(), password_hash: z.string().nullable() });

/** Compte ACTIF (ni suspendu ni anonymisé) portant cette adresse (déjà normalisée en minuscules), ou `undefined`. */
export function chercherCompteActifParEmail(base: Base, email: string): CompteAuthentifiable | undefined {
  const ligne = preparer(
    base,
    'SELECT id, display_name, password_hash FROM users WHERE lower(email) = lower(?) AND disabled_at IS NULL AND anonymized_at IS NULL',
  ).get(email);
  return ligne === undefined ? undefined : fabriquer(ligneCompte.parse(ligne));
}

/**
 * Vérifie le mot de passe et, s'il est correct, délivre la preuve. `compte` absent, suspendu ou sans mot de
 * passe : on vérifie quand même contre `empreinteLeurre` (durée comparable, pas d'énumération) et on ne prouve rien.
 */
export async function prouverParMotDePasse(
  compte: CompteAuthentifiable | undefined,
  motDePasse: string,
  empreinteLeurre: string,
): Promise<CompteProuve | undefined> {
  const correct = await verifier(motDePasse, compte?.password_hash ?? empreinteLeurre);
  if (compte === undefined || compte.password_hash === null || !correct) return undefined;
  const preuve: CompteProuve = Object.freeze({ [MARQUE_PREUVE]: true as const, password_hash: compte.password_hash });
  IDENTIFIANTS_PROUVES.set(preuve, identifiantDe(compte));
  return preuve;
}

// --- Inscription -------------------------------------------------------------------------------

export interface NouveauCompte {
  readonly email: string;
  readonly username: string;
  readonly display_name: string;
  readonly password_hash: string;
  /** E-mail de vérification. Il ne porte que l'identifiant de la ligne de jeton : le jeton naît à l'envoi (services/brevo.ts). */
  readonly emailVerification: (jetonId: string) => EmailAEnfiler;
  /** E-mail envoyé au PROPRIÉTAIRE quand l'adresse est déjà inscrite (l'appelant ne le saura jamais). */
  readonly emailCompteExistant: (nomAffiche: string) => EmailAEnfiler;
}

export type ResultatInscription = 'cree' | 'nom_utilisateur_pris' | 'email_deja_inscrit';

// Les jetons d'e-mail (vérification, réinitialisation) vivent en deux temps. À la DEMANDE, on écrit une ligne
// « inerte » (empreinte d'un secret jeté, `expires_at = created_at` : rien ne peut la consommer) et on met en
// file un e-mail qui ne porte que l'identifiant de cette ligne. À l'ENVOI, `armerJetonEnvoi` tire le vrai jeton,
// écrit son empreinte et fait partir la validité de ce moment-là : la file ne contient jamais de jeton, et un lien
// n'arrive jamais périmé parce que l'e-mail a dormi.
function insererJetonInerte(base: Base, table: 'verification' | 'reinitialisation', userId: string, maintenant: string): string {
  const id = nouvelIdentifiant();
  const inerte = empreinteJeton(nouveauJeton());
  if (table === 'verification') {
    preparer(base, 'INSERT INTO email_verification_tokens (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      userId,
      inerte,
      maintenant,
      maintenant,
    );
  } else {
    preparer(base, 'INSERT INTO password_reset_tokens (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      userId,
      inerte,
      maintenant,
      maintenant,
    );
  }
  return id;
}

/**
 * À l'envoi : donne son jeton à la ligne (empreinte + échéance qui part de MAINTENANT). Faux — et l'e-mail ne
 * doit pas partir — si la ligne est déjà utilisée ou remplacée, créée avant `creeApres` (demande trop ancienne)
 * ou, pour une vérification, si l'adresse est déjà vérifiée.
 */
export function armerJetonEnvoi(
  base: Base,
  nature: 'verification' | 'reinitialisation',
  jetonId: string,
  empreinte: string,
  expireLe: string,
  creeApres: string,
): boolean {
  const resultat =
    nature === 'verification'
      ? preparer(
          base,
          `UPDATE email_verification_tokens SET token_hash = ?, expires_at = ?
           WHERE id = ? AND used_at IS NULL AND created_at > ?
             AND user_id IN (SELECT id FROM users WHERE email_verified_at IS NULL)`,
        ).run(empreinte, expireLe, jetonId, creeApres)
      : preparer(
          base,
          'UPDATE password_reset_tokens SET token_hash = ?, expires_at = ? WHERE id = ? AND used_at IS NULL AND created_at > ?',
        ).run(empreinte, expireLe, jetonId, creeApres);
  return resultat.changes === 1;
}

/**
 * Crée le compte, sa ligne de jeton de vérification et l'e-mail correspondant, en une transaction. Le nom
 * d'utilisateur est public par nature (ajout d'un membre par nom exact) : son refus se dit. L'adresse,
 * elle, ne se dit jamais : si elle est déjà inscrite, rien n'est créé, le propriétaire est prévenu par
 * e-mail, et l'appelant répond comme pour une création.
 */
export function creerCompte(base: Base, nouveau: NouveauCompte, maintenant: string): ResultatInscription {
  return executerEnTransaction(base, () => {
    if (preparer(base, 'SELECT 1 FROM users WHERE lower(username) = lower(?)').get(nouveau.username) !== undefined) {
      return 'nom_utilisateur_pris' as const;
    }
    const existant = preparer(base, 'SELECT display_name FROM users WHERE lower(email) = lower(?) AND anonymized_at IS NULL').get(
      nouveau.email,
    );
    if (existant !== undefined) {
      const { display_name } = z.object({ display_name: z.string() }).parse(existant);
      enfilerEmail(base, nouveau.emailCompteExistant(display_name), maintenant);
      return 'email_deja_inscrit' as const;
    }
    const id = nouvelIdentifiant();
    preparer(
      base,
      `INSERT INTO users (id, email, username, display_name, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, nouveau.email, nouveau.username, nouveau.display_name, nouveau.password_hash, maintenant, maintenant);
    enfilerEmail(base, nouveau.emailVerification(insererJetonInerte(base, 'verification', id, maintenant)), maintenant);
    return 'cree' as const;
  });
}

/** Lancée pour annuler une transaction dont l'issue métier est « refusé » (et non une panne). */
class TransactionAnnulee extends Error {}

const ligneJeton = z.object({ id: z.string(), user_id: z.string(), token_hash: z.string() });

/** Consomme un jeton de vérification (usage unique, non expiré) et marque l'adresse vérifiée. */
export function verifierEmailParJeton(base: Base, empreinte: string, maintenant: string): boolean {
  return executerEnTransaction(base, () => {
    const ligne = preparer(
      base,
      'SELECT id, user_id, token_hash FROM email_verification_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
    ).get(empreinte, maintenant);
    if (ligne === undefined) return false;
    const jeton = ligneJeton.parse(ligne);
    if (!egalTempsConstant(jeton.token_hash, empreinte)) return false;
    // `used_at IS NULL` dans l'UPDATE : deux requêtes simultanées ne consomment pas le même jeton deux fois.
    const pris = preparer(base, 'UPDATE email_verification_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').run(maintenant, jeton.id);
    if (pris.changes !== 1) return false;
    preparer(
      base,
      'UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ? AND email_verified_at IS NULL AND anonymized_at IS NULL',
    ).run(maintenant, maintenant, jeton.user_id);
    return true;
  });
}

// --- Mot de passe oublié ---------------------------------------------------------------------------

/**
 * Si un compte actif porte cette adresse : invalide ses demandes en cours, crée une ligne de jeton (inerte
 * jusqu'à l'envoi) et met l'e-mail en file. Renvoie si un compte a été trouvé — information RÉSERVÉE au serveur, jamais répétée à l'appelant HTTP.
 */
export function demanderReinitialisation(
  base: Base,
  email: string,
  maintenant: string,
  fabriquerEmail: (nomAffiche: string, jetonId: string) => EmailAEnfiler,
): boolean {
  return executerEnTransaction(base, () => {
    const ligne = preparer(
      base,
      'SELECT id, display_name FROM users WHERE lower(email) = lower(?) AND disabled_at IS NULL AND anonymized_at IS NULL',
    ).get(email);
    if (ligne === undefined) return false;
    const compte = z.object({ id: z.string(), display_name: z.string() }).parse(ligne);
    preparer(base, 'UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(maintenant, compte.id);
    enfilerEmail(base, fabriquerEmail(compte.display_name, insererJetonInerte(base, 'reinitialisation', compte.id, maintenant)), maintenant);
    return true;
  });
}

/** Le jeton de réinitialisation existe-t-il, non utilisé et non expiré ? (lecture seule, avant de hacher le nouveau mot de passe) */
export function jetonReinitialisationValide(base: Base, empreinte: string, maintenant: string): boolean {
  const ligne = preparer(base, 'SELECT token_hash FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(
    empreinte,
    maintenant,
  );
  return ligne !== undefined && egalTempsConstant(z.object({ token_hash: z.string() }).parse(ligne).token_hash, empreinte);
}

/**
 * Consomme le jeton (une seule fois), pose le nouveau mot de passe et RÉVOQUE TOUTES les sessions du compte,
 * le tout en une transaction. Faux si le jeton est inconnu, utilisé ou expiré.
 */
export function reinitialiserMotDePasse(base: Base, empreinte: string, nouveauHash: string, maintenant: string): boolean {
  try {
    return executerEnTransaction(base, () => {
      const ligne = preparer(
        base,
        'SELECT id, user_id, token_hash FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
      ).get(empreinte, maintenant);
      if (ligne === undefined) return false;
      const jeton = ligneJeton.parse(ligne);
      if (!egalTempsConstant(jeton.token_hash, empreinte)) return false;
      const pris = preparer(base, 'UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').run(maintenant, jeton.id);
      if (pris.changes !== 1) throw new TransactionAnnulee();
      const modifie = preparer(
        base,
        'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ? AND disabled_at IS NULL AND anonymized_at IS NULL',
      ).run(nouveauHash, maintenant, jeton.user_id);
      // Compte suspendu depuis la demande : tout est annulé, y compris la consommation du jeton.
      if (modifie.changes !== 1) throw new TransactionAnnulee();
      preparer(base, 'UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(maintenant, jeton.user_id);
      preparer(base, 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(maintenant, jeton.user_id);
      return true;
    });
  } catch (erreur) {
    if (erreur instanceof TransactionAnnulee) return false;
    throw erreur;
  }
}

/** Remplace l'empreinte du mot de passe d'un compte qui vient de prouver le sien (durcissement des paramètres). */
export function remplacerEmpreinteMotDePasse(base: Base, compte: CompteProuve, nouveauHash: string, maintenant: string): void {
  preparer(base, 'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(nouveauHash, maintenant, identifiantProuve(compte));
}

// --- Sessions --------------------------------------------------------------------------------------

/** Au-delà, la session la plus ancienne (dernière activité) est révoquée : pas de croissance sans borne. */
export const SESSIONS_MAX_PAR_COMPTE = 20;

export interface NouvelleSession {
  readonly empreinte: string;
  readonly maintenant: string;
  readonly expireLe: string;
  readonly userAgent: string | null;
  readonly ipHash: string | null;
}

/** Ouvre une session pour un compte qui vient de prouver son identité. Renvoie l'identifiant de la session. */
export function creerSession(base: Base, compte: CompteProuve, session: NouvelleSession): string {
  const userId = identifiantProuve(compte);
  return executerEnTransaction(base, () => {
    const id = nouvelIdentifiant();
    preparer(
      base,
      `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, userId, session.empreinte, session.maintenant, session.expireLe, session.maintenant, session.userAgent, session.ipHash);
    const actives = preparer(
      base,
      'SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC, id DESC',
    )
      .all(userId, session.maintenant)
      .map((l) => z.object({ id: z.string() }).parse(l).id);
    for (const trop of actives.slice(SESSIONS_MAX_PAR_COMPTE)) {
      preparer(base, 'UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(session.maintenant, trop);
    }
    return id;
  });
}

export interface SessionTrouvee {
  readonly id: string;
  /** Sert UNIQUEMENT à fabriquer la portée (http/middleware/session.ts) : une route ne le lit jamais. */
  readonly userId: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
}

const ligneSession = z.object({
  id: z.string(),
  user_id: z.string(),
  token_hash: z.string(),
  created_at: z.string(),
  last_seen_at: z.string(),
});

/** Session ouverte (ni révoquée ni expirée) dont le jeton a cette empreinte. */
export function trouverSession(base: Base, empreinte: string, maintenant: string): SessionTrouvee | undefined {
  const ligne = preparer(
    base,
    'SELECT id, user_id, token_hash, created_at, last_seen_at FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?',
  ).get(empreinte, maintenant);
  if (ligne === undefined) return undefined;
  const s = ligneSession.parse(ligne);
  if (!egalTempsConstant(s.token_hash, empreinte)) return undefined;
  return { id: s.id, userId: s.user_id, createdAt: s.created_at, lastSeenAt: s.last_seen_at };
}

/**
 * La session est-elle toujours vivante (ni révoquée ni échue) ET le compte toujours actif (ni suspendu ni anonymisé) ? Relue en base :
 * sert aux connexions longues (flux temps réel), qui ne repassent pas par l'intergiciel de session entre deux envois. La suspension
 * s'écrit sur `users`, sans toucher `sessions` : c'est `creerPorteeUtilisateur` qui la fait respecter à chaque requête, donc il faut la
 * relire ici aussi.
 */
export function sessionVivante(portee: PorteeUtilisateur, sessionId: string, maintenant: string): boolean {
  return (
    preparer(
      baseDe(portee),
      `SELECT 1 FROM sessions AS s JOIN users AS u ON u.id = s.user_id
       WHERE s.user_id = ? AND s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.disabled_at IS NULL AND u.anonymized_at IS NULL`,
    ).get(portee.userId, sessionId, maintenant) !== undefined
  );
}

/** Prolonge une session (glissante) de CE compte : nouvelle échéance et dernière activité. */
export function prolongerSession(portee: PorteeUtilisateur, sessionId: string, maintenant: string, expireLe: string): void {
  preparer(baseDe(portee), 'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(
    maintenant,
    expireLe,
    sessionId,
    portee.userId,
  );
}

export interface SessionListee {
  readonly id: string;
  readonly created_at: string;
  readonly last_seen_at: string;
  readonly expires_at: string;
  readonly user_agent: string | null;
}

const ligneSessionListee = z.object({
  id: z.string(),
  created_at: z.string(),
  last_seen_at: z.string(),
  expires_at: z.string(),
  user_agent: z.string().nullable(),
});

/** Les sessions ouvertes de CE compte (la plus récemment utilisée d'abord). L'empreinte du jeton n'en sort jamais. */
export function listerSessions(portee: PorteeUtilisateur, maintenant: string): SessionListee[] {
  return preparer(
    baseDe(portee),
    `SELECT id, created_at, last_seen_at, expires_at, user_agent FROM sessions
     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC, id DESC`,
  )
    .all(portee.userId, maintenant)
    .map((l) => ligneSessionListee.parse(l));
}

/** Révoque une session de CE compte. Faux (donc 404) si elle n'existe pas, est déjà révoquée ou appartient à un autre compte. */
export function revoquerSession(portee: PorteeUtilisateur, sessionId: string, maintenant: string): boolean {
  return (
    preparer(baseDe(portee), 'UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(
      maintenant,
      sessionId,
      portee.userId,
    ).changes === 1
  );
}

/** Révoque toutes les sessions de CE compte sauf `sessionCouranteId`. Renvoie le nombre de sessions révoquées. */
export function revoquerAutresSessions(portee: PorteeUtilisateur, sessionCouranteId: string, maintenant: string): number {
  return preparer(baseDe(portee), 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL').run(
    maintenant,
    portee.userId,
    sessionCouranteId,
  ).changes;
}

// --- Profil ------------------------------------------------------------------------------------------

const ligneProfil = z.object({
  id: z.string(),
  email: z.string(),
  email_verified_at: z.string().nullable(),
  username: z.string(),
  display_name: z.string(),
  birthday: z.string().nullable(),
  locale: z.string(),
  time_zone: z.string(),
  created_at: z.string(),
  avatar_updated_at: z.string().nullable(),
  /** Ce que les membres des groupes voient de l'agenda personnel (ADR-0017) : un plafond, jamais une promesse sur le flux iCal. */
  personal_agenda_visibility: z.enum(['none', 'busy', 'details']),
});

export type Profil = Omit<z.infer<typeof ligneProfil>, 'avatar_updated_at'> & {
  readonly avatar_url: string | null;
};

/** Le compte de la portée (jamais le hachage du mot de passe). */
export function lireProfil(portee: PorteeUtilisateur): Profil {
  const brut = preparer(
    baseDe(portee),
    'SELECT id, email, email_verified_at, username, display_name, birthday, locale, time_zone, created_at, avatar_updated_at, personal_agenda_visibility FROM users WHERE id = ?',
  ).get(portee.userId);
  const { avatar_updated_at, ...reste } = ligneProfil.parse(brut);
  return {
    ...reste,
    avatar_url: urlAvatar(reste.id, avatar_updated_at),
  };
}

export interface ModificationProfil {
  readonly display_name?: string | undefined;
  readonly time_zone?: string | undefined;
  readonly birthday?: string | null | undefined;
  readonly personal_agenda_visibility?: 'none' | 'busy' | 'details' | undefined;
}

/** Modifie les seules colonnes de profil autorisées, sur le compte de la portée. */
export function modifierProfil(portee: PorteeUtilisateur, champs: ModificationProfil, maintenant: string): void {
  const base = baseDe(portee);
  const sets: string[] = [];
  const valeurs: Array<string | null> = [];
  if (champs.display_name !== undefined) {
    sets.push('display_name = ?');
    valeurs.push(champs.display_name);
  }
  if (champs.time_zone !== undefined) {
    sets.push('time_zone = ?');
    valeurs.push(champs.time_zone);
  }
  if (champs.birthday !== undefined) {
    sets.push('birthday = ?');
    valeurs.push(champs.birthday);
  }
  if (champs.personal_agenda_visibility !== undefined) {
    sets.push('personal_agenda_visibility = ?');
    valeurs.push(champs.personal_agenda_visibility);
  }
  if (sets.length === 0) return;
  // Les noms de colonnes viennent du code ci-dessus, jamais de la requête ; les valeurs sont liées.
  preparer(base, `UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...valeurs, maintenant, portee.userId);
}

// --- Mot de passe et adresse e-mail du compte connecté ------------------------------------------------

/** Empreinte du mot de passe de CE compte (`null` : compte sans mot de passe). Sert à vérifier l'ancien mot de passe, jamais à répondre. */
export function lireEmpreinteMotDePasse(portee: PorteeUtilisateur): string | null {
  const ligne = preparer(baseDe(portee), 'SELECT password_hash FROM users WHERE id = ?').get(portee.userId);
  return z.object({ password_hash: z.string().nullable() }).parse(ligne).password_hash;
}

export interface ChangementMotDePasse {
  /** Empreinte lue AVANT la vérification : le changement n'a lieu que si elle n'a pas bougé entre-temps. */
  readonly ancienneEmpreinte: string;
  readonly nouvelleEmpreinte: string;
  /** Empreinte du nouveau jeton de la session courante. */
  readonly empreinteSession: string;
  readonly expireLe: string;
}

/**
 * Pose le nouveau mot de passe, invalide les réinitialisations en cours, RÉVOQUE les autres sessions et change le
 * jeton de la session courante (l'ancien cookie, éventuellement volé, ne vaut plus rien), le tout en une transaction.
 * Faux (rien n'est modifié) si le mot de passe a changé entre-temps ou si la session courante n'est plus ouverte.
 */
export function changerMotDePasse(portee: PorteeUtilisateur, sessionCouranteId: string, changement: ChangementMotDePasse, maintenant: string): boolean {
  const base = baseDe(portee);
  try {
    return executerEnTransaction(base, () => {
      const modifie = preparer(
        base,
        `UPDATE users SET password_hash = ?, updated_at = ?
         WHERE id = ? AND password_hash = ? AND disabled_at IS NULL AND anonymized_at IS NULL`,
      ).run(changement.nouvelleEmpreinte, maintenant, portee.userId, changement.ancienneEmpreinte);
      if (modifie.changes !== 1) throw new TransactionAnnulee();
      preparer(base, 'UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(maintenant, portee.userId);
      preparer(base, 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL').run(
        maintenant,
        portee.userId,
        sessionCouranteId,
      );
      const pivote = preparer(
        base,
        'UPDATE sessions SET token_hash = ?, last_seen_at = ?, expires_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      ).run(changement.empreinteSession, maintenant, changement.expireLe, sessionCouranteId, portee.userId);
      if (pivote.changes !== 1) throw new TransactionAnnulee();
      return true;
    });
  } catch (erreur) {
    if (erreur instanceof TransactionAnnulee) return false;
    throw erreur;
  }
}

export type ResultatRenvoiVerification = 'envoye' | 'deja_verifie';

/**
 * Renvoie le mail de vérification de CE compte : invalide les liens non utilisés, crée une ligne de jeton (inerte
 * jusqu'à l'envoi) et met l'e-mail en file, en une transaction. Un lien expiré se rattrape ainsi.
 */
export function demanderVerification(
  portee: PorteeUtilisateur,
  maintenant: string,
  fabriquerEmail: (adresse: string, nomAffiche: string, jetonId: string) => EmailAEnfiler,
): ResultatRenvoiVerification {
  const base = baseDe(portee);
  return executerEnTransaction(base, () => {
    const ligne = z
      .object({ email: z.string(), display_name: z.string(), email_verified_at: z.string().nullable() })
      .parse(preparer(base, 'SELECT email, display_name, email_verified_at FROM users WHERE id = ?').get(portee.userId));
    if (ligne.email_verified_at !== null) return 'deja_verifie' as const;
    preparer(base, 'UPDATE email_verification_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(maintenant, portee.userId);
    enfilerEmail(base, fabriquerEmail(ligne.email, ligne.display_name, insererJetonInerte(base, 'verification', portee.userId, maintenant)), maintenant);
    return 'envoye' as const;
  });
}

// --- Entretien -----------------------------------------------------------------------------------------

/** Supprime les sessions et jetons morts depuis avant `avant` (révoqués, expirés, utilisés). Renvoie le nombre de lignes. */
export function purgerAuthentification(base: Base, avant: string): number {
  return executerEnTransaction(base, () => {
    // Deux requêtes plutôt qu'un OR : la garde du SQL brut refuse la disjonction (verrou n° 5).
    let total = preparer(base, 'DELETE FROM sessions WHERE expires_at < ?').run(avant).changes;
    total += preparer(base, 'DELETE FROM sessions WHERE revoked_at < ?').run(avant).changes;
    total += preparer(base, 'DELETE FROM password_reset_tokens WHERE expires_at < ?').run(avant).changes;
    total += preparer(base, 'DELETE FROM email_verification_tokens WHERE expires_at < ?').run(avant).changes;
    return total;
  });
}
