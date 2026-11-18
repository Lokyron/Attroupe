import type { Base } from './base.js';
import { ErreurScope, creerMoteur, type Condition, type DescriptionTable, type OptionsLecture, type SansPromesse, type Valeurs } from './moteur.js';
import { preparer } from './sql.js';

// Pendant du GroupScope pour les tables qui appartiennent à un COMPTE et non à un groupe : sans
// lui, rien n'empêcherait de lire la notification, le jeton de flux iCal ou le créneau d'agenda
// personnel d'un autre compte par son identifiant. Même moteur, même contrat : le filtre
// `user_id = ?` est posé par la portée, jamais par l'appelant (modèle de données §3.6, §3.12).

/** Marque non exportée : sans elle, impossible de fabriquer une PorteeUtilisateur hors de ce module. */
const MARQUE: unique symbol = Symbol('PorteeUtilisateur');

const AVEC_ID = { avecId: true, auteur: null, auteurFacultatif: null, cle: ['id'], pkContientPortee: false, reserveAuMembre: null } as const;

/**
 * Tables d'un compte. Hors périmètre : `email_outbox` (aucune colonne de compte : file interne, sans
 * accès par une portée), `sessions`, `password_reset_tokens`, `user_identities` (authentification, lot 2).
 */
const TABLES = {
  // Révocation par `revoked_at` (modèle §4.4) : pas de suppression.
  calendar_feed_tokens: { ...AVEC_ID, supprimable: false, suppressionReelle: false, creeLe: true, majLe: false },
  // Sources d'agenda externe : l'URL chiffrée est un secret porteur ; supprimer une source emporte ses créneaux importés (cascade).
  calendar_sources: { ...AVEC_ID, supprimable: false, suppressionReelle: true, creeLe: true, majLe: true },
  // Purge périodique des lues (modèle §4.4).
  notifications: { ...AVEC_ID, supprimable: false, suppressionReelle: true, creeLe: true, majLe: false },
  // Clé (user_id, group_id) : `group_id` est un identifiant de groupe ou '*' (réglage global).
  notification_preferences: { avecId: false, supprimable: false, suppressionReelle: true, creeLe: true, majLe: true, auteur: null, auteurFacultatif: null, cle: ['group_id'], pkContientPortee: true, reserveAuMembre: null },
  // L'agenda personnel : propriétaire seul (§3.6). Le groupe n'y accède que par les partages.
  personal_events: { ...AVEC_ID, supprimable: true, suppressionReelle: false, creeLe: true, majLe: true },
  // Abonnements Web Push (lot 12) : propres à un compte.
  push_subscriptions: { ...AVEC_ID, supprimable: false, suppressionReelle: true, creeLe: true, majLe: false },
} as const satisfies Record<string, DescriptionTable>;

export type TableCompte = keyof typeof TABLES;
type TableAvecId = { [K in TableCompte]: (typeof TABLES)[K]['avecId'] extends true ? K : never }[TableCompte];
type TableSupprimable = { [K in TableCompte]: (typeof TABLES)[K]['supprimable'] extends true ? K : never }[TableCompte];
type TableSuppressionReelle = { [K in TableCompte]: (typeof TABLES)[K]['suppressionReelle'] extends true ? K : never }[TableCompte];

/** Description des tables, exposée en lecture seule pour le test de cohérence avec le schéma. */
export const DESCRIPTION_TABLES_COMPTE: Readonly<Record<TableCompte, DescriptionTable>> = TABLES;

export interface PorteeUtilisateur {
  readonly [MARQUE]: true;
  readonly userId: string;
  /** Lignes du compte (`user_id = ?`, `deleted_at IS NULL`) filtrées par des conditions liées, combinées par ET. */
  readonly tous: <T>(table: TableCompte, filtres?: readonly Condition[], options?: OptionsLecture) => T[];
  /** Une ligne par `id`, ou `undefined` si elle n'appartient pas à CE compte (404, jamais 403). */
  readonly un: <T>(table: TableAvecId, id: string) => T | undefined;
  /** Insère en posant `user_id`, l'`id` (UUID v7) et les horodatages UTC. Renvoie l'`id`. */
  readonly inserer: <K extends TableCompte>(table: K, valeurs: Valeurs) => K extends TableAvecId ? string : undefined;
  readonly modifier: (table: TableAvecId, id: string, valeurs: Valeurs) => boolean;
  readonly modifierPar: (table: TableCompte, cle: Valeurs, valeurs: Valeurs) => boolean;
  readonly supprimerDoux: (table: TableSupprimable, id: string) => boolean;
  readonly supprimer: (table: TableSuppressionReelle, cle: Valeurs) => boolean;
  readonly transaction: <T>(fn: () => T & SansPromesse<T>) => T;
}

/** Portée → base, pour les lectures transverses (`db/queries/transverse.ts`) : la base ne se déduit que d'une portée fabriquée ici. */
const BASES = new WeakMap<object, Base>();

/** La base d'une portée fabriquée par `creerPorteeUtilisateur` ; réservé à db/ (ESLint). Une portée forgée est refusée. */
export function baseDe(portee: PorteeUtilisateur): Base {
  const base = BASES.get(portee);
  if (base === undefined) throw new ErreurCompte();
  return base;
}

/** Compte inconnu, désactivé ou anonymisé : aucune portée possible (l'authentification répond 401). */
export class ErreurCompte extends ErreurScope {
  constructor() {
    super('Compte introuvable, désactivé ou anonymisé : aucune portée utilisateur possible.');
    this.name = 'ErreurCompte';
  }
}

/**
 * Fabrique la portée d'un compte ACTIF, relu en base. Seul l'intergiciel (lots 2 et 3) l'appelle,
 * avec l'utilisateur de la session.
 * @throws ErreurCompte si le compte n'existe pas ou n'est plus actif.
 */
export function creerPorteeUtilisateur(base: Base, userId: string): PorteeUtilisateur {
  if (typeof userId !== 'string') throw new ErreurCompte();
  const compte = preparer(base, 'SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL AND anonymized_at IS NULL').get(userId);
  if (compte === undefined) throw new ErreurCompte();

  /** Appartenance ACTIVE du compte dans ce groupe (relue en base). */
  const membreActif = (groupId: unknown): boolean =>
    typeof groupId === 'string' &&
    preparer(base, "SELECT 1 FROM memberships WHERE user_id = ? AND group_id = ? AND status = 'active'").get(userId, groupId) !== undefined;

  const moteur = creerMoteur({
    base,
    colonnePortee: 'user_id',
    valeurPortee: userId,
    descriptions: TABLES,
    membreId: null,
    // Un jeton de flux (secret d'accès) ou une préférence ne vise qu'un groupe dont le compte est membre ACTIF :
    // la clé étrangère seule laisserait créer un jeton pour n'importe quel groupe. Le lot 5 revérifie en plus
    // l'appartenance à chaque service du flux (un départ ultérieur invalide le jeton).
    avantInsertion: (table, valeurs) => {
      const groupId = valeurs['group_id'] ?? null;
      if (table === 'calendar_feed_tokens' && groupId !== null && !membreActif(groupId)) {
        throw new ErreurScope("Jeton refusé : vous n'êtes pas membre actif de ce groupe.");
      }
      if (table === 'notification_preferences' && groupId !== '*' && !membreActif(groupId)) {
        throw new ErreurScope("Préférence refusée : réglage global ('*') ou groupe dont vous êtes membre actif.");
      }
    },
    // Le groupe d'un jeton est posé à la création : le changer après coup contournerait le contrôle d'appartenance.
    avantModification: (table, valeurs) => {
      if (table === 'calendar_feed_tokens' && Object.hasOwn(valeurs, 'group_id')) {
        throw new ErreurScope("Le groupe d'un jeton de flux ne se modifie pas : révoquez-le et créez-en un autre.");
      }
    },
  });
  const portee: PorteeUtilisateur = Object.freeze({
    [MARQUE]: true as const,
    userId,
    tous: moteur.tous,
    un: moteur.un,
    inserer: moteur.inserer as PorteeUtilisateur['inserer'],
    modifier: (table: TableAvecId, id: string, valeurs: Valeurs) => moteur.modifierPar(table, { id }, valeurs),
    modifierPar: moteur.modifierPar,
    supprimerDoux: moteur.supprimerDoux,
    supprimer: moteur.supprimer,
    transaction: moteur.transaction,
  });
  BASES.set(portee, base);
  return portee;
}
