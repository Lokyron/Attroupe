/** État de consultation de l'agenda porté par le fragment d'URL : `?vue=semaine&date=2027-03-12`, `?vue=liste&jours=60`. */

export type VueAgenda = 'liste' | 'semaine' | 'mois';
export const VUES_AGENDA: readonly VueAgenda[] = ['liste', 'semaine', 'mois'];

export const JOURS_LISTE_DEFAUT = 30;
export const JOURS_LISTE_MAX = 730;

export interface EtatAgenda {
  readonly vue: VueAgenda;
  /** Jour `AAAA-MM-JJ` autour duquel s'affiche la semaine ou le mois. */
  readonly ancre: string;
  /** Horizon de la vue liste, en jours. */
  readonly joursListe: number;
}

/** Un jour `AAAA-MM-JJ` qui existe au calendrier (le 31 février est refusé). */
export function jourValide(valeur: string | null): valeur is string {
  if (valeur === null || !/^\d{4}-\d{2}-\d{2}$/.test(valeur)) return false;
  const date = new Date(`${valeur}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === valeur;
}

/** Lit la requête ; toute valeur absente ou invalide retombe sur celle de `defaut`, sans lever. */
export function lireEtatAgenda(requete: string, defaut: EtatAgenda): EtatAgenda {
  const params = new URLSearchParams(requete);
  const vue = VUES_AGENDA.find((v) => v === params.get('vue')) ?? defaut.vue;
  const date = params.get('date');
  const brut = params.get('jours');
  const jours = brut !== null && /^\d{1,4}$/.test(brut) ? Number(brut) : Number.NaN;
  return {
    vue,
    ancre: jourValide(date) ? date : defaut.ancre,
    joursListe: Number.isInteger(jours) && jours >= 1 ? Math.min(jours, JOURS_LISTE_MAX) : defaut.joursListe,
  };
}

/** Requête (avec son `?`) d'un état. L'ancre et l'horizon sont écrits même hors de leur vue, pour que changer de vue ne les perde pas. */
export function requeteAgenda(etat: EtatAgenda): string {
  const params = new URLSearchParams({ vue: etat.vue, date: etat.ancre });
  if (etat.joursListe !== JOURS_LISTE_DEFAUT) params.set('jours', String(etat.joursListe));
  return `?${params.toString()}`;
}
