// Dépouillement et règles métier des sondages de dates (lot 7, modèle de données §3.7).
// Logique pure, sans dépendance à la base :
//  - pondération des votes : oui = 2, peut-être = 1, non = 0 ;
//  - départage déterministe : score décroissant, nombre de « oui » décroissant, position croissante, identifiant croissant ;
//  - détection des créneaux en doublon avant l'écriture en base.

export type ValeurVote = 'yes' | 'maybe' | 'no';

export const POIDS_VOTE: Readonly<Record<ValeurVote, number>> = {
  yes: 2,
  maybe: 1,
  no: 0,
};

export interface CompteursOption {
  readonly yes: number;
  readonly maybe: number;
  readonly no: number;
  readonly score: number;
}

/** Calcule les compteurs (`yes`, `maybe`, `no`) et le `score = yes * 2 + maybe` d'une option à partir de ses votes. */
export function calculerCompteurs(votes: ReadonlyArray<ValeurVote | { readonly value: ValeurVote }>): CompteursOption {
  let yes = 0;
  let maybe = 0;
  let no = 0;
  for (const vote of votes) {
    const valeur = typeof vote === 'string' ? vote : vote.value;
    if (valeur === 'yes') yes++;
    else if (valeur === 'maybe') maybe++;
    else no++;
  }
  return {
    yes,
    maybe,
    no,
    score: yes * POIDS_VOTE.yes + maybe * POIDS_VOTE.maybe,
  };
}

export interface OptionClassable {
  readonly id: string;
  readonly position: number;
  readonly compteurs: Pick<CompteursOption, 'yes' | 'score'>;
}

/**
 * Comparateur déterministe entre deux options :
 *  1. `score` décroissant ;
 *  2. nombre de `yes` décroissant ;
 *  3. `position` croissant ;
 *  4. `id` croissant (ordre lexicographique).
 */
export function comparerOptions(a: OptionClassable, b: OptionClassable): number {
  if (a.compteurs.score !== b.compteurs.score) return b.compteurs.score - a.compteurs.score;
  if (a.compteurs.yes !== b.compteurs.yes) return b.compteurs.yes - a.compteurs.yes;
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Renvoie une copie des options classées de la meilleure à la moins bonne selon le départage déterministe. */
export function classerOptions<T extends OptionClassable>(options: readonly T[]): T[] {
  return [...options].sort(comparerOptions);
}

/** Désigne l'option gagnante du sondage, ou `null` s'il n'y a aucune option. */
export function optionGagnante<T extends OptionClassable>(options: readonly T[]): T | null {
  return classerOptions(options)[0] ?? null;
}

export interface CreneauOption {
  readonly all_day: boolean;
  readonly starts_at: string;
  readonly ends_at?: string | null | undefined;
}

/** Clé canonique du triplet `(all_day, starts_at, ends_at ?? null)` d'une option. */
export function cleCreneauOption(option: CreneauOption): string {
  return `${option.all_day ? '1' : '0'}|${option.starts_at}|${option.ends_at ?? ''}`;
}

/** Deux options portent-elles le même créneau ? */
export function memeCreneauOption(a: CreneauOption, b: CreneauOption): boolean {
  return a.all_day === b.all_day && a.starts_at === b.starts_at && (a.ends_at ?? null) === (b.ends_at ?? null);
}

/** `true` si au moins deux options de la liste ont le même triplet `(all_day, starts_at, ends_at ?? null)`. */
export function optionsOntDoublon(options: readonly CreneauOption[]): boolean {
  const vus = new Set<string>();
  for (const option of options) {
    const cle = cleCreneauOption(option);
    if (vus.has(cle)) return true;
    vus.add(cle);
  }
  return false;
}

/** Un sondage accepte des votes et des modifications d'options tant qu'il est `'open'` et que `closes_at` n'est pas atteint. */
export function sondageOuvert(sondage: { readonly status: string; readonly closes_at: string | null }, maintenant: string): boolean {
  if (sondage.status !== 'open') return false;
  return sondage.closes_at === null || sondage.closes_at > maintenant;
}
