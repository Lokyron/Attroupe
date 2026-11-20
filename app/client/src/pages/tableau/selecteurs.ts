// Dérivations pures du tableau de bord : aucune dépendance au DOM, à React ni aux textes (testables sous Node).
// Les types d'entrée sont structurels et minimaux : `DonneesTableauDeBord` (api/) les satisfait, et ce fichier
// n'importe rien d'autre que les dates, pour rester chargeable par les tests.
import { ajouterJours, grilleMois, jourDeDebut, joursDe, joursDeSemaine } from '../../agenda/dates.js';

export type FiltreCalendrier = 'tous' | 'groupes' | 'perso';
export type VueCalendrier = 'liste' | 'semaine' | 'mois';
export type StatutPresence = 'yes' | 'maybe' | 'no' | null;

export const VUES_CALENDRIER: readonly VueCalendrier[] = ['liste', 'semaine', 'mois'];
export const COULEURS_GROUPES = ['indigo', 'cyan', 'violet', 'emeraude', 'ambre', 'rose'] as const;
export type CouleurGroupe = (typeof COULEURS_GROUPES)[number];

export type ElementCalendrier =
  | {
      readonly sorte: 'groupe';
      readonly id: string;
      readonly group_id: string;
      readonly group_name: string;
      readonly title: string;
      readonly starts_at: string;
      readonly ends_at: string | null;
      readonly all_day: boolean;
      readonly time_zone: string;
      readonly location_name: string | null;
      readonly mon_statut: StatutPresence;
    }
  | {
      readonly sorte: 'perso';
      readonly id: string;
      readonly title: string;
      readonly starts_at: string;
      readonly ends_at: string | null;
      readonly all_day: boolean;
      readonly time_zone: string;
      readonly location_name: string | null;
    };

interface AvecGroupe {
  readonly group_id: string;
}

interface EvenementsEntree {
  readonly evenements: readonly Omit<Extract<ElementCalendrier, { sorte: 'groupe' }>, 'sorte'>[];
  readonly evenements_perso: readonly Omit<Extract<ElementCalendrier, { sorte: 'perso' }>, 'sorte'>[];
}

interface SoldeEntree extends AvecGroupe {
  readonly currency_code: string;
  readonly net_minor: number;
}

/** Fenêtre à demander au serveur pour une vue ; `undefined` pour la liste (le serveur renvoie alors sa fenêtre par défaut). */
export function fenetreCalendrier(vue: VueCalendrier, ancreJour: string): { du: string; au: string } | undefined {
  if (vue === 'liste') return undefined;
  const jours = vue === 'mois' ? grilleMois(ancreJour).flat() : joursDeSemaine(ancreJour);
  return {
    du: ajouterJours(jours[0] ?? ancreJour, -1),
    au: ajouterJours(jours[jours.length - 1] ?? ancreJour, 1),
  };
}

export function lienElementCalendrier(el: ElementCalendrier): string {
  return el.sorte === 'groupe'
    ? `#/groupe/${encodeURIComponent(el.group_id)}/evenement/${encodeURIComponent(el.id)}`
    : '#/compte';
}

/** Un groupe garde la même couleur partout : elle découle de son rang dans la liste. */
export function couleursParGroupe(groupes: readonly AvecGroupe[]): Map<string, CouleurGroupe> {
  const couleurs = new Map<string, CouleurGroupe>();
  groupes.forEach((g, idx) => {
    couleurs.set(g.group_id, COULEURS_GROUPES[idx % COULEURS_GROUPES.length] ?? 'indigo');
  });
  return couleurs;
}

/** Garde les éléments du groupe filtré ; `''` = tous les groupes. */
export function filtrerParGroupe<T extends AvecGroupe>(elements: readonly T[], filtreGroupe: string): T[] {
  return elements.filter((e) => filtreGroupe === '' || e.group_id === filtreGroupe);
}

/**
 * Groupe visé par les actions rapides : l'unique groupe de l'utilisateur, sinon celui du filtre. Avec plusieurs
 * groupes et le filtre « Tous », il n'y a pas de cible : `null` plutôt que de deviner.
 */
export function groupeCible<G extends AvecGroupe>(groupes: readonly G[], filtreGroupe: string): G | null {
  return groupes.length === 1 ? (groupes[0] ?? null) : (groupes.find((g) => g.group_id === filtreGroupe) ?? null);
}

/** Événements de groupe (filtrés par groupe) et personnels, fusionnés selon l'onglet de source et triés par début. */
export function elementsCalendrier(
  donnees: EvenementsEntree,
  filtreGroupe: string,
  filtreCalendrier: FiltreCalendrier,
): ElementCalendrier[] {
  const groupes: ElementCalendrier[] =
    filtreCalendrier === 'perso'
      ? []
      : filtrerParGroupe(donnees.evenements, filtreGroupe).map((e) => ({
          sorte: 'groupe' as const,
          id: e.id,
          group_id: e.group_id,
          group_name: e.group_name,
          title: e.title,
          starts_at: e.starts_at,
          ends_at: e.ends_at,
          all_day: e.all_day,
          time_zone: e.time_zone,
          location_name: e.location_name,
          mon_statut: e.mon_statut,
        }));
  const persos: ElementCalendrier[] =
    filtreCalendrier === 'groupes'
      ? []
      : donnees.evenements_perso.map((e) => ({
          sorte: 'perso' as const,
          id: e.id,
          title: e.title,
          starts_at: e.starts_at,
          ends_at: e.ends_at,
          all_day: e.all_day,
          time_zone: e.time_zone,
          location_name: e.location_name,
        }));
  return [...groupes, ...persos].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

/** Les éléments rangés par jour civil ; un événement sur plusieurs jours figure dans chacun. */
export function grouperParJour(elements: readonly ElementCalendrier[]): Map<string, ElementCalendrier[]> {
  const parJour = new Map<string, ElementCalendrier[]>();
  for (const el of elements) {
    for (const jour of joursDe(el)) {
      const duJour = parJour.get(jour);
      if (duJour === undefined) parJour.set(jour, [el]);
      else duJour.push(el);
    }
  }
  return parJour;
}

export function compterSurJours(jours: readonly string[], parJour: ReadonlyMap<string, readonly ElementCalendrier[]>): number {
  return jours.reduce((acc, jour) => acc + (parJour.get(jour)?.length ?? 0), 0);
}

/** Éléments qui commencent aujourd'hui ou plus tard (la liste d'entrée est déjà triée). */
export function evenementsAVenir(elements: readonly ElementCalendrier[], jourActuel: string): ElementCalendrier[] {
  return elements.filter((el) => jourDeDebut(el) >= jourActuel);
}

/** Nombre d'éléments à venir qui tombent dans le mois du jour actuel. */
export function nombreAVenirDuMois(aVenir: readonly ElementCalendrier[], jourActuel: string): number {
  const mois = jourActuel.slice(0, 7);
  return aVenir.filter((el) => jourDeDebut(el).slice(0, 7) === mois).length;
}

export type SensSoldes = 'aucun' | 'positif' | 'negatif' | 'equilibre' | 'multi';

export interface ResumeSoldes {
  /** Total net par devise, dans l'ordre d'apparition. */
  readonly devises: readonly (readonly [string, number])[];
  /** Total de la devise unique ; 0 s'il n'y a pas de solde ou plusieurs devises (on n'additionne jamais deux devises). */
  readonly total: number;
  readonly sens: SensSoldes;
}

export function resumerSoldes(soldes: readonly SoldeEntree[]): ResumeSoldes {
  const parDevise = new Map<string, number>();
  for (const s of soldes) parDevise.set(s.currency_code, (parDevise.get(s.currency_code) ?? 0) + s.net_minor);
  const devises = Array.from(parDevise.entries());
  const unique = devises.length === 1 ? devises[0] : undefined;
  const total = unique?.[1] ?? 0;
  const sens: SensSoldes =
    devises.length === 0 ? 'aucun' : unique === undefined ? 'multi' : total > 0 ? 'positif' : total < 0 ? 'negatif' : 'equilibre';
  return { devises, total, sens };
}

/**
 * Groupe vers lequel mène un lien de CONSULTATION des dépenses : repli sur le premier groupe connu, et non sur la seule
 * cible, qui exige l'absence d'ambiguïté (réservée aux actions de création). `''` s'il n'y a aucun groupe.
 */
export function groupeDesDepenses(
  depenses: readonly AvecGroupe[],
  soldes: readonly AvecGroupe[],
  cible: AvecGroupe | null,
  groupes: readonly AvecGroupe[],
): string {
  return depenses[0]?.group_id ?? soldes[0]?.group_id ?? cible?.group_id ?? groupes[0]?.group_id ?? '';
}

/** Premier groupe à albums actifs : d'abord parmi les groupes visibles, puis parmi tous. */
export function groupeDesPhotos<G extends { readonly photos_actives: boolean }>(
  visibles: readonly G[],
  tous: readonly G[],
): G | undefined {
  return visibles.find((g) => g.photos_actives) ?? tous.find((g) => g.photos_actives);
}
