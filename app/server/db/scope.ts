import { z } from 'zod';
import type { Base } from './base.js';
import {
  creerMoteur,
  ErreurScope,
  type Condition,
  type DescriptionTable,
  type OptionsLecture,
  type SansPromesse,
  type ValeurSql,
  type Valeurs,
} from './moteur.js';
import { preparer } from './sql.js';

// Verrou n° 2 (architecture §4) : le GroupScope, le contexte de groupe obligatoire.
// Toute requête métier passe par un `GroupScope`, que seul l'intergiciel d'appartenance
// (lot 3) sait fabriquer, via `creerScope` — et `creerScope` LIT l'appartenance en base : aucun
// appelant ne peut l'affirmer. Les méthodes injectent elles-mêmes `group_id = ?` et
// `deleted_at IS NULL` (modèle de données §4.4) : le même oubli, deux fois grave. Aucune fonction ne
// prend de `groupId: string` ; l'auteur d'une écriture vient du scope ; l'identifiant (UUID v7)
// est généré dans db/.

export { ErreurScope } from './moteur.js';
export type { Condition, Ordre, OperateurSimple, OptionsLecture, SansPromesse, ValeurSql, Valeurs } from './moteur.js';

/** Marque non exportée : sans elle, impossible de fabriquer un GroupScope hors de ce module. */
const MARQUE: unique symbol = Symbol('GroupScope');

const SANS_ID = { avecId: false, supprimable: false, suppressionReelle: false, auteur: null, auteurFacultatif: null, pkContientPortee: false, reserveAuMembre: null } as const;
const AVEC_ID = { avecId: true, suppressionReelle: false, auteurFacultatif: null, cle: ['id'], pkContientPortee: false, reserveAuMembre: null } as const;

/**
 * Tables métier accessibles par le scope : celles dont `group_id` est NOT NULL, plus
 * `personal_event_shares` (modèle §3.6). Un test de schéma compare chaque description aux colonnes
 * réelles de la base (drapeaux, clé primaire, auteur).
 * Hors périmètre : `groups` (sa propre ligne : `groupe()`), les tables d'un compte
 * (`PorteeUtilisateur`) et `email_outbox` (file interne, `group_id` nullable).
 */
const TABLES = {
  album_assets: { ...SANS_ID, suppressionReelle: true, creeLe: true, majLe: true, auteurFacultatif: 'uploaded_by_membership_id', cle: ['album_id', 'immich_asset_id'] },
  albums: { ...AVEC_ID, supprimable: true, creeLe: true, majLe: true, auteur: 'created_by_membership_id' },
  date_poll_options: { ...AVEC_ID, supprimable: false, creeLe: true, majLe: false, auteur: null },
  date_poll_votes: { ...SANS_ID, suppressionReelle: true, creeLe: true, majLe: true, cle: ['date_poll_option_id', 'membership_id'], reserveAuMembre: 'membership_id' },
  date_polls: { ...AVEC_ID, supprimable: true, creeLe: true, majLe: true, auteur: 'created_by_membership_id' },
  event_attendances: { ...SANS_ID, suppressionReelle: true, creeLe: false, majLe: true, cle: ['event_id', 'membership_id'], reserveAuMembre: 'membership_id' },
  event_organizers: { ...SANS_ID, suppressionReelle: true, creeLe: false, majLe: false, cle: ['event_id', 'membership_id'] },
  event_tasks: { ...AVEC_ID, supprimable: true, creeLe: true, majLe: true, auteur: 'created_by_membership_id' },
  events: { ...AVEC_ID, supprimable: true, creeLe: true, majLe: true, auteur: 'created_by_membership_id' },
  expense_closures: { ...AVEC_ID, supprimable: false, creeLe: false, majLe: false, auteur: 'closed_by_membership_id' },
  expense_shares: { ...SANS_ID, suppressionReelle: true, creeLe: true, majLe: true, cle: ['expense_id', 'membership_id'] },
  expenses: { ...AVEC_ID, supprimable: true, creeLe: true, majLe: true, auteur: 'created_by_membership_id' },
  group_immich_configs: { ...SANS_ID, creeLe: true, majLe: true, auteur: 'configured_by_membership_id', cle: [], pkContientPortee: true },
  // `memberships` et `invitations` (colonnes de membre dans leurs lignes) : contrôles de rôle du lot 3, pas du moteur.
  invitations: { ...AVEC_ID, supprimable: false, creeLe: true, majLe: false, auteur: 'invited_by_membership_id' },
  memberships: { ...AVEC_ID, supprimable: false, creeLe: true, majLe: true, auteur: null },
  messages: { ...AVEC_ID, supprimable: true, creeLe: true, majLe: false, auteur: 'author_membership_id' },
  // Un partage appartient au membre qui l'a créé : lui seul le modifie ou le retire.
  personal_event_shares: { ...SANS_ID, suppressionReelle: true, creeLe: true, majLe: false, auteur: 'membership_id', cle: ['personal_event_id'], pkContientPortee: true, reserveAuMembre: 'membership_id' },
  settlements: { ...AVEC_ID, supprimable: true, creeLe: true, majLe: true, auteur: 'recorded_by_membership_id' },
  shopping_items: { ...AVEC_ID, supprimable: true, creeLe: true, majLe: true, auteur: 'created_by_membership_id' },
  shopping_lists: { ...AVEC_ID, supprimable: true, creeLe: true, majLe: true, auteur: 'created_by_membership_id' },
  threads: { ...AVEC_ID, supprimable: true, creeLe: true, majLe: true, auteur: 'created_by_membership_id' },
} as const satisfies Record<string, DescriptionTable>;

type Tables = typeof TABLES;

/** Les seules tables que le scope accepte : une chaîne quelconque ne compile pas. */
export type TableMetier = keyof Tables;
/** Tables adressables par `id`. */
export type TableAvecId = { [K in TableMetier]: Tables[K]['avecId'] extends true ? K : never }[TableMetier];
/** Tables à clé composite ou singleton (sans `id`) : celles de `upsert`. */
export type TableSansId = Exclude<TableMetier, TableAvecId>;
/** Tables à suppression douce (`deleted_at`). */
export type TableSupprimable = { [K in TableMetier]: Tables[K]['supprimable'] extends true ? K : never }[TableMetier];
/** Tables dont les lignes se suppriment réellement (associations, modèle §4.4). */
export type TableSuppressionReelle = { [K in TableMetier]: Tables[K]['suppressionReelle'] extends true ? K : never }[TableMetier];

/** Description des tables, exposée en lecture seule pour le test de cohérence avec le schéma. */
export const DESCRIPTION_TABLES: Readonly<Record<TableMetier, DescriptionTable>> = TABLES;

/** Créneau d'agenda personnel partagé, vu du groupe : un intervalle, JAMAIS un titre ni un lieu. */
export interface CreneauOccupe {
  readonly membership_id: string;
  readonly all_day: 0 | 1;
  readonly starts_at: string;
  readonly ends_at: string | null;
  readonly time_zone: string;
}

export interface GroupScope {
  readonly [MARQUE]: true;
  readonly groupId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly role: 'admin' | 'member';
  /** La ligne de SON groupe (jamais celle d'un autre), ou `undefined` si le groupe est supprimé. */
  readonly groupe: <T>() => T | undefined;
  /** Lignes du groupe (`group_id = ?`, `deleted_at IS NULL`) filtrées par des conditions liées, combinées par ET. */
  readonly tous: <T>(table: TableMetier, filtres?: readonly Condition[], options?: OptionsLecture) => T[];
  /** Une ligne par `id`, ou `undefined` si elle n'existe pas dans CE groupe (404, jamais 403). */
  readonly un: <T>(table: TableAvecId, id: string) => T | undefined;
  /** Insère en posant `group_id`, l'auteur (membre du scope), l'`id` (UUID v7) et les horodatages UTC. Renvoie l'`id`. */
  readonly inserer: <K extends TableMetier>(table: K, valeurs: Valeurs) => K extends TableAvecId ? string : undefined;
  /** Met à jour une ligne du groupe par `id` ; `false` si aucune ligne n'a été touchée. */
  readonly modifier: (table: TableAvecId, id: string, valeurs: Valeurs) => boolean;
  /** Met à jour une ligne du groupe désignée par sa clé primaire (hors `group_id`). */
  readonly modifierPar: (table: TableMetier, cle: Valeurs, valeurs: Valeurs) => boolean;
  /** Insère, ou met à jour la ligne de MÊME clé si elle est dans le groupe (clé forgée : sans effet, `false`). */
  readonly upsert: (table: TableSansId, valeurs: Valeurs) => boolean;
  /** Pose `deleted_at` ; `false` si la ligne n'existe pas dans ce groupe ou est déjà supprimée. */
  readonly supprimerDoux: (table: TableSupprimable, id: string) => boolean;
  /** Suppression réelle d'une ligne d'association du groupe, désignée par sa clé ; `false` si absente. */
  readonly supprimer: (table: TableSuppressionReelle, cle: Valeurs) => boolean;
  /** Groupe des écritures en une transaction, sans sortir du scope. Le rappel est SYNCHRONE : s'il rend une `Promise`, cela ne compile pas (et lève `ErreurTransactionAsynchrone` à l'exécution). */
  readonly transaction: <T>(fn: () => T & SansPromesse<T>) => T;
  /**
   * Créneaux personnels partagés avec ce groupe par des membres ACTIFS, en projection « occupé » :
   * les colonnes de texte de `personal_events` ne sont pas sélectionnées. Bornes : instants UTC.
   */
  readonly creneauxOccupes: (entre?: { readonly debut: string; readonly fin: string }) => CreneauOccupe[];
}

/** Aucune appartenance active pour ce couple (utilisateur, groupe) : l'intergiciel répond 404, jamais 403. */
export class ErreurAppartenance extends ErreurScope {
  constructor() {
    super('Aucune appartenance active pour ce couple utilisateur / groupe : aucun scope possible.');
    this.name = 'ErreurAppartenance';
  }
}

const ligneAppartenance = z.object({
  id: z.string(),
  group_id: z.string(),
  user_id: z.string(),
  role: z.enum(['admin', 'member']),
});

/**
 * Fabrique le scope de l'appartenance ACTIVE de `userId` dans `groupId`. L'appartenance est lue ICI,
 * en base (`status = 'active'`) : aucun appelant ne peut en affirmer une. Seul l'intergiciel
 * d'appartenance (lot 3) l'appelle, avec l'utilisateur de la session et le `groupId` de l'URL.
 * @throws ErreurAppartenance si l'utilisateur n'est pas membre actif de ce groupe.
 */
export function creerScope(base: Base, userId: string, groupId: string): GroupScope {
  if (typeof userId !== 'string' || typeof groupId !== 'string') throw new ErreurAppartenance();
  const ligne = preparer(
    base,
    "SELECT id, group_id, user_id, role FROM memberships WHERE user_id = ? AND group_id = ? AND status = 'active'",
  ).get(userId, groupId);
  if (ligne === undefined) throw new ErreurAppartenance();
  const appartenance = ligneAppartenance.parse(ligne);

  const membreId = appartenance.id;
  const moteur = creerMoteur({
    base,
    colonnePortee: 'group_id',
    valeurPortee: appartenance.group_id,
    descriptions: TABLES,
    membreId,
    // Un partage ne peut viser que le créneau d'agenda DU membre : la clé étrangère ne le garantit pas.
    avantInsertion: (table, valeurs) => {
      if (table !== 'personal_event_shares') return;
      const proprietaire = preparer(base, 'SELECT 1 FROM personal_events WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(
        valeurs['personal_event_id'] ?? null,
        appartenance.user_id,
      );
      if (proprietaire === undefined) throw new ErreurScope("Partage refusé : ce créneau n'est pas dans votre agenda personnel.");
    },
  });

  const groupe = <T>(): T | undefined =>
    preparer(base, 'SELECT * FROM groups WHERE groups.id = ? AND deleted_at IS NULL').get(appartenance.group_id) as T | undefined;

  const creneauxOccupes = (entre?: { readonly debut: string; readonly fin: string }): CreneauOccupe[] => {
    const params: ValeurSql[] = [appartenance.group_id, 'active'];
    let bornes = '';
    if (entre !== undefined) {
      bornes = ' AND p.starts_at <= ? AND COALESCE(p.ends_at, p.starts_at) >= ?';
      params.push(entre.fin, entre.debut);
    }
    const texte =
      'SELECT s.membership_id AS membership_id, p.all_day AS all_day, p.starts_at AS starts_at, p.ends_at AS ends_at, p.time_zone AS time_zone ' +
      'FROM personal_event_shares AS s ' +
      'JOIN personal_events AS p ON s.personal_event_id = p.id ' +
      'JOIN memberships AS m ON m.id = s.membership_id AND m.group_id = s.group_id ' +
      `WHERE s.group_id = ? AND m.status = ? AND p.deleted_at IS NULL${bornes} ` +
      'ORDER BY p.starts_at, s.membership_id, p.id';
    return preparer(base, texte).all(...params) as CreneauOccupe[];
  };

  return Object.freeze({
    [MARQUE]: true as const,
    groupId: appartenance.group_id,
    membershipId: membreId,
    userId: appartenance.user_id,
    role: appartenance.role,
    groupe,
    tous: moteur.tous,
    un: moteur.un,
    inserer: moteur.inserer as GroupScope['inserer'],
    modifier: (table: TableAvecId, id: string, valeurs: Valeurs) => moteur.modifierPar(table, { id }, valeurs),
    modifierPar: moteur.modifierPar,
    upsert: moteur.upsert,
    supprimerDoux: moteur.supprimerDoux,
    supprimer: moteur.supprimer,
    transaction: moteur.transaction,
    creneauxOccupes,
  });
}
