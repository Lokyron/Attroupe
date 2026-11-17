import { z } from 'zod';
import { memeCreneauOption, type ValeurVote } from '../../domain/sondages.js';
import { baseDeScope, type GroupScope, type Valeurs } from '../scope.js';
import { preparer } from '../sql.js';

// Sondages de dates, créneaux proposés et votes (lot 7). Toutes les requêtes passent par un `GroupScope` : le groupe
// est celui du scope, jamais un paramètre. La conversion d'un sondage en événement s'exécute en une seule transaction :
// insertion de l'événement (`events.source_date_poll_id`), création de son fil (`threads.kind = 'event'`) et mise à jour
// du sondage (`date_polls.status = 'converted'`, `date_polls.resulting_event_id`).

const ligneSondage = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(['open', 'closed', 'converted', 'cancelled']),
  closes_at: z.string().nullable(),
  resulting_event_id: z.string().nullable(),
  created_by_membership_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Sondage = z.infer<typeof ligneSondage>;

const ligneOption = z.object({
  id: z.string(),
  date_poll_id: z.string(),
  all_day: z.union([z.literal(0), z.literal(1)]),
  starts_at: z.string(),
  ends_at: z.string().nullable(),
  position: z.number().int(),
  created_at: z.string(),
});

export type OptionSondage = z.infer<typeof ligneOption>;

const ligneVote = z.object({
  date_poll_option_id: z.string(),
  membership_id: z.string(),
  display_name: z.string(),
  value: z.enum(['yes', 'maybe', 'no']),
});

export type VoteSondage = z.infer<typeof ligneVote>;

const ORDRE_SONDAGES = [
  { colonne: 'created_at', sens: 'DESC' as const },
  { colonne: 'id', sens: 'DESC' as const },
] as const;

const ORDRE_OPTIONS = [{ colonne: 'position' }, { colonne: 'id' }] as const;

/** Un sondage de CE groupe, ou `undefined` (404 `sondage.introuvable` : le sondage d'un autre groupe est introuvable). */
export function lireSondage(scope: GroupScope, sondageId: string): Sondage | undefined {
  const ligne = scope.un<unknown>('date_polls', sondageId);
  return ligne === undefined ? undefined : ligneSondage.parse(ligne);
}

/** Les sondages du groupe, du plus récent au plus ancien. */
export function listerSondages(scope: GroupScope): Sondage[] {
  return scope.tous<unknown>('date_polls', [], { ordre: ORDRE_SONDAGES }).map((ligne) => ligneSondage.parse(ligne));
}

/** Toutes les options du groupe, pour calculer le nombre d'options par sondage en une requête. */
export function toutesLesOptions(scope: GroupScope): OptionSondage[] {
  return scope.tous<unknown>('date_poll_options', [], { ordre: ORDRE_OPTIONS }).map((ligne) => ligneOption.parse(ligne));
}

/** Les options d'un sondage, dans l'ordre (`position`, puis `id`). */
export function optionsDe(scope: GroupScope, sondageId: string): OptionSondage[] {
  return scope
    .tous<unknown>('date_poll_options', [{ colonne: 'date_poll_id', operateur: '=', valeur: sondageId }], { ordre: ORDRE_OPTIONS })
    .map((ligne) => ligneOption.parse(ligne));
}

/** Une option appartenant à CE sondage dans CE groupe, ou `undefined` (404 `option.introuvable`). */
export function lireOption(scope: GroupScope, sondageId: string, optionId: string): OptionSondage | undefined {
  const ligne = scope.un<unknown>('date_poll_options', optionId);
  if (ligne === undefined) return undefined;
  const option = ligneOption.parse(ligne);
  return option.date_poll_id === sondageId ? option : undefined;
}

/** Les votes des membres actifs sur toutes les options d'un sondage. */
export function votesDeSondage(scope: GroupScope, sondageId: string): VoteSondage[] {
  const base = baseDeScope(scope);
  return preparer(
    base,
    `SELECT v.date_poll_option_id AS date_poll_option_id, v.membership_id AS membership_id,
       u.display_name AS display_name, v.value AS value
     FROM date_poll_votes AS v
     JOIN date_poll_options AS o ON o.id = v.date_poll_option_id AND o.group_id = v.group_id
     JOIN memberships AS m ON m.id = v.membership_id AND m.group_id = v.group_id
     JOIN users AS u ON u.id = m.user_id
     WHERE v.group_id = ? AND o.date_poll_id = ? AND m.status = 'active'
     ORDER BY v.created_at, v.membership_id`,
  )
    .all(scope.groupId, sondageId)
    .map((ligne) => ligneVote.parse(ligne));
}

export interface NouvelleOption {
  readonly all_day: boolean;
  readonly starts_at: string;
  readonly ends_at: string | null;
}

/** Crée le sondage et ses options initiales dans la même transaction. */
export function creerSondage(
  scope: GroupScope,
  champs: {
    readonly title: string;
    readonly description: string | null;
    readonly closes_at: string | null;
    readonly options: readonly NouvelleOption[];
  },
): string {
  return scope.transaction(() => {
    const sondageId = scope.inserer('date_polls', {
      title: champs.title,
      description: champs.description,
      closes_at: champs.closes_at,
      status: 'open',
    });
    champs.options.forEach((option, i) => {
      scope.inserer('date_poll_options', {
        date_poll_id: sondageId,
        all_day: option.all_day ? 1 : 0,
        starts_at: option.starts_at,
        ends_at: option.ends_at,
        position: i + 1,
      });
    });
    return sondageId;
  });
}

export interface ModificationSondage {
  readonly title?: string | undefined;
  readonly description?: string | null | undefined;
  readonly closes_at?: string | null | undefined;
  readonly status?: 'open' | 'closed' | undefined;
}

/** Met à jour les champs fournis du sondage ; `false` s'il n'est plus dans ce groupe. */
export function modifierSondage(scope: GroupScope, sondageId: string, champs: ModificationSondage): boolean {
  const fournies = Object.entries(champs).filter((entree): entree is [string, string | null] => entree[1] !== undefined);
  const valeurs: Valeurs = Object.fromEntries(fournies);
  return scope.modifier('date_polls', sondageId, valeurs);
}

/** Annule le sondage (`status = 'cancelled'`). */
export function annulerSondage(scope: GroupScope, sondageId: string): boolean {
  return scope.modifier('date_polls', sondageId, { status: 'cancelled' });
}

/** Ajoute une option en fin de liste (`max(position) + 1`), dans une transaction. Renvoie `null` en cas de doublon concurrent. */
export function ajouterOption(scope: GroupScope, sondageId: string, option: NouvelleOption): string | null {
  return scope.transaction(() => {
    const existantes = optionsDe(scope, sondageId);
    const doublon = existantes.some(
      (o) =>
        memeCreneauOption({ all_day: o.all_day === 1, starts_at: o.starts_at, ends_at: o.ends_at }, option) ||
        (o.starts_at === option.starts_at && o.ends_at === option.ends_at),
    );
    if (doublon) return null;
    const derniere = existantes.at(-1);
    const position = derniere === undefined ? 1 : derniere.position + 1;
    return scope.inserer('date_poll_options', {
      date_poll_id: sondageId,
      all_day: option.all_day ? 1 : 0,
      starts_at: option.starts_at,
      ends_at: option.ends_at,
      position,
    });
  });
}

/**
 * Retire une option du sondage et ses éventuels votes, dans la même transaction.
 * `false` si l'option n'appartient pas à ce sondage dans ce groupe.
 */
export function supprimerOption(scope: GroupScope, sondageId: string, optionId: string): boolean {
  const base = baseDeScope(scope);
  return scope.transaction(() => {
    const option = lireOption(scope, sondageId, optionId);
    if (option === undefined) return false;
    preparer(base, 'DELETE FROM date_poll_votes WHERE date_poll_option_id = ? AND group_id = ?').run(optionId, scope.groupId);
    return (
      preparer(base, 'DELETE FROM date_poll_options WHERE id = ? AND date_poll_id = ? AND group_id = ?').run(
        optionId,
        sondageId,
        scope.groupId,
      ).changes > 0
    );
  });
}

/** Enregistre ou met à jour le vote de l'appelant (`scope.membershipId`) sur cette option. */
export function voterOption(scope: GroupScope, optionId: string, value: ValeurVote): void {
  scope.upsert('date_poll_votes', { date_poll_option_id: optionId, value });
}

/**
 * Convertit le sondage en événement publié dans une seule transaction :
 *  1. insertion de l'événement dans `events` avec `source_date_poll_id = sondage.id` ;
 *  2. insertion du fil de discussion de l'événement dans `threads` (`kind = 'event'`) ;
 *  3. mise à jour du sondage dans `date_polls` (`status = 'converted'`, `resulting_event_id = evenementId`).
 */
export function convertirSondage(
  scope: GroupScope,
  sondage: Sondage,
  option: OptionSondage,
  champs: {
    readonly time_zone?: string | undefined;
    readonly location_name?: string | null | undefined;
    readonly description?: string | null | undefined;
  },
): { etat: 'converti'; evenementId: string } | { etat: 'deja_converti' | 'annule' | 'introuvable' } {
  return scope.transaction(() => {
    const actuel = lireSondage(scope, sondage.id);
    if (actuel === undefined) return { etat: 'introuvable' };
    if (actuel.status === 'converted') return { etat: 'deja_converti' };
    if (actuel.status === 'cancelled') return { etat: 'annule' };
    const groupe = scope.groupe<{ time_zone: string }>();
    const fuseau = champs.time_zone ?? groupe?.time_zone ?? 'Europe/Paris';
    const evenementId = scope.inserer('events', {
      title: actuel.title,
      description: champs.description !== undefined ? champs.description : actuel.description,
      location_name: champs.location_name ?? null,
      all_day: option.all_day,
      starts_at: option.starts_at,
      ends_at: option.ends_at,
      time_zone: fuseau,
      status: 'published',
      source_date_poll_id: actuel.id,
    });
    scope.inserer('threads', { event_id: evenementId, kind: 'event', title: null });
    scope.modifier(
      'date_polls',
      actuel.id,
      { status: 'converted', resulting_event_id: evenementId },
      [{ colonne: 'status', operateur: 'IN', valeur: ['open', 'closed'] }],
    );
    return { etat: 'converti', evenementId };
  });
}
