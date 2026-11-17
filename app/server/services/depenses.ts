import { z } from 'zod';
import {
  confirmerRemboursement as confirmerRemboursementEnBase,
  creerCloture,
  creerDepense as creerDepenseEnBase,
  creerRemboursement as creerRemboursementEnBase,
  lireCloture,
  lireDepense,
  lireDeviseScope,
  lireRemboursement,
  lireStatutMembre,
  listerDepenses as listerDepensesEnBase,
  listerRemboursements as listerRemboursementsEnBase,
  modifierDepense as modifierDepenseEnBase,
  supprimerCloture,
  supprimerDepense as supprimerDepenseEnBase,
  type ClotureDepenses,
  type DepenseAvecParts,
  type FiltresDepenses,
  type NouvellePartDepense,
  type Remboursement,
} from '../db/queries/depenses.js';
import { lireEvenement, peutModifierEvenement } from '../db/queries/evenements.js';
import type { GroupScope } from '../db/scope.js';
import { additionnerMontants, convertirMontant, creerMontant, ErreurArgent, UNITE_TAUX_PPM } from '../domain/argent.js';
import { versInstant } from '../domain/instant.js';
import { ErreurRepartition, repartirDepense, type ModeRepartition, type ParticipantEntree } from '../domain/repartition.js';
import { calculerSoldesParDevise, type SoldesParDevise } from '../domain/soldes.js';
import type { Contexte } from '../http/contexte.js';
import { ErreurHttp } from '../http/erreurs.js';

// Cas d'usage des dépenses partagées, remboursements, soldes et clôture (lot 9, ADR-0004).
// Ordre strict des vérifications :
//  1. existence dans le groupe (404 `evenement.introuvable`, `depense.introuvable`, `remboursement.introuvable`, `membre.introuvable`) ;
//  2. droits fins (403 `droit.depense_requise`, `droit.beneficiaire_requis`, `droit.organisateur_requis`) ;
//  3. état métier (409 `membre.inactif`, `evenement.cloture`, 400 `devise.inconnue` / `taux.requis`, 422 `depense.somme_parts_inexacte`).

export interface ParticipantDepenseEntree {
  readonly membership_id: string;
  readonly weight?: number | undefined;
  readonly share_minor?: number | undefined;
}

export interface EntreeCreationDepense {
  readonly event_id: string | null;
  readonly label: string;
  readonly spent_on: string;
  readonly payer_membership_id: string;
  readonly amount_minor: number;
  readonly currency_code: string;
  readonly rate_ppm?: number | undefined;
  readonly rate_source?: 'manual' | 'provider' | undefined;
  readonly split_mode: ModeRepartition;
  readonly note: string | null;
  readonly shares: readonly ParticipantDepenseEntree[];
}

export interface EntreeModificationDepense {
  readonly event_id?: string | null | undefined;
  readonly label?: string | undefined;
  readonly spent_on?: string | undefined;
  readonly payer_membership_id?: string | undefined;
  readonly amount_minor?: number | undefined;
  readonly currency_code?: string | undefined;
  readonly rate_ppm?: number | undefined;
  readonly rate_source?: 'manual' | 'provider' | undefined;
  readonly split_mode?: ModeRepartition | undefined;
  readonly note?: string | null | undefined;
  readonly shares?: readonly ParticipantDepenseEntree[] | undefined;
}

export interface EntreeCreationRemboursement {
  readonly event_id: string | null;
  readonly from_membership_id: string;
  readonly to_membership_id: string;
  readonly amount_minor: number;
  readonly currency_code: string;
  readonly rate_ppm?: number | undefined;
  readonly settled_on: string;
  readonly method_note: string | null;
}

export interface ResultatSoldes {
  readonly cloture: ClotureDepenses | null;
  readonly ardoises: readonly SoldesParDevise[];
}

function verifierMembreExiste(scope: GroupScope, membreId: string): 'active' | 'left' | 'removed' {
  const statut = lireStatutMembre(scope, membreId);
  if (statut === undefined) throw new ErreurHttp(404, 'membre.introuvable');
  return statut;
}

function verifierMembreActif(scope: GroupScope, membreId: string): void {
  const statut = verifierMembreExiste(scope, membreId);
  if (statut !== 'active') throw new ErreurHttp(409, 'membre.inactif');
}

function trouverEvenement(scope: GroupScope, eventId: string) {
  const evenement = lireEvenement(scope, eventId);
  if (evenement === undefined) throw new ErreurHttp(404, 'evenement.introuvable');
  return evenement;
}

function deviseCiblePour(scope: GroupScope, eventCurrencyCode: string | null): string {
  if (eventCurrencyCode !== null) return eventCurrencyCode;
  const groupe = scope.groupe<{ default_currency_code: string }>();
  if (groupe === undefined) throw new ErreurHttp(404, 'groupe.introuvable');
  return groupe.default_currency_code;
}

function verifierNonCloture(scope: GroupScope, eventId: string | null): void {
  if (eventId !== null && lireCloture(scope, eventId) !== undefined) {
    throw new ErreurHttp(409, 'evenement.cloture');
  }
}

function peutModifierDepense(scope: GroupScope, depense: DepenseAvecParts): boolean {
  if (depense.created_by_membership_id === scope.membershipId) return true;
  if (depense.payer_membership_id === scope.membershipId) return true;
  if (depense.event_id !== null) {
    const evenement = lireEvenement(scope, depense.event_id);
    if (evenement !== undefined) return peutModifierEvenement(scope, evenement);
  }
  return scope.role === 'admin';
}

function convertirVersCible(
  scope: GroupScope,
  amountMinor: number,
  currencyCode: string,
  targetCurrencyCode: string,
  ratePpmFourni: number | undefined,
  rateSourceFourni: 'manual' | 'provider' | undefined,
): { rate_ppm: number; rate_source: 'identity' | 'manual' | 'provider'; amount_target_minor: number } {
  const deviseSource = lireDeviseScope(scope, currencyCode);
  if (deviseSource === undefined) throw new ErreurHttp(400, 'devise.inconnue');
  const deviseCible = lireDeviseScope(scope, targetCurrencyCode);
  if (deviseCible === undefined) throw new ErreurHttp(400, 'devise.inconnue');

  if (currencyCode === targetCurrencyCode) {
    return {
      rate_ppm: UNITE_TAUX_PPM,
      rate_source: 'identity',
      amount_target_minor: amountMinor,
    };
  }

  if (ratePpmFourni === undefined || !Number.isSafeInteger(ratePpmFourni) || ratePpmFourni <= 0) {
    throw new ErreurHttp(400, 'taux.requis');
  }

  try {
    const amountTargetMinor = convertirMontant(amountMinor, ratePpmFourni, deviseSource.exponent, deviseCible.exponent);
    return {
      rate_ppm: ratePpmFourni,
      rate_source: rateSourceFourni ?? 'manual',
      amount_target_minor: amountTargetMinor,
    };
  } catch (erreur) {
    if (erreur instanceof ErreurArgent) {
      throw new ErreurHttp(400, 'requete.invalide');
    }
    throw erreur;
  }
}

/**
 * Les montants individuellement valides (≤ MAX_SAFE_INTEGER) peuvent dépasser la capacité des entiers sûrs une fois additionnés :
 * `ErreurArgent` devient alors un 422 (état de l'événement, pas requête malformée) au lieu d'un 500 qui bloquerait la clôture.
 */
function bornerCalculMonetaire<T>(calcul: () => T): T {
  try {
    return calcul();
  } catch (erreur) {
    if (erreur instanceof ErreurArgent) throw new ErreurHttp(422, 'depense.montants_trop_grands');
    throw erreur;
  }
}

function calculerParts(
  amountMinor: number,
  amountTargetMinor: number,
  mode: ModeRepartition,
  participants: readonly ParticipantDepenseEntree[],
): NouvellePartDepense[] {
  const normalises: ParticipantEntree[] = participants.map((p) => ({
    membership_id: p.membership_id,
    ...(p.weight !== undefined ? { weight: p.weight } : {}),
    ...(p.share_minor !== undefined ? { share_minor: p.share_minor } : {}),
  }));
  try {
    return repartirDepense({ amountMinor, amountTargetMinor, mode, participants: normalises });
  } catch (erreur) {
    if (erreur instanceof ErreurRepartition) {
      if (erreur.code === 'somme_parts_inexacte') {
        throw new ErreurHttp(422, 'depense.somme_parts_inexacte');
      }
      throw new ErreurHttp(400, 'requete.invalide');
    }
    throw erreur;
  }
}

// --- Dépenses ----------------------------------------------------------------------------------------------

export function listerDepensesService(scope: GroupScope, filtres?: FiltresDepenses): DepenseAvecParts[] {
  if (filtres?.event_id !== undefined) trouverEvenement(scope, filtres.event_id);
  if (filtres?.payer_membership_id !== undefined) verifierMembreExiste(scope, filtres.payer_membership_id);
  return listerDepensesEnBase(scope, filtres);
}

export function lireDepenseService(scope: GroupScope, depenseId: string): DepenseAvecParts {
  const depense = lireDepense(scope, depenseId);
  if (depense === undefined) throw new ErreurHttp(404, 'depense.introuvable');
  return depense;
}

export function creerDepenseService(contexte: Contexte, scope: GroupScope, entree: EntreeCreationDepense): DepenseAvecParts {
  const evenement = entree.event_id !== null ? trouverEvenement(scope, entree.event_id) : undefined;
  verifierMembreExiste(scope, entree.payer_membership_id);
  for (const part of entree.shares) {
    verifierMembreExiste(scope, part.membership_id);
  }
  verifierMembreActif(scope, entree.payer_membership_id);
  for (const part of entree.shares) {
    verifierMembreActif(scope, part.membership_id);
  }
  verifierNonCloture(scope, entree.event_id);

  const targetCurrencyCode = deviseCiblePour(scope, evenement?.currency_code ?? null);
  const { rate_ppm, rate_source, amount_target_minor } = convertirVersCible(
    scope,
    entree.amount_minor,
    entree.currency_code,
    targetCurrencyCode,
    entree.rate_ppm,
    entree.rate_source,
  );
  const parts = calculerParts(entree.amount_minor, amount_target_minor, entree.split_mode, entree.shares);

  const id = creerDepenseEnBase(
    scope,
    {
      event_id: entree.event_id,
      label: entree.label,
      spent_on: entree.spent_on,
      payer_membership_id: entree.payer_membership_id,
      amount_minor: entree.amount_minor,
      currency_code: entree.currency_code,
      target_currency_code: targetCurrencyCode,
      rate_ppm,
      rate_source,
      rate_fetched_at: null,
      amount_target_minor,
      split_mode: entree.split_mode,
      note: entree.note,
    },
    parts,
  );

  contexte.diffuseur?.diffuser(scope, { type: 'depense.creee', ressource: 'depense', id, parent_id: entree.event_id });
  return lireDepenseService(scope, id);
}

export function modifierDepenseService(
  contexte: Contexte,
  scope: GroupScope,
  depenseId: string,
  modif: EntreeModificationDepense,
): DepenseAvecParts {
  const actuelle = lireDepenseService(scope, depenseId);
  const nouvelEventId = modif.event_id !== undefined ? modif.event_id : actuelle.event_id;
  const nouvelEvenement = nouvelEventId !== null ? trouverEvenement(scope, nouvelEventId) : undefined;

  if (modif.payer_membership_id !== undefined && modif.payer_membership_id !== actuelle.payer_membership_id) {
    verifierMembreExiste(scope, modif.payer_membership_id);
  }
  if (modif.shares !== undefined) {
    for (const part of modif.shares) {
      verifierMembreExiste(scope, part.membership_id);
    }
  }

  if (!peutModifierDepense(scope, actuelle)) {
    throw new ErreurHttp(403, 'droit.depense_requise');
  }

  verifierNonCloture(scope, actuelle.event_id);
  if (nouvelEventId !== actuelle.event_id) {
    verifierNonCloture(scope, nouvelEventId);
  }

  if (modif.payer_membership_id !== undefined && modif.payer_membership_id !== actuelle.payer_membership_id) {
    verifierMembreActif(scope, modif.payer_membership_id);
  }
  if (modif.shares !== undefined) {
    for (const part of modif.shares) {
      verifierMembreActif(scope, part.membership_id);
    }
  }

  const targetCurrencyCode = deviseCiblePour(scope, nouvelEvenement?.currency_code ?? null);
  const currencyCode = modif.currency_code ?? actuelle.currency_code;
  const amountMinor = modif.amount_minor ?? actuelle.amount_minor;
  const splitMode = modif.split_mode ?? actuelle.split_mode;

  const ratePpmCandidat =
    modif.rate_ppm !== undefined
      ? modif.rate_ppm
      : currencyCode === actuelle.currency_code && targetCurrencyCode === actuelle.target_currency_code
        ? actuelle.rate_ppm
        : undefined;
  const rateSourceCandidat =
    modif.rate_source !== undefined
      ? modif.rate_source
      : actuelle.rate_source === 'identity'
        ? undefined
        : actuelle.rate_source;

  const { rate_ppm, rate_source, amount_target_minor } = convertirVersCible(
    scope,
    amountMinor,
    currencyCode,
    targetCurrencyCode,
    ratePpmCandidat,
    rateSourceCandidat,
  );

  const besoinRecalculParts =
    modif.shares !== undefined ||
    modif.amount_minor !== undefined ||
    modif.split_mode !== undefined ||
    modif.currency_code !== undefined ||
    modif.rate_ppm !== undefined ||
    targetCurrencyCode !== actuelle.target_currency_code;

  let nouvellesParts: NouvellePartDepense[] | undefined;
  if (besoinRecalculParts) {
    const participants: readonly ParticipantDepenseEntree[] =
      modif.shares ??
      actuelle.shares.map((s) => ({
        membership_id: s.membership_id,
        weight: s.weight,
        share_minor: s.share_minor,
      }));
    nouvellesParts = calculerParts(amountMinor, amount_target_minor, splitMode, participants);
  }

  modifierDepenseEnBase(
    scope,
    depenseId,
    {
      event_id: modif.event_id,
      label: modif.label,
      spent_on: modif.spent_on,
      payer_membership_id: modif.payer_membership_id,
      amount_minor: modif.amount_minor,
      currency_code: modif.currency_code,
      target_currency_code: targetCurrencyCode,
      rate_ppm,
      rate_source,
      amount_target_minor,
      split_mode: modif.split_mode,
      note: modif.note,
    },
    nouvellesParts,
  );

  contexte.diffuseur?.diffuser(scope, { type: 'depense.modifiee', ressource: 'depense', id: depenseId, parent_id: nouvelEventId });
  return lireDepenseService(scope, depenseId);
}

export function supprimerDepenseService(contexte: Contexte, scope: GroupScope, depenseId: string): void {
  const actuelle = lireDepenseService(scope, depenseId);
  if (!peutModifierDepense(scope, actuelle)) {
    throw new ErreurHttp(403, 'droit.depense_requise');
  }
  verifierNonCloture(scope, actuelle.event_id);
  supprimerDepenseEnBase(scope, depenseId);
  contexte.diffuseur?.diffuser(scope, { type: 'depense.supprimee', ressource: 'depense', id: depenseId, parent_id: actuelle.event_id });
}

// --- Remboursements ----------------------------------------------------------------------------------------

export function listerRemboursementsService(scope: GroupScope, eventId?: string): Remboursement[] {
  if (eventId !== undefined) trouverEvenement(scope, eventId);
  return listerRemboursementsEnBase(scope, eventId);
}

export function creerRemboursementService(
  contexte: Contexte,
  scope: GroupScope,
  entree: EntreeCreationRemboursement,
): Remboursement {
  const evenement = entree.event_id !== null ? trouverEvenement(scope, entree.event_id) : undefined;
  verifierMembreExiste(scope, entree.from_membership_id);
  verifierMembreExiste(scope, entree.to_membership_id);
  verifierMembreActif(scope, entree.from_membership_id);
  verifierMembreActif(scope, entree.to_membership_id);
  if (entree.from_membership_id === entree.to_membership_id) {
    throw new ErreurHttp(400, 'requete.invalide');
  }
  verifierNonCloture(scope, entree.event_id);

  const targetCurrencyCode = deviseCiblePour(scope, evenement?.currency_code ?? null);
  const { rate_ppm, amount_target_minor } = convertirVersCible(
    scope,
    entree.amount_minor,
    entree.currency_code,
    targetCurrencyCode,
    entree.rate_ppm,
    'manual',
  );

  const id = creerRemboursementEnBase(scope, {
    event_id: entree.event_id,
    from_membership_id: entree.from_membership_id,
    to_membership_id: entree.to_membership_id,
    amount_minor: entree.amount_minor,
    currency_code: entree.currency_code,
    target_currency_code: targetCurrencyCode,
    rate_ppm,
    amount_target_minor,
    settled_on: entree.settled_on,
    method_note: entree.method_note,
  });

  contexte.diffuseur?.diffuser(scope, { type: 'remboursement.cree', ressource: 'remboursement', id, parent_id: entree.event_id });
  const cree = lireRemboursement(scope, id);
  if (cree === undefined) throw new ErreurHttp(404, 'remboursement.introuvable');
  return cree;
}

export function confirmerRemboursementService(contexte: Contexte, scope: GroupScope, remboursementId: string): Remboursement {
  const actuel = lireRemboursement(scope, remboursementId);
  if (actuel === undefined) throw new ErreurHttp(404, 'remboursement.introuvable');
  if (actuel.to_membership_id !== scope.membershipId) {
    throw new ErreurHttp(403, 'droit.beneficiaire_requis');
  }
  verifierNonCloture(scope, actuel.event_id);
  confirmerRemboursementEnBase(scope, remboursementId);
  contexte.diffuseur?.diffuser(scope, {
    type: 'remboursement.confirme',
    ressource: 'remboursement',
    id: remboursementId,
    parent_id: actuel.event_id,
  });
  const misAJour = lireRemboursement(scope, remboursementId);
  if (misAJour === undefined) throw new ErreurHttp(404, 'remboursement.introuvable');
  return misAJour;
}

// --- Soldes et clôture -------------------------------------------------------------------------------------

// Forme du `snapshot_json` d'une clôture : un tableau d'ardoises, une par devise (cf. `SoldesParDevise`).
// Validé à la lecture : la donnée sort de la base, elle ne se contente pas d'un `as`.
const schemaSnapshotCloture = z.array(
  z.object({
    currency_code: z.string().regex(/^[A-Z]{3}$/),
    soldes: z.array(z.object({ membership_id: z.string().min(1), net_minor: z.number().int() })),
    transferts: z.array(
      z.object({
        from_membership_id: z.string().min(1),
        to_membership_id: z.string().min(1),
        amount_minor: z.number().int(),
        currency_code: z.string().regex(/^[A-Z]{3}$/),
      }),
    ),
  }),
);

function lireSnapshotCloture(snapshotJson: string): SoldesParDevise[] {
  let brut: unknown;
  try {
    brut = JSON.parse(snapshotJson);
  } catch {
    throw new Error('snapshot_json de clôture illisible (JSON invalide).');
  }
  return schemaSnapshotCloture.parse(brut);
}

export function calculerSoldesGroupe(scope: GroupScope, eventId?: string): ResultatSoldes {
  if (eventId !== undefined) trouverEvenement(scope, eventId);
  const cloture = eventId !== undefined ? (lireCloture(scope, eventId) ?? null) : null;
  if (cloture !== null) {
    const ardoises = lireSnapshotCloture(cloture.snapshot_json);
    return { cloture, ardoises };
  }
  const depenses = listerDepensesEnBase(scope, eventId !== undefined ? { event_id: eventId } : undefined);
  const remboursements = listerRemboursementsEnBase(scope, eventId);
  const ardoises = bornerCalculMonetaire(() => calculerSoldesParDevise(depenses, remboursements));
  return { cloture: null, ardoises };
}

export function cloturerEvenementService(contexte: Contexte, scope: GroupScope, evenementId: string): ResultatSoldes {
  const evenement = trouverEvenement(scope, evenementId);
  if (!peutModifierEvenement(scope, evenement)) {
    throw new ErreurHttp(403, 'droit.organisateur_requis');
  }

  const { clotureId, ardoises } = scope.transaction(() => {
    if (lireCloture(scope, evenementId) !== undefined) {
      throw new ErreurHttp(409, 'evenement.cloture');
    }

    const depenses = listerDepensesEnBase(scope, { event_id: evenementId });
    const remboursements = listerRemboursementsEnBase(scope, evenementId);
    const calcul = bornerCalculMonetaire(() => calculerSoldesParDevise(depenses, remboursements));
    const currencyCode = deviseCiblePour(scope, evenement.currency_code);
    // La devise d'un événement est modifiable : ses dépenses peuvent être en plusieurs devises cibles.
    // `total_minor` est le total dans la devise de la clôture ; les autres devises restent chacune
    // dans leur ardoise du snapshot, jamais additionnées entre elles (ADR-0004).
    const totalMinor = bornerCalculMonetaire(
      () =>
        depenses
          .filter((d) => d.target_currency_code === currencyCode)
          .reduce((acc, d) => additionnerMontants(acc, creerMontant(d.amount_target_minor, currencyCode)), creerMontant(0, currencyCode)).minor,
    );

    const id = creerCloture(scope, {
      event_id: evenementId,
      currency_code: currencyCode,
      snapshot_json: JSON.stringify(calcul),
      total_minor: totalMinor,
      closed_at: versInstant(contexte.horloge()),
    });
    return { clotureId: id, ardoises: calcul };
  });

  contexte.diffuseur?.diffuser(scope, { type: 'evenement.cloture', ressource: 'evenement', id: clotureId, parent_id: evenementId });
  const cloture = lireCloture(scope, evenementId) ?? null;
  return { cloture, ardoises };
}

export function reouvrirEvenementService(contexte: Contexte, scope: GroupScope, evenementId: string): ResultatSoldes {
  const evenement = trouverEvenement(scope, evenementId);
  if (!peutModifierEvenement(scope, evenement)) {
    throw new ErreurHttp(403, 'droit.organisateur_requis');
  }
  supprimerCloture(scope, evenementId, versInstant(contexte.horloge()));
  contexte.diffuseur?.diffuser(scope, { type: 'evenement.reouvert', ressource: 'evenement', id: evenementId, parent_id: null });
  return calculerSoldesGroupe(scope, evenementId);
}
