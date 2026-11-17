import { montantPositifOuNulValide, montantValide } from './argent.js';

// Répartition des dépenses et affectation déterministe du reliquat par la méthode de Hamilton
// (« plus grands restes », modèle de données §4.5 et ADR-0004).
// Logique PURE : ni base de données, ni Express.

export type ModeRepartition = 'equal' | 'weights' | 'exact';

export type CodeErreurRepartition =
  | 'montant_invalide'
  | 'mode_invalide'
  | 'aucun_participant'
  | 'participant_invalide'
  | 'participant_en_double'
  | 'poids_invalide'
  | 'part_invalide'
  | 'somme_parts_inexacte';

export class ErreurRepartition extends Error {
  readonly code: CodeErreurRepartition;

  constructor(code: CodeErreurRepartition, message: string) {
    super(message);
    this.name = 'ErreurRepartition';
    this.code = code;
  }
}

export interface ParticipantEntree {
  readonly membership_id: string;
  readonly weight?: number;
  readonly share_minor?: number;
}

export interface EntreeRepartition {
  readonly amountMinor: number;
  readonly amountTargetMinor: number;
  readonly mode: ModeRepartition;
  readonly participants: ReadonlyArray<ParticipantEntree>;
}

export interface PartCalculee {
  readonly membership_id: string;
  readonly weight: number;
  readonly share_minor: number;
  readonly share_target_minor: number;
}

interface PoidsParticipant {
  readonly membership_id: string;
  readonly weight: bigint;
}

/** Comparaison lexicographique stricte sur les identifiants d'appartenance (indépendante de la locale système). */
function comparerMembershipId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Applique la méthode de Hamilton (plus grands restes) en `BigInt` pour un total `totalMinor` et une liste de poids.
 *
 * - `base_i  = (T × w_i) / W`
 * - `reste_i = (T × w_i) mod W`
 * - `R       = T − Σ base_i` (`0 <= R < n`)
 * - Départage par `reste_i` décroissant, puis par `membership_id` croissant.
 */
export function repartirParHamilton(
  totalMinor: number,
  entrees: ReadonlyArray<{ readonly membership_id: string; readonly weight: number }>,
): Map<string, number> {
  if (!montantValide(totalMinor)) {
    throw new ErreurRepartition('montant_invalide', `Total à répartir invalide : ${String(totalMinor)}`);
  }
  if (entrees.length === 0) {
    throw new ErreurRepartition('aucun_participant', 'La répartition exige au moins un participant.');
  }

  const poidsBigInt: PoidsParticipant[] = [];
  let sommePoids = 0n;
  const vus = new Set<string>();

  for (const e of entrees) {
    if (typeof e.membership_id !== 'string' || e.membership_id.trim() === '') {
      throw new ErreurRepartition('participant_invalide', 'Identifiant de participant manquant ou vide.');
    }
    if (vus.has(e.membership_id)) {
      throw new ErreurRepartition('participant_en_double', `Participant en double : ${e.membership_id}`);
    }
    vus.add(e.membership_id);

    if (!montantPositifOuNulValide(e.weight)) {
      throw new ErreurRepartition('poids_invalide', `Poids invalide pour ${e.membership_id} : ${String(e.weight)}`);
    }
    const w = BigInt(e.weight);
    poidsBigInt.push({ membership_id: e.membership_id, weight: w });
    sommePoids += w;
  }

  if (sommePoids <= 0n) {
    throw new ErreurRepartition('poids_invalide', 'La somme des poids doit être strictement positive.');
  }

  const total = BigInt(totalMinor);
  const calculs = poidsBigInt.map((p) => {
    const produit = total * p.weight;
    return {
      membership_id: p.membership_id,
      base: produit / sommePoids,
      reste: produit % sommePoids,
    };
  });

  let sommeBases = 0n;
  for (const c of calculs) {
    sommeBases += c.base;
  }

  const reliquat = Number(total - sommeBases);

  const triesPourReliquat = [...calculs].sort((a, b) => {
    if (b.reste !== a.reste) {
      return b.reste > a.reste ? 1 : -1;
    }
    return comparerMembershipId(a.membership_id, b.membership_id);
  });

  const resultat = new Map<string, number>();
  for (let i = 0; i < triesPourReliquat.length; i += 1) {
    const item = triesPourReliquat[i];
    if (item !== undefined) {
      const supplement = i < reliquat ? 1n : 0n;
      resultat.set(item.membership_id, Number(item.base + supplement));
    }
  }

  return resultat;
}

/**
 * Calcule les parts (`share_minor` et `share_target_minor`) d'une dépense selon le mode choisi (§4.5).
 *
 * Accepte soit un objet `EntreeRepartition`, soit les 4 paramètres positionnels.
 * Retourne les parts triées par `membership_id` croissant, garantissant un résultat reproductible
 * quel que soit l'ordre du tableau d'entrée.
 */
export function repartirDepense(entree: EntreeRepartition): PartCalculee[];
export function repartirDepense(
  amountMinor: number,
  amountTargetMinor: number,
  mode: ModeRepartition,
  participants: ReadonlyArray<ParticipantEntree>,
): PartCalculee[];
export function repartirDepense(
  arg1: EntreeRepartition | number,
  arg2?: number,
  arg3?: ModeRepartition,
  arg4?: ReadonlyArray<ParticipantEntree>,
): PartCalculee[] {
  const entree: EntreeRepartition =
    typeof arg1 === 'number'
      ? {
          amountMinor: arg1,
          amountTargetMinor: arg2 as number,
          mode: arg3 as ModeRepartition,
          participants: arg4 as ReadonlyArray<ParticipantEntree>,
        }
      : arg1;

  const { amountMinor, amountTargetMinor, mode, participants } = entree;

  if (!montantValide(amountMinor)) {
    throw new ErreurRepartition('montant_invalide', `Montant de dépense invalide : ${String(amountMinor)}`);
  }
  if (!montantValide(amountTargetMinor)) {
    throw new ErreurRepartition('montant_invalide', `Montant converti invalide : ${String(amountTargetMinor)}`);
  }
  if (mode !== 'equal' && mode !== 'weights' && mode !== 'exact') {
    throw new ErreurRepartition('mode_invalide', `Mode de répartition inconnu : ${String(mode)}`);
  }
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new ErreurRepartition('aucun_participant', 'Une dépense doit compter au moins un participant.');
  }

  const vus = new Set<string>();
  for (const p of participants) {
    if (typeof p.membership_id !== 'string' || p.membership_id.trim() === '') {
      throw new ErreurRepartition('participant_invalide', 'Identifiant de participant manquant ou vide.');
    }
    if (vus.has(p.membership_id)) {
      throw new ErreurRepartition('participant_en_double', `Participant en double : ${p.membership_id}`);
    }
    vus.add(p.membership_id);
  }

  // Tri canonique des participants par membership_id croissant dès le départ.
  const participantsTries = [...participants].sort((a, b) =>
    comparerMembershipId(a.membership_id, b.membership_id),
  );

  if (mode === 'equal') {
    const poidsEgaux = participantsTries.map((p) => ({ membership_id: p.membership_id, weight: 1 }));
    const partsSource = repartirParHamilton(amountMinor, poidsEgaux);
    const partsCible =
      amountTargetMinor === amountMinor
        ? partsSource
        : repartirParHamilton(amountTargetMinor, poidsEgaux);

    return participantsTries.map((p) => ({
      membership_id: p.membership_id,
      weight: 1,
      share_minor: partsSource.get(p.membership_id) ?? 0,
      share_target_minor: partsCible.get(p.membership_id) ?? 0,
    }));
  }

  if (mode === 'weights') {
    const poidsSaisis = participantsTries.map((p) => {
      if (p.weight === undefined || !montantValide(p.weight)) {
        throw new ErreurRepartition(
          'poids_invalide',
          `Le poids de ${p.membership_id} doit être un entier strictement positif.`,
        );
      }
      return { membership_id: p.membership_id, weight: p.weight };
    });

    const partsSource = repartirParHamilton(amountMinor, poidsSaisis);
    const partsCible =
      amountTargetMinor === amountMinor
        ? partsSource
        : repartirParHamilton(amountTargetMinor, poidsSaisis);

    return poidsSaisis.map((p) => ({
      membership_id: p.membership_id,
      weight: p.weight,
      share_minor: partsSource.get(p.membership_id) ?? 0,
      share_target_minor: partsCible.get(p.membership_id) ?? 0,
    }));
  }

  // Mode 'exact' : chaque participant fournit sa part exacte `share_minor`.
  let sommeExacte = 0n;
  const partsExactes = participantsTries.map((p) => {
    if (p.share_minor === undefined || !montantPositifOuNulValide(p.share_minor)) {
      throw new ErreurRepartition(
        'part_invalide',
        `La part exacte de ${p.membership_id} doit être un entier positif ou nul.`,
      );
    }
    const weight = p.weight !== undefined && montantPositifOuNulValide(p.weight) ? p.weight : 1;
    sommeExacte += BigInt(p.share_minor);
    return { membership_id: p.membership_id, share_minor: p.share_minor, weight };
  });

  if (sommeExacte !== BigInt(amountMinor)) {
    throw new ErreurRepartition(
      'somme_parts_inexacte',
      `La somme des parts saisies (${sommeExacte.toString()}) diffère du total de la dépense (${String(amountMinor)}).`,
    );
  }

  if (amountTargetMinor === amountMinor) {
    return partsExactes.map((p) => ({
      membership_id: p.membership_id,
      weight: p.weight,
      share_minor: p.share_minor,
      share_target_minor: p.share_minor,
    }));
  }

  const poidsDepuisParts = partsExactes.map((p) => ({
    membership_id: p.membership_id,
    weight: p.share_minor,
  }));
  const partsCible = repartirParHamilton(amountTargetMinor, poidsDepuisParts);

  return partsExactes.map((p) => ({
    membership_id: p.membership_id,
    weight: p.weight,
    share_minor: p.share_minor,
    share_target_minor: partsCible.get(p.membership_id) ?? 0,
  }));
}
