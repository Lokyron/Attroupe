import { z } from 'zod';
import type { Base } from '../base.js';
import { baseDeScope, type Condition, type GroupScope } from '../scope.js';
import { preparer } from '../sql.js';

// Dépenses partagées, parts, remboursements et clôture d'événement (lot 9, modèle §3.10 et ADR-0004).
// Toutes les opérations métier prennent un `GroupScope` ; seules les devises (`currencies`, table de référence
// sans `group_id`) prennent `Base`.

const ligneDevise = z.object({
  code: z.string(),
  exponent: z.number().int(),
  symbol: z.string(),
  name_key: z.string(),
});

export type Devise = z.infer<typeof ligneDevise>;

/** Liste les devises activées, triées par code ISO 4217 croissant. */
export function listerDevises(base: Base): Devise[] {
  return preparer(base, 'SELECT code, exponent, symbol, name_key FROM currencies WHERE is_enabled = 1 ORDER BY code')
    .all()
    .map((ligne) => ligneDevise.parse(ligne));
}

/** Lit une devise activée par son code ISO 4217, ou `undefined` si absente / désactivée. */
export function lireDevise(base: Base, code: string): Devise | undefined {
  const ligne = preparer(base, 'SELECT code, exponent, symbol, name_key FROM currencies WHERE code = ? AND is_enabled = 1').get(code);
  return ligne === undefined ? undefined : ligneDevise.parse(ligne);
}

/** Variante scopée pour le service (évite d'exposer `baseDeScope` hors `db/`). */
export function lireDeviseScope(scope: GroupScope, code: string): Devise | undefined {
  return lireDevise(baseDeScope(scope), code);
}

const ligneDepense = z.object({
  id: z.string(),
  event_id: z.string().nullable(),
  label: z.string(),
  spent_on: z.string(),
  payer_membership_id: z.string(),
  amount_minor: z.number().int(),
  currency_code: z.string(),
  target_currency_code: z.string(),
  rate_ppm: z.number().int(),
  rate_source: z.enum(['identity', 'manual', 'provider']),
  rate_fetched_at: z.string().nullable(),
  amount_target_minor: z.number().int(),
  split_mode: z.enum(['equal', 'weights', 'exact']),
  note: z.string().nullable(),
  receipt_path: z.string().nullable(),
  created_by_membership_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Depense = z.infer<typeof ligneDepense>;

const lignePartDepense = z.object({
  expense_id: z.string(),
  membership_id: z.string(),
  weight: z.number().int(),
  share_minor: z.number().int(),
  share_target_minor: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type PartDepense = z.infer<typeof lignePartDepense>;

export interface DepenseAvecParts extends Depense {
  readonly shares: readonly PartDepense[];
}

export interface FiltresDepenses {
  readonly event_id?: string | undefined;
  readonly payer_membership_id?: string | undefined;
  readonly du?: string | undefined;
  readonly au?: string | undefined;
}

export interface ChampsDepense {
  readonly event_id: string | null;
  readonly label: string;
  readonly spent_on: string;
  readonly payer_membership_id: string;
  readonly amount_minor: number;
  readonly currency_code: string;
  readonly target_currency_code: string;
  readonly rate_ppm: number;
  readonly rate_source: 'identity' | 'manual' | 'provider';
  readonly rate_fetched_at: string | null;
  readonly amount_target_minor: number;
  readonly split_mode: 'equal' | 'weights' | 'exact';
  readonly note: string | null;
}

export type ModificationDepense = { readonly [K in keyof ChampsDepense]?: ChampsDepense[K] | undefined };

export interface NouvellePartDepense {
  readonly membership_id: string;
  readonly weight: number;
  readonly share_minor: number;
  readonly share_target_minor: number;
}

const ORDRE_DEPENSES = [
  { colonne: 'spent_on', sens: 'DESC' as const },
  { colonne: 'created_at', sens: 'DESC' as const },
  { colonne: 'id', sens: 'DESC' as const },
];

/** Liste les dépenses non supprimées du groupe, avec leurs parts associées. */
export function listerDepenses(scope: GroupScope, filtres?: FiltresDepenses): DepenseAvecParts[] {
  const conditions: Condition[] = [];
  if (filtres?.event_id !== undefined) conditions.push({ colonne: 'event_id', operateur: '=', valeur: filtres.event_id });
  if (filtres?.payer_membership_id !== undefined) conditions.push({ colonne: 'payer_membership_id', operateur: '=', valeur: filtres.payer_membership_id });
  if (filtres?.du !== undefined) conditions.push({ colonne: 'spent_on', operateur: '>=', valeur: filtres.du });
  if (filtres?.au !== undefined) conditions.push({ colonne: 'spent_on', operateur: '<=', valeur: filtres.au });

  const depenses = scope.tous<unknown>('expenses', conditions, { ordre: ORDRE_DEPENSES }).map((l) => ligneDepense.parse(l));
  if (depenses.length === 0) return [];

  const ids = depenses.map((d) => d.id);
  const toutesParts = scope
    .tous<unknown>('expense_shares', [{ colonne: 'expense_id', operateur: 'IN', valeur: ids }], { ordre: [{ colonne: 'membership_id' }] })
    .map((l) => lignePartDepense.parse(l));

  const parDepense = new Map<string, PartDepense[]>();
  for (const part of toutesParts) {
    const liste = parDepense.get(part.expense_id) ?? [];
    liste.push(part);
    parDepense.set(part.expense_id, liste);
  }

  return depenses.map((d) => ({ ...d, shares: parDepense.get(d.id) ?? [] }));
}

/** Lit une dépense de CE groupe avec ses parts, ou `undefined` si absente / d'un autre groupe. */
export function lireDepense(scope: GroupScope, depenseId: string): DepenseAvecParts | undefined {
  const ligne = scope.un<unknown>('expenses', depenseId);
  if (ligne === undefined) return undefined;
  const depense = ligneDepense.parse(ligne);
  const shares = scope
    .tous<unknown>('expense_shares', [{ colonne: 'expense_id', operateur: '=', valeur: depenseId }], { ordre: [{ colonne: 'membership_id' }] })
    .map((l) => lignePartDepense.parse(l));
  return { ...depense, shares };
}

/** Crée une dépense et ses parts dans la même transaction. */
export function creerDepense(scope: GroupScope, champs: ChampsDepense, parts: readonly NouvellePartDepense[]): string {
  return scope.transaction(() => {
    const id = scope.inserer('expenses', { ...champs });
    for (const part of parts) {
      scope.inserer('expense_shares', { expense_id: id, ...part });
    }
    return id;
  });
}

/** Met à jour une dépense et remplace ses parts si `parts` est fourni, dans la même transaction. */
export function modifierDepense(
  scope: GroupScope,
  depenseId: string,
  champs: ModificationDepense,
  parts?: readonly NouvellePartDepense[],
): boolean {
  return scope.transaction(() => {
    const valeurs: Record<string, string | number | null> = {};
    for (const [cle, valeur] of Object.entries(champs)) {
      if (valeur !== undefined) valeurs[cle] = valeur;
    }
    const ok = scope.modifier('expenses', depenseId, valeurs);
    if (!ok) return false;
    if (parts !== undefined) {
      preparer(baseDeScope(scope), 'DELETE FROM expense_shares WHERE expense_id = ? AND group_id = ?').run(depenseId, scope.groupId);
      for (const part of parts) {
        scope.inserer('expense_shares', { expense_id: depenseId, ...part });
      }
    }
    return true;
  });
}

/** Suppression douce d'une dépense de CE groupe. */
export function supprimerDepense(scope: GroupScope, depenseId: string): boolean {
  return scope.supprimerDoux('expenses', depenseId);
}

// --- Remboursements (`settlements`) -----------------------------------------------------------------------

const ligneRemboursement = z.object({
  id: z.string(),
  event_id: z.string().nullable(),
  from_membership_id: z.string(),
  to_membership_id: z.string(),
  amount_minor: z.number().int(),
  currency_code: z.string(),
  target_currency_code: z.string(),
  rate_ppm: z.number().int(),
  amount_target_minor: z.number().int(),
  settled_on: z.string(),
  method_note: z.string().nullable(),
  recorded_by_membership_id: z.string(),
  confirmed_by_membership_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Remboursement = z.infer<typeof ligneRemboursement>;

export interface ChampsRemboursement {
  readonly event_id: string | null;
  readonly from_membership_id: string;
  readonly to_membership_id: string;
  readonly amount_minor: number;
  readonly currency_code: string;
  readonly target_currency_code: string;
  readonly rate_ppm: number;
  readonly amount_target_minor: number;
  readonly settled_on: string;
  readonly method_note: string | null;
}

const ORDRE_REMBOURSEMENTS = [
  { colonne: 'settled_on', sens: 'DESC' as const },
  { colonne: 'created_at', sens: 'DESC' as const },
  { colonne: 'id', sens: 'DESC' as const },
];

export function listerRemboursements(scope: GroupScope, eventId?: string): Remboursement[] {
  const filtres: Condition[] = eventId === undefined ? [] : [{ colonne: 'event_id', operateur: '=', valeur: eventId }];
  return scope.tous<unknown>('settlements', filtres, { ordre: ORDRE_REMBOURSEMENTS }).map((l) => ligneRemboursement.parse(l));
}

export function lireRemboursement(scope: GroupScope, remboursementId: string): Remboursement | undefined {
  const ligne = scope.un<unknown>('settlements', remboursementId);
  return ligne === undefined ? undefined : ligneRemboursement.parse(ligne);
}

export function creerRemboursement(scope: GroupScope, champs: ChampsRemboursement): string {
  return scope.inserer('settlements', { ...champs });
}

export function confirmerRemboursement(scope: GroupScope, remboursementId: string): boolean {
  return scope.modifier('settlements', remboursementId, { confirmed_by_membership_id: scope.membershipId });
}

// --- Clôture d'événement (`expense_closures`) -------------------------------------------------------------

const ligneCloture = z.object({
  id: z.string(),
  event_id: z.string(),
  currency_code: z.string(),
  snapshot_json: z.string(),
  total_minor: z.number().int(),
  closed_by_membership_id: z.string(),
  closed_at: z.string(),
  reopened_at: z.string().nullable(),
  reopened_by_membership_id: z.string().nullable(),
});

export type ClotureDepenses = z.infer<typeof ligneCloture>;

/** Clôture active (`reopened_at IS NULL`) pour cet événement, ou `undefined`. */
export function lireCloture(scope: GroupScope, eventId: string): ClotureDepenses | undefined {
  const lignes = scope.tous<unknown>('expense_closures', [
    { colonne: 'event_id', operateur: '=', valeur: eventId },
    { colonne: 'reopened_at', operateur: 'IS NULL' },
  ]);
  return lignes[0] === undefined ? undefined : ligneCloture.parse(lignes[0]);
}

export function creerCloture(
  scope: GroupScope,
  champs: {
    readonly event_id: string;
    readonly currency_code: string;
    readonly snapshot_json: string;
    readonly total_minor: number;
    readonly closed_at: string;
  },
): string {
  return scope.inserer('expense_closures', champs);
}

export function supprimerCloture(scope: GroupScope, eventId: string, maintenant: string): boolean {
  const cloture = lireCloture(scope, eventId);
  if (cloture === undefined) return false;
  return scope.modifier('expense_closures', cloture.id, {
    reopened_at: maintenant,
    reopened_by_membership_id: scope.membershipId,
  });
}

// --- Vérification de membre du groupe ---------------------------------------------------------------------

export function lireStatutMembre(scope: GroupScope, membreId: string): 'active' | 'removed' | 'left' | undefined {
  const ligne = scope.un<{ status: 'active' | 'removed' | 'left' }>('memberships', membreId);
  return ligne?.status;
}
