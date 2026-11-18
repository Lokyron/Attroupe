import { z } from 'zod';
import { baseDeScope, type GroupScope } from '../scope.js';
import type { Base } from '../base.js';
import { baseDe, type PorteeUtilisateur } from '../portee-utilisateur.js';
import { preparer } from '../sql.js';

// Flux iCal (lot 5). Trois familles de fonctions :
//  - la GESTION des jetons (`/api/moi/flux-ical`) : elle passe par la `PorteeUtilisateur`, donc par `user_id = ?` posé par la
//    portée — un jeton d'un autre compte est introuvable ;
//  - la RÉSOLUTION d'un jeton présenté sans cookie (`jetonParEmpreinte`) : la seule lecture par `token_hash` seul, exception nommée
//    de la garde du SQL brut (db/sql.ts, ACCES_ALTERNATIFS). Elle ne rend que les colonnes du jeton, sans jointure ;
//  - la LECTURE des événements, groupe par groupe, sous un `GroupScope` : le flux ne lit jamais `events` autrement.

// --- Gestion des jetons -------------------------------------------------------------------------------------------

const ligneAbonnement = z.object({
  id: z.string(),
  group_id: z.string().nullable(),
  label: z.string().nullable(),
  include_personal: z.union([z.literal(0), z.literal(1)]),
  include_declined: z.union([z.literal(0), z.literal(1)]),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  last_user_agent: z.string().nullable(),
  revoked_at: z.string().nullable(),
});

/** Un abonnement tel que le compte le voit : JAMAIS le jeton (il n'existe qu'haché), ni son empreinte. */
export type Abonnement = z.infer<typeof ligneAbonnement>;

/** Mes abonnements, du plus récent au plus ancien, révoqués compris (ils restent visibles pour l'historique). */
export function listerAbonnements(portee: PorteeUtilisateur): Abonnement[] {
  return portee
    .tous<unknown>('calendar_feed_tokens', [], { ordre: [{ colonne: 'created_at', sens: 'DESC' }, { colonne: 'id' }] })
    .map((ligne) => ligneAbonnement.parse(ligne));
}

export interface NouvelAbonnement {
  readonly empreinte: string;
  readonly groupId: string | null;
  readonly label: string | null;
  readonly includePersonal: boolean;
  readonly includeDeclined: boolean;
}

/** Enregistre l'empreinte d'un jeton. L'appelant a vérifié l'appartenance au groupe (la portée la revérifie à l'insertion). */
export function creerAbonnement(portee: PorteeUtilisateur, a: NouvelAbonnement): Abonnement {
  const id = portee.inserer('calendar_feed_tokens', {
    token_hash: a.empreinte,
    group_id: a.groupId,
    label: a.label,
    include_personal: a.includePersonal ? 1 : 0,
    include_declined: a.includeDeclined ? 1 : 0,
  });
  const ligne = portee.un<unknown>('calendar_feed_tokens', id);
  if (ligne === undefined) throw new Error('Abonnement introuvable juste après sa création.');
  return ligneAbonnement.parse(ligne);
}

/** Révoque (jamais de suppression de ligne). `false` si ce n'est pas MON abonnement ; déjà révoqué : sans effet, `true`. */
export function revoquerAbonnement(portee: PorteeUtilisateur, id: string, maintenant: string): boolean {
  const ligne = portee.un<unknown>('calendar_feed_tokens', id);
  if (ligne === undefined) return false;
  if (ligneAbonnement.parse(ligne).revoked_at === null) portee.modifier('calendar_feed_tokens', id, { revoked_at: maintenant });
  return true;
}

/** Trace l'usage du jeton. `WHERE id = ? AND user_id = ?` : la portée du compte, pas l'exception de résolution. */
export function noterUsage(portee: PorteeUtilisateur, id: string, maintenant: string, agent: string | null): void {
  portee.modifier('calendar_feed_tokens', id, { last_used_at: maintenant, last_user_agent: agent });
}

// --- Résolution d'un jeton présenté ----------------------------------------------------------------------------------

const ligneJeton = z.object({
  id: z.string(),
  user_id: z.string(),
  group_id: z.string().nullable(),
  include_personal: z.union([z.literal(0), z.literal(1)]),
  include_declined: z.union([z.literal(0), z.literal(1)]),
  revoked_at: z.string().nullable(),
});

export type JetonResolu = z.infer<typeof ligneJeton>;

/**
 * Le jeton dont l'empreinte (SHA-256) est donnée, révoqué ou non, ou `undefined`. La preuve d'accès est le secret lui-même :
 * c'est la seule lecture de `calendar_feed_tokens` sans compte connu. Elle ne rend que les colonnes du jeton, sans jointure.
 */
export function jetonParEmpreinte(base: Base, empreinte: string): JetonResolu | undefined {
  const ligne = preparer(base, 'SELECT id, user_id, group_id, include_personal, include_declined, revoked_at FROM calendar_feed_tokens WHERE token_hash = ?').get(empreinte);
  return ligne === undefined ? undefined : ligneJeton.parse(ligne);
}

// --- Lecture des événements d'un groupe ------------------------------------------------------------------------------

const LIMITE_PAR_GROUPE = 1000;
/** Statut qu'aucune présence ne porte : la jointure ne rapproche alors rien, et rien n'est masqué. */
const AUCUN_REFUS = 'aucun';
const STATUTS_SERVIS = ['published', 'cancelled'] as const;

export interface FenetreFlux {
  /** Début de la fenêtre (instant UTC) : les événements COMMENÇANT après lui, et tous ceux MODIFIÉS depuis. */
  readonly depuis: string;
  /** Fin de la fenêtre (instant UTC). */
  readonly jusqua: string;
  /** Masquer les événements auxquels J'AI répondu « non » (« pas de réponse » reste inclus). */
  readonly exclureRefus: boolean;
}

// Deux ensembles DISJOINTS, sans `OR` (la garde le refuse) : modifiés depuis le début de la fenêtre (où qu'ils tombent), et NON
// modifiés mais qui commencent dans la fenêtre. Leur réunion est « fenêtre + tout ce qui a bougé » ; un événement déplacé hors
// fenêtre y reste donc, et peut disparaître du téléphone.
// La jointure sur l'auteur (membre puis compte) est dans le corps COMMUN : l'empreinte et la génération lisent exactement les mêmes
// lignes, et le nom de l'organisateur (affiché dans `ORGANIZER;CN=`) entre dans l'empreinte au même titre que l'événement.
const CORPS_ENSEMBLE = `FROM events AS e
     JOIN memberships AS m ON m.id = e.created_by_membership_id AND m.group_id = e.group_id
     JOIN users AS u ON u.id = m.user_id
     LEFT JOIN event_attendances AS a ON a.event_id = e.id AND a.group_id = e.group_id AND a.membership_id = ? AND a.status = ?
     WHERE e.group_id = ? AND e.deleted_at IS NULL AND e.status IN (?, ?) AND a.status IS NULL`;
const ENSEMBLE_MODIFIES = `${CORPS_ENSEMBLE} AND e.updated_at >= ?`;
const ENSEMBLE_FENETRE = `${CORPS_ENSEMBLE} AND e.updated_at < ? AND e.starts_at >= ? AND e.starts_at <= ?`;

function parametres(scope: GroupScope, fenetre: FenetreFlux): { modifies: Array<string | number>; fenetre: Array<string | number> } {
  const communs = [scope.membershipId, fenetre.exclureRefus ? 'no' : AUCUN_REFUS, scope.groupId, ...STATUTS_SERVIS];
  return {
    modifies: [...communs, fenetre.depuis],
    // `starts_at` est une date (journée entière) ou un instant : on compare à la date seule en bas, à la fin de journée en haut.
    fenetre: [...communs, fenetre.depuis, fenetre.depuis.slice(0, 10), `${fenetre.jusqua.slice(0, 10)}T23:59:59Z`],
  };
}

const ligneEmpreinte = z.object({ lignes: z.string().nullable() });

/**
 * Empreinte EXACTE de ce que le flux servirait pour CE groupe, sans lire une ligne d'événement ni rien générer : un agrégat par
 * ensemble, qui concatène `(id, updated_at, nom de l'organisateur)` de chaque événement servi. Un couple `(max(updated_at), nombre)` ne
 * suffisait pas : répondre « non » à A et « oui » à B ne touche aucun `events.updated_at`, donne le même nombre et le même maximum, et
 * le téléphone aurait gardé A. Ici l'ENSEMBLE des événements servis est dans l'empreinte, donc tout échange la change. C'est le coût
 * d'un `304`. Les lignes sont triées côté serveur (l'ordre de `group_concat` n'est pas garanti). Mêmes filtres que `evenementsFlux`.
 */
export function empreinteFlux(scope: GroupScope, fenetre: FenetreFlux): string {
  const base = baseDeScope(scope);
  const p = parametres(scope, fenetre);
  const lire = (corps: string, valeurs: Array<string | number>): string[] => {
    const { lignes } = ligneEmpreinte.parse(
      preparer(base, `SELECT group_concat(e.id || '|' || e.updated_at || '|' || u.display_name, char(10)) AS lignes ${corps}`).get(...valeurs),
    );
    return lignes === null ? [] : lignes.split('\n');
  };
  return [...lire(ENSEMBLE_MODIFIES, p.modifies), ...lire(ENSEMBLE_FENETRE, p.fenetre)].sort().join('\n');
}

const ligneEvenementFlux = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  location_name: z.string().nullable(),
  location_address: z.string().nullable(),
  arrival_note: z.string().nullable(),
  all_day: z.union([z.literal(0), z.literal(1)]),
  starts_at: z.string(),
  ends_at: z.string().nullable(),
  time_zone: z.string(),
  status: z.enum(['published', 'cancelled']),
  updated_at: z.string(),
  organizer_name: z.string(),
});

export type EvenementFlux = z.infer<typeof ligneEvenementFlux>;

const COLONNES_EVENEMENT = `e.id AS id, e.title AS title, e.description AS description, e.location_name AS location_name,
       e.location_address AS location_address, e.arrival_note AS arrival_note, e.all_day AS all_day, e.starts_at AS starts_at,
       e.ends_at AS ends_at, e.time_zone AS time_zone, e.status AS status, e.updated_at AS updated_at, u.display_name AS organizer_name`;

/** Les événements `published` et `cancelled` de CE groupe pour la fenêtre, du plus proche au plus lointain (annulés compris : ils doivent disparaître du téléphone). */
export function evenementsFlux(scope: GroupScope, fenetre: FenetreFlux): EvenementFlux[] {
  const base = baseDeScope(scope);
  const p = parametres(scope, fenetre);
  const lire = (ensemble: string, valeurs: Array<string | number>): EvenementFlux[] =>
    preparer(base, `SELECT ${COLONNES_EVENEMENT} ${ensemble} ORDER BY e.starts_at, e.id LIMIT ?`)
      .all(...valeurs, LIMITE_PAR_GROUPE)
      .map((ligne) => ligneEvenementFlux.parse(ligne));
  return [...lire(ENSEMBLE_MODIFIES, p.modifies), ...lire(ENSEMBLE_FENETRE, p.fenetre)];
}

// --- Lecture des créneaux personnels du compte (include_personal = 1, lot 8) -----------------------------------------

// Les créneaux importés d'un agenda externe (`calendar_source_id` non nul) sont EXCLUS : ils repartiraient dans le flux sortant et le
// téléphone de l'utilisateur afficherait en double ses propres rendez-vous (boucle de rétroaction, ADR-0013 §5). La lecture et l'empreinte
// ETag dérivent de cette même constante.
const CORPS_ENSEMBLE_PERSONNEL = `FROM personal_events AS p WHERE p.user_id = ? AND p.deleted_at IS NULL AND p.calendar_source_id IS NULL`;
const ENSEMBLE_PERSONNEL_MODIFIES = `${CORPS_ENSEMBLE_PERSONNEL} AND p.updated_at >= ?`;
const ENSEMBLE_PERSONNEL_FENETRE = `${CORPS_ENSEMBLE_PERSONNEL} AND p.updated_at < ? AND p.starts_at >= ? AND p.starts_at <= ?`;

function parametresPersonnels(portee: PorteeUtilisateur, fenetre: FenetreFlux): { modifies: Array<string | number>; fenetre: Array<string | number> } {
  return {
    modifies: [portee.userId, fenetre.depuis],
    fenetre: [portee.userId, fenetre.depuis, fenetre.depuis.slice(0, 10), `${fenetre.jusqua.slice(0, 10)}T23:59:59Z`],
  };
}

/** Empreinte exacte des créneaux personnels non supprimés du compte dans la fenêtre du flux. */
export function empreintePersonnelleFlux(portee: PorteeUtilisateur, fenetre: FenetreFlux): string {
  const base = baseDe(portee);
  const p = parametresPersonnels(portee, fenetre);
  const lire = (corps: string, valeurs: Array<string | number>): string[] => {
    const { lignes } = ligneEmpreinte.parse(
      preparer(base, `SELECT group_concat(p.id || '|' || p.updated_at || '|' || p.title, char(10)) AS lignes ${corps}`).get(...valeurs),
    );
    return lignes === null ? [] : lignes.split('\n');
  };
  return [...lire(ENSEMBLE_PERSONNEL_MODIFIES, p.modifies), ...lire(ENSEMBLE_PERSONNEL_FENETRE, p.fenetre)].sort().join('\n');
}

const ligneEvenementPersonnelFlux = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  location_name: z.string().nullable(),
  all_day: z.union([z.literal(0), z.literal(1)]),
  starts_at: z.string(),
  ends_at: z.string().nullable(),
  time_zone: z.string(),
  updated_at: z.string(),
});

export type EvenementPersonnelFlux = z.infer<typeof ligneEvenementPersonnelFlux>;

const COLONNES_EVENEMENT_PERSONNEL = `p.id AS id, p.title AS title, p.description AS description, p.location_name AS location_name,
       p.all_day AS all_day, p.starts_at AS starts_at, p.ends_at AS ends_at, p.time_zone AS time_zone, p.updated_at AS updated_at`;

/** Les créneaux personnels non supprimés de CE compte pour la fenêtre du flux. */
export function evenementsPersonnelsFlux(portee: PorteeUtilisateur, fenetre: FenetreFlux): EvenementPersonnelFlux[] {
  const base = baseDe(portee);
  const p = parametresPersonnels(portee, fenetre);
  const lire = (ensemble: string, valeurs: Array<string | number>): EvenementPersonnelFlux[] =>
    preparer(base, `SELECT ${COLONNES_EVENEMENT_PERSONNEL} ${ensemble} ORDER BY p.starts_at, p.id LIMIT ?`)
      .all(...valeurs, LIMITE_PAR_GROUPE)
      .map((ligne) => ligneEvenementPersonnelFlux.parse(ligne));
  return [...lire(ENSEMBLE_PERSONNEL_MODIFIES, p.modifies), ...lire(ENSEMBLE_PERSONNEL_FENETRE, p.fenetre)];
}
