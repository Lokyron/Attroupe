import { codeDeviseValide, montantPositifOuNulValide, montantValide } from './argent.js';

// Calcul des soldes nets par appartenance et par devise de calcul, et suggestion déterministe
// de remboursements (modèle de données §3.10 et ADR-0004).
// Logique PURE : ni base de données, ni Express.

export type CodeErreurSolde =
  | 'devise_invalide'
  | 'devises_differentes'
  | 'montant_invalide'
  | 'membre_invalide'
  | 'depense_desequilibree'
  | 'remboursement_invalide'
  | 'soldes_desequilibres';

export class ErreurSolde extends Error {
  readonly code: CodeErreurSolde;

  constructor(code: CodeErreurSolde, message: string) {
    super(message);
    this.name = 'ErreurSolde';
    this.code = code;
  }
}

export interface PartDepenseSolde {
  readonly membership_id: string;
  readonly share_target_minor: number;
}

export interface EntreeDepenseSolde {
  readonly id?: string;
  readonly payer_membership_id: string;
  readonly amount_target_minor: number;
  readonly target_currency_code: string;
  /** Parts de la dépense (accepte `shares` ou `parts`). */
  readonly shares?: ReadonlyArray<PartDepenseSolde>;
  readonly parts?: ReadonlyArray<PartDepenseSolde>;
}

export interface EntreeRemboursementSolde {
  readonly id?: string;
  readonly from_membership_id: string;
  readonly to_membership_id: string;
  /** Montant converti dans la devise cible (prioritaire s'il est fourni). */
  readonly amount_target_minor?: number;
  /** Montant en unités mineures (utilisé si `amount_target_minor` est omis, ex. `TransfertSuggere`). */
  readonly amount_minor?: number;
  /** Devise de calcul du solde (prioritaire si elle est fournie). */
  readonly target_currency_code?: string;
  /** Code devise (utilisé si `target_currency_code` est omis, ex. `TransfertSuggere`). */
  readonly currency_code?: string;
  /** Identifiant de l'appartenance ayant confirmé la réception (facultatif). */
  readonly confirmed_by_membership_id?: string | null;
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
  readonly soldes: ReadonlyArray<SoldeMembre>;
  readonly transferts: ReadonlyArray<TransfertSuggere>;
}

export interface OptionsCalculSoldes {
  /** Si vrai, ne retient que les remboursements dont `confirmed_by_membership_id` est non nul. Par défaut `false`. */
  readonly uniquementConfirmes?: boolean;
  /** Membres à faire figurer dans l'ardoise même s'ils n'ont aucune opération (solde `0`). */
  readonly membresIds?: ReadonlyArray<string>;
}

function comparerMembershipId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function verifierMembreId(id: string, contexte: string): void {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new ErreurSolde('membre_invalide', `Identifiant de membre invalide (${contexte}).`);
  }
}

function extraireParts(depense: EntreeDepenseSolde): ReadonlyArray<PartDepenseSolde> {
  const liste = depense.shares ?? depense.parts;
  if (!Array.isArray(liste) || liste.length === 0) {
    throw new ErreurSolde('depense_desequilibree', 'Une dépense doit comporter au moins une part.');
  }
  return liste;
}

function extraireDeviseRemboursement(r: EntreeRemboursementSolde): string {
  const code = r.target_currency_code ?? r.currency_code ?? '';
  if (!codeDeviseValide(code)) {
    throw new ErreurSolde('devise_invalide', `Devise de remboursement invalide : ${String(code)}`);
  }
  return code;
}

function extraireMontantRemboursement(r: EntreeRemboursementSolde): number {
  const montant = r.amount_target_minor ?? r.amount_minor;
  if (montant === undefined || !montantValide(montant)) {
    throw new ErreurSolde('montant_invalide', `Montant de remboursement invalide : ${String(montant)}`);
  }
  return montant;
}

/**
 * Produit la liste de remboursements suggérés pour solder une ardoise dans une devise donnée.
 *
 * Algorithme glouton déterministe :
 *  - apparie à chaque étape le plus gros débiteur (`net_minor < 0`, en valeur absolue décroissante
 *    puis `membership_id` croissant) avec le plus gros créditeur (`net_minor > 0`, par montant
 *    décroissant puis `membership_id` croissant) ;
 *  - génère au plus `N - 1` transferts `{ from_membership_id, to_membership_id, amount_minor, currency_code }`.
 */
export function suggererRemboursements(
  soldes: ReadonlyArray<SoldeMembre> | ReadonlyMap<string, number>,
  currencyCode: string,
): TransfertSuggere[] {
  if (!codeDeviseValide(currencyCode)) {
    throw new ErreurSolde('devise_invalide', `Code devise ISO 4217 invalide : ${String(currencyCode)}`);
  }

  const listeSoldes: SoldeMembre[] =
    soldes instanceof Map
      ? Array.from(soldes.entries(), ([membership_id, net_minor]) => ({ membership_id, net_minor }))
      : [...(soldes as ReadonlyArray<SoldeMembre>)];

  let sommeTotale = 0n;
  const debiteurs: Array<{ membership_id: string; dette: bigint }> = [];
  const crediteurs: Array<{ membership_id: string; creance: bigint }> = [];
  const vus = new Set<string>();

  for (const s of listeSoldes) {
    verifierMembreId(s.membership_id, 'solde');
    if (vus.has(s.membership_id)) {
      throw new ErreurSolde('membre_invalide', `Membre en double dans les soldes : ${s.membership_id}`);
    }
    vus.add(s.membership_id);

    if (!Number.isSafeInteger(s.net_minor)) {
      throw new ErreurSolde('montant_invalide', `Solde non entier sûr pour ${s.membership_id} : ${String(s.net_minor)}`);
    }

    const net = BigInt(s.net_minor);
    sommeTotale += net;

    if (net < 0n) {
      debiteurs.push({ membership_id: s.membership_id, dette: -net });
    } else if (net > 0n) {
      crediteurs.push({ membership_id: s.membership_id, creance: net });
    }
  }

  if (sommeTotale !== 0n) {
    throw new ErreurSolde(
      'soldes_desequilibres',
      `La somme des soldes en ${currencyCode} ne vaut pas zéro (${sommeTotale.toString()}).`,
    );
  }

  const transferts: TransfertSuggere[] = [];

  while (debiteurs.length > 0 && crediteurs.length > 0) {
    debiteurs.sort((a, b) => {
      if (b.dette !== a.dette) {
        return b.dette > a.dette ? 1 : -1;
      }
      return comparerMembershipId(a.membership_id, b.membership_id);
    });

    crediteurs.sort((a, b) => {
      if (b.creance !== a.creance) {
        return b.creance > a.creance ? 1 : -1;
      }
      return comparerMembershipId(a.membership_id, b.membership_id);
    });

    const debiteur = debiteurs[0];
    const crediteur = crediteurs[0];
    if (debiteur === undefined || crediteur === undefined) {
      break;
    }

    const montant = debiteur.dette < crediteur.creance ? debiteur.dette : crediteur.creance;

    transferts.push({
      from_membership_id: debiteur.membership_id,
      to_membership_id: crediteur.membership_id,
      amount_minor: Number(montant),
      currency_code: currencyCode,
    });

    debiteur.dette -= montant;
    crediteur.creance -= montant;

    if (debiteur.dette === 0n) {
      debiteurs.shift();
    }
    if (crediteur.creance === 0n) {
      crediteurs.shift();
    }
  }

  return transferts;
}

/**
 * Calcule les soldes nets et les remboursements suggérés pour une unique devise cible `currencyCode`.
 * Lève `ErreurSolde('devises_differentes')` si une dépense ou un remboursement porte une autre devise cible.
 */
export function calculerSoldesDevise(
  currencyCode: string,
  depenses: ReadonlyArray<EntreeDepenseSolde>,
  remboursements: ReadonlyArray<EntreeRemboursementSolde> = [],
  options: OptionsCalculSoldes = {},
): SoldesParDevise {
  if (!codeDeviseValide(currencyCode)) {
    throw new ErreurSolde('devise_invalide', `Code devise ISO 4217 invalide : ${String(currencyCode)}`);
  }

  const netParMembre = new Map<string, bigint>();

  const assurerMembre = (membershipId: string, contexte: string): void => {
    verifierMembreId(membershipId, contexte);
    if (!netParMembre.has(membershipId)) {
      netParMembre.set(membershipId, 0n);
    }
  };

  if (options.membresIds !== undefined) {
    for (const id of options.membresIds) {
      assurerMembre(id, 'membresIds');
    }
  }

  for (const depense of depenses) {
    if (!codeDeviseValide(depense.target_currency_code)) {
      throw new ErreurSolde('devise_invalide', `Devise cible invalide : ${String(depense.target_currency_code)}`);
    }
    if (depense.target_currency_code !== currencyCode) {
      throw new ErreurSolde(
        'devises_differentes',
        `Impossible de mêler ${depense.target_currency_code} à l'ardoise en ${currencyCode}.`,
      );
    }
    if (!montantValide(depense.amount_target_minor)) {
      throw new ErreurSolde(
        'montant_invalide',
        `Montant cible de dépense invalide : ${String(depense.amount_target_minor)}`,
      );
    }

    assurerMembre(depense.payer_membership_id, 'payer_membership_id');
    const parts = extraireParts(depense);

    let sommeParts = 0n;
    const participantsVus = new Set<string>();

    for (const part of parts) {
      assurerMembre(part.membership_id, 'part.membership_id');
      if (participantsVus.has(part.membership_id)) {
        throw new ErreurSolde('membre_invalide', `Participant en double dans une dépense : ${part.membership_id}`);
      }
      participantsVus.add(part.membership_id);

      if (!montantPositifOuNulValide(part.share_target_minor)) {
        throw new ErreurSolde(
          'montant_invalide',
          `Part cible invalide pour ${part.membership_id} : ${String(part.share_target_minor)}`,
        );
      }
      sommeParts += BigInt(part.share_target_minor);
    }

    const totalDepense = BigInt(depense.amount_target_minor);
    if (sommeParts !== totalDepense) {
      throw new ErreurSolde(
        'depense_desequilibree',
        `La somme des parts (${sommeParts.toString()}) diffère du montant cible de la dépense (${totalDepense.toString()}).`,
      );
    }

    netParMembre.set(
      depense.payer_membership_id,
      (netParMembre.get(depense.payer_membership_id) ?? 0n) + totalDepense,
    );

    for (const part of parts) {
      netParMembre.set(
        part.membership_id,
        (netParMembre.get(part.membership_id) ?? 0n) - BigInt(part.share_target_minor),
      );
    }
  }

  const uniquementConfirmes = options.uniquementConfirmes === true;

  for (const remb of remboursements) {
    if (uniquementConfirmes && (remb.confirmed_by_membership_id === null || remb.confirmed_by_membership_id === undefined)) {
      continue;
    }

    const deviseRemb = extraireDeviseRemboursement(remb);
    if (deviseRemb !== currencyCode) {
      throw new ErreurSolde(
        'devises_differentes',
        `Impossible de mêler un remboursement en ${deviseRemb} à l'ardoise en ${currencyCode}.`,
      );
    }

    verifierMembreId(remb.from_membership_id, 'from_membership_id');
    verifierMembreId(remb.to_membership_id, 'to_membership_id');
    if (remb.from_membership_id === remb.to_membership_id) {
      throw new ErreurSolde('remboursement_invalide', 'Un membre ne peut pas se rembourser lui-même.');
    }

    const montant = BigInt(extraireMontantRemboursement(remb));
    assurerMembre(remb.from_membership_id, 'from_membership_id');
    assurerMembre(remb.to_membership_id, 'to_membership_id');

    // Celui qui rembourse voit sa dette diminuer (+montant) ; celui qui reçoit voit sa créance diminuer (-montant).
    netParMembre.set(remb.from_membership_id, (netParMembre.get(remb.from_membership_id) ?? 0n) + montant);
    netParMembre.set(remb.to_membership_id, (netParMembre.get(remb.to_membership_id) ?? 0n) - montant);
  }

  const soldes: SoldeMembre[] = Array.from(netParMembre.entries())
    .sort(([idA], [idB]) => comparerMembershipId(idA, idB))
    .map(([membership_id, netBigInt]) => {
      const net_minor = Number(netBigInt);
      if (!Number.isSafeInteger(net_minor)) {
        throw new ErreurSolde('montant_invalide', `Dépassement d'entier sûr sur le solde de ${membership_id}.`);
      }
      return { membership_id, net_minor };
    });

  const transferts = suggererRemboursements(soldes, currencyCode);

  return {
    currency_code: currencyCode,
    soldes,
    transferts,
  };
}

/**
 * Calcule les soldes nets et les remboursements suggérés groupés par devise cible (`target_currency_code`).
 * Retourne une ardoise par devise cible présente, triée par code devise croissant.
 */
export function calculerSoldesParDevise(
  depenses: ReadonlyArray<EntreeDepenseSolde>,
  remboursements: ReadonlyArray<EntreeRemboursementSolde> = [],
  options: OptionsCalculSoldes = {},
): SoldesParDevise[] {
  const devisesSet = new Set<string>();
  const depensesParDevise = new Map<string, EntreeDepenseSolde[]>();
  const remboursementsParDevise = new Map<string, EntreeRemboursementSolde[]>();

  for (const depense of depenses) {
    if (!codeDeviseValide(depense.target_currency_code)) {
      throw new ErreurSolde('devise_invalide', `Devise cible invalide : ${String(depense.target_currency_code)}`);
    }
    devisesSet.add(depense.target_currency_code);
    const liste = depensesParDevise.get(depense.target_currency_code) ?? [];
    liste.push(depense);
    depensesParDevise.set(depense.target_currency_code, liste);
  }

  const uniquementConfirmes = options.uniquementConfirmes === true;

  for (const remb of remboursements) {
    if (uniquementConfirmes && (remb.confirmed_by_membership_id === null || remb.confirmed_by_membership_id === undefined)) {
      continue;
    }
    const deviseRemb = extraireDeviseRemboursement(remb);
    devisesSet.add(deviseRemb);
    const liste = remboursementsParDevise.get(deviseRemb) ?? [];
    liste.push(remb);
    remboursementsParDevise.set(deviseRemb, liste);
  }

  const devisesTriees = Array.from(devisesSet).sort(comparerMembershipId);

  return devisesTriees.map((devise) =>
    calculerSoldesDevise(
      devise,
      depensesParDevise.get(devise) ?? [],
      remboursementsParDevise.get(devise) ?? [],
      options,
    ),
  );
}
