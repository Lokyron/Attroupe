import { appeler, champ, liste, nombre, texte, texteOuNul } from './client';

// API des dépenses partagées, soldes, remboursements, clôture et devises (lot 9).

export type ModeRepartition = 'equal' | 'weights' | 'exact';

export interface Devise {
  readonly code: string;
  readonly exponent: number;
  readonly symbol: string;
  readonly name_key: string;
}

export interface PartDepense {
  readonly expense_id: string;
  readonly membership_id: string;
  readonly weight: number;
  readonly share_minor: number;
  readonly share_target_minor: number;
}

export interface Depense {
  readonly id: string;
  readonly event_id: string | null;
  readonly label: string;
  readonly spent_on: string;
  readonly payer_membership_id: string;
  readonly amount_minor: number;
  readonly currency_code: string;
  readonly target_currency_code: string;
  readonly rate_ppm: number;
  readonly rate_source: 'identity' | 'manual' | 'provider';
  readonly amount_target_minor: number;
  readonly split_mode: ModeRepartition;
  readonly note: string | null;
  readonly created_by_membership_id: string;
  readonly shares: readonly PartDepense[];
}

export interface Remboursement {
  readonly id: string;
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
  readonly recorded_by_membership_id: string;
  readonly confirmed_by_membership_id: string | null;
}

export interface SoldeMembre {
  readonly membership_id: string;
  readonly net_minor: number;
}

export interface TransfertSuggere {
  readonly from_membership_id: string;
  readonly to_membership_id: string;
  readonly amount_minor: number;
  readonly currency_code: string;
}

export interface SoldesParDevise {
  readonly currency_code: string;
  readonly soldes: readonly SoldeMembre[];
  readonly transferts: readonly TransfertSuggere[];
}

export interface ClotureDepenses {
  readonly id: string;
  readonly event_id: string;
  readonly currency_code: string;
  readonly total_minor: number;
  readonly closed_by_membership_id: string;
  readonly closed_at: string;
}

export interface ResultatSoldes {
  readonly cloture: ClotureDepenses | null;
  readonly ardoises: readonly SoldesParDevise[];
}

function devise(x: unknown): Devise {
  return {
    code: texte(champ(x, 'code')),
    exponent: nombre(champ(x, 'exponent')),
    symbol: texte(champ(x, 'symbol')),
    name_key: texte(champ(x, 'name_key')),
  };
}

function partDepense(x: unknown): PartDepense {
  return {
    expense_id: texte(champ(x, 'expense_id')),
    membership_id: texte(champ(x, 'membership_id')),
    weight: nombre(champ(x, 'weight')),
    share_minor: nombre(champ(x, 'share_minor')),
    share_target_minor: nombre(champ(x, 'share_target_minor')),
  };
}

function modeDe(v: unknown): ModeRepartition {
  if (v !== 'equal' && v !== 'weights' && v !== 'exact') throw new Error('Mode de répartition inconnu.');
  return v;
}

function sourceTaux(v: unknown): 'identity' | 'manual' | 'provider' {
  if (v !== 'identity' && v !== 'manual' && v !== 'provider') throw new Error('Source de taux inconnue.');
  return v;
}

function depense(x: unknown): Depense {
  return {
    id: texte(champ(x, 'id')),
    event_id: texteOuNul(champ(x, 'event_id')),
    label: texte(champ(x, 'label')),
    spent_on: texte(champ(x, 'spent_on')),
    payer_membership_id: texte(champ(x, 'payer_membership_id')),
    amount_minor: nombre(champ(x, 'amount_minor')),
    currency_code: texte(champ(x, 'currency_code')),
    target_currency_code: texte(champ(x, 'target_currency_code')),
    rate_ppm: nombre(champ(x, 'rate_ppm')),
    rate_source: sourceTaux(champ(x, 'rate_source')),
    amount_target_minor: nombre(champ(x, 'amount_target_minor')),
    split_mode: modeDe(champ(x, 'split_mode')),
    note: texteOuNul(champ(x, 'note')),
    created_by_membership_id: texte(champ(x, 'created_by_membership_id')),
    shares: liste(champ(x, 'shares')).map(partDepense),
  };
}

function remboursement(x: unknown): Remboursement {
  return {
    id: texte(champ(x, 'id')),
    event_id: texteOuNul(champ(x, 'event_id')),
    from_membership_id: texte(champ(x, 'from_membership_id')),
    to_membership_id: texte(champ(x, 'to_membership_id')),
    amount_minor: nombre(champ(x, 'amount_minor')),
    currency_code: texte(champ(x, 'currency_code')),
    target_currency_code: texte(champ(x, 'target_currency_code')),
    rate_ppm: nombre(champ(x, 'rate_ppm')),
    amount_target_minor: nombre(champ(x, 'amount_target_minor')),
    settled_on: texte(champ(x, 'settled_on')),
    method_note: texteOuNul(champ(x, 'method_note')),
    recorded_by_membership_id: texte(champ(x, 'recorded_by_membership_id')),
    confirmed_by_membership_id: texteOuNul(champ(x, 'confirmed_by_membership_id')),
  };
}

function soldesParDevise(x: unknown): SoldesParDevise {
  return {
    currency_code: texte(champ(x, 'currency_code')),
    soldes: liste(champ(x, 'soldes')).map((s) => ({
      membership_id: texte(champ(s, 'membership_id')),
      net_minor: nombre(champ(s, 'net_minor')),
    })),
    transferts: liste(champ(x, 'transferts')).map((tr) => ({
      from_membership_id: texte(champ(tr, 'from_membership_id')),
      to_membership_id: texte(champ(tr, 'to_membership_id')),
      amount_minor: nombre(champ(tr, 'amount_minor')),
      currency_code: texte(champ(tr, 'currency_code')),
    })),
  };
}

function cloture(x: unknown): ClotureDepenses {
  return {
    id: texte(champ(x, 'id')),
    event_id: texte(champ(x, 'event_id')),
    currency_code: texte(champ(x, 'currency_code')),
    total_minor: nombre(champ(x, 'total_minor')),
    closed_by_membership_id: texte(champ(x, 'closed_by_membership_id')),
    closed_at: texte(champ(x, 'closed_at')),
  };
}

function resultatSoldes(x: unknown): ResultatSoldes {
  const rawCloture = champ(x, 'cloture');
  return {
    cloture: rawCloture === null ? null : cloture(rawCloture),
    ardoises: liste(champ(x, 'ardoises')).map(soldesParDevise),
  };
}

const baseDepenses = (groupId: string): string => `/api/groupes/${encodeURIComponent(groupId)}/depenses`;
const baseRemboursements = (groupId: string): string => `/api/groupes/${encodeURIComponent(groupId)}/remboursements`;
const baseSoldes = (groupId: string): string => `/api/groupes/${encodeURIComponent(groupId)}/soldes`;

export async function listerDevises(): Promise<Devise[]> {
  return liste(champ(await appeler('GET', '/api/devises'), 'devises')).map(devise);
}

export async function listerDepenses(groupId: string, eventId?: string): Promise<Depense[]> {
  const qs = eventId !== undefined ? `?event_id=${encodeURIComponent(eventId)}` : '';
  return liste(champ(await appeler('GET', `${baseDepenses(groupId)}${qs}`), 'depenses')).map(depense);
}

export interface CreationDepense {
  readonly event_id: string | null;
  readonly label: string;
  readonly spent_on: string;
  readonly payer_membership_id: string;
  readonly amount_minor: number;
  readonly currency_code: string;
  readonly rate_ppm?: number;
  readonly split_mode: ModeRepartition;
  readonly note?: string | null;
  readonly shares: readonly { readonly membership_id: string; readonly weight?: number; readonly share_minor?: number }[];
}

export async function creerDepense(groupId: string, entree: CreationDepense): Promise<Depense> {
  return depense(await appeler('POST', baseDepenses(groupId), entree));
}

export async function supprimerDepense(groupId: string, depenseId: string): Promise<void> {
  await appeler('DELETE', `${baseDepenses(groupId)}/${encodeURIComponent(depenseId)}`);
}

export async function lireSoldes(groupId: string, eventId?: string): Promise<ResultatSoldes> {
  const qs = eventId !== undefined ? `?evenement=${encodeURIComponent(eventId)}` : '';
  return resultatSoldes(await appeler('GET', `${baseSoldes(groupId)}${qs}`));
}

export async function listerRemboursements(groupId: string, eventId?: string): Promise<Remboursement[]> {
  const qs = eventId !== undefined ? `?event_id=${encodeURIComponent(eventId)}` : '';
  return liste(champ(await appeler('GET', `${baseRemboursements(groupId)}${qs}`), 'remboursements')).map(remboursement);
}

export interface CreationRemboursement {
  readonly event_id: string | null;
  readonly from_membership_id: string;
  readonly to_membership_id: string;
  readonly amount_minor: number;
  readonly currency_code: string;
  readonly rate_ppm?: number;
  readonly settled_on: string;
  readonly method_note?: string | null;
}

export async function creerRemboursement(groupId: string, entree: CreationRemboursement): Promise<Remboursement> {
  return remboursement(await appeler('POST', baseRemboursements(groupId), entree));
}

export async function confirmerRemboursement(groupId: string, remboursementId: string): Promise<Remboursement> {
  return remboursement(await appeler('POST', `${baseRemboursements(groupId)}/${encodeURIComponent(remboursementId)}/confirmation`));
}

export async function supprimerRemboursement(groupId: string, remboursementId: string): Promise<void> {
  await appeler('DELETE', `${baseRemboursements(groupId)}/${encodeURIComponent(remboursementId)}`);
}

export async function cloturerEvenement(groupId: string, eventId: string): Promise<ResultatSoldes> {
  return resultatSoldes(await appeler('POST', `/api/groupes/${encodeURIComponent(groupId)}/evenements/${encodeURIComponent(eventId)}/cloture`));
}

export async function reouvrirEvenement(groupId: string, eventId: string): Promise<ResultatSoldes> {
  return resultatSoldes(await appeler('DELETE', `/api/groupes/${encodeURIComponent(groupId)}/evenements/${encodeURIComponent(eventId)}/cloture`));
}
