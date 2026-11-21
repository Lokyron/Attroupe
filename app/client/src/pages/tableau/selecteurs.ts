// Dérivations pures du tableau de bord : aucune dépendance au DOM, à React ni aux textes (testables sous Node).
// Les types d'entrée sont structurels et minimaux : `DonneesTableauDeBord` (api/) les satisfait, et ce fichier
// n'importe rien d'autre que les dates, pour rester chargeable par les tests.
import { ajouterJours, grilleMois, jourDeDebut, joursDe, joursDeSemaine } from '../../agenda/dates.js';
import type { EntreeGrille } from '../../agenda/grille-semaine.js';

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

interface SoldeNomme extends SoldeEntree {
  readonly group_name: string;
}

export type EvenementGroupe = Extract<ElementCalendrier, { sorte: 'groupe' }>;

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
    : `#/agenda/${encodeURIComponent(el.id)}`;
}

/** Un groupe garde la même couleur partout : elle découle de son rang dans la liste. */
export function couleursParGroupe(groupes: readonly AvecGroupe[]): Map<string, CouleurGroupe> {
  const couleurs = new Map<string, CouleurGroupe>();
  groupes.forEach((g, idx) => {
    couleurs.set(g.group_id, COULEURS_GROUPES[idx % COULEURS_GROUPES.length] ?? 'indigo');
  });
  return couleurs;
}

/**
 * Groupe visé par les actions rapides : l'unique groupe de l'utilisateur, sinon celui du filtre. Avec plusieurs
 * groupes et le filtre « Tous », il n'y a pas de cible : `null` plutôt que de deviner.
 */
export function groupeCible<G extends AvecGroupe>(groupes: readonly G[], filtreGroupe: string): G | null {
  return groupes.length === 1 ? (groupes[0] ?? null) : (groupes.find((g) => g.group_id === filtreGroupe) ?? null);
}

/** Événements de groupe et personnels, fusionnés selon l'onglet de source et triés par début. */
export function elementsCalendrier(
  donnees: EvenementsEntree,
  filtreCalendrier: FiltreCalendrier,
): ElementCalendrier[] {
  const groupes: ElementCalendrier[] =
    filtreCalendrier === 'perso'
      ? []
      : donnees.evenements.map((e) => ({
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

/**
 * Adaptateur vers la grille horaire de la semaine : la couleur d'un événement de groupe est celle de son groupe, celle d'un
 * événement personnel est le violet. `titre` reçoit déjà le texte à afficher (le groupe y est nommé par `libelle`).
 */
export function entreesGrilleDepuisElements(
  elements: readonly ElementCalendrier[],
  couleurParGroupe: ReadonlyMap<string, CouleurGroupe>,
  libelle: (el: ElementCalendrier) => string,
): EntreeGrille[] {
  return elements.map(
    (el): EntreeGrille => ({
      cle: `${el.sorte}-${el.id}`,
      titre: libelle(el),
      lien: lienElementCalendrier(el),
      genre: 'evenement',
      couleur: el.sorte === 'perso' ? 'violet' : (couleurParGroupe.get(el.group_id) ?? 'indigo'),
      annule: false,
      all_day: el.all_day,
      starts_at: el.starts_at,
      ends_at: el.ends_at,
      time_zone: el.time_zone,
    }),
  );
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

/**
 * Premier élément pas encore terminé (la liste d'entrée est triée par début) : un événement en cours reste « le prochain ».
 * Une journée entière dure jusqu'à son dernier jour ; un événement à heure fixe jusqu'à `ends_at`, ou à défaut son début.
 */
export function prochainEvenement(
  elements: readonly ElementCalendrier[],
  maintenant: Date,
  jourActuel: string,
): ElementCalendrier | null {
  return nonTermines(elements, maintenant, jourActuel)[0] ?? null;
}

/** Les éléments pas encore terminés (voir `prochainEvenement` pour la règle de fin), dans l'ordre d'entrée. */
export function nonTermines(
  elements: readonly ElementCalendrier[],
  maintenant: Date,
  jourActuel: string,
): ElementCalendrier[] {
  const instant = maintenant.getTime();
  return elements.filter((el) => {
    if (el.all_day) return (joursDe(el).at(-1) ?? jourDeDebut(el)) >= jourActuel;
    const fin = new Date(el.ends_at ?? el.starts_at).getTime();
    return Number.isNaN(fin) ? jourDeDebut(el) >= jourActuel : fin >= instant;
  });
}

/** Nombre de réponses en attente montrées dans le bloc « à traiter » : au-delà, il noierait le reste de l'écran. */
export const MAX_REPONSES_ATTENDUES = 3;

export interface ActionsAttendues {
  /** Invitations à un groupe auxquelles il n'a pas répondu. */
  readonly invitations: number;
  /** Événements de groupe à venir sans réponse de sa part (au plus `MAX_REPONSES_ATTENDUES`, dans l'ordre chronologique). */
  readonly reponses: readonly EvenementGroupe[];
  /** Nombre total d'actions attendues, réponses non montrées comprises. */
  readonly total: number;
}

/**
 * Ce qui attend une action de l'utilisateur, d'après les seules données du tableau de bord : invitations en attente et
 * événements de groupe à venir sans réponse. `exclure` écarte l'événement déjà mis en avant (sa carte porte l'action).
 * Aucune dépense « à valider » n'est détectable : le modèle n'a pas de validation de dépense.
 */
export function actionsAttendues(
  aVenir: readonly ElementCalendrier[],
  invitationsEnAttente: number,
  exclure: ElementCalendrier | null,
): ActionsAttendues {
  const sansReponse = aVenir.filter(
    (el): el is EvenementGroupe =>
      el.sorte === 'groupe' && el.mon_statut === null && !(exclure?.sorte === 'groupe' && exclure.id === el.id),
  );
  const invitations = Math.max(0, invitationsEnAttente);
  return {
    invitations,
    reponses: sansReponse.slice(0, MAX_REPONSES_ATTENDUES),
    total: invitations + sansReponse.length,
  };
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

/** Premier groupe à albums actifs : d'abord parmi les groupes visibles, puis parmi tous. */
export function groupeDesPhotos<G extends { readonly photos_actives: boolean }>(
  visibles: readonly G[],
  tous: readonly G[],
): G | undefined {
  return visibles.find((g) => g.photos_actives) ?? tous.find((g) => g.photos_actives);
}

export interface SoldeGroupe {
  readonly group_id: string;
  readonly group_name: string;
  /** Net par devise, dans l'ordre d'apparition : on n'additionne jamais deux devises. */
  readonly devises: readonly (readonly [string, number])[];
  readonly sens: SensSoldes;
}

/** Un chiffre net par groupe (un par devise si le groupe en compte plusieurs), dans l'ordre d'apparition des groupes. */
export function soldesParGroupe(soldes: readonly SoldeNomme[]): SoldeGroupe[] {
  const parGroupe = new Map<string, SoldeNomme[]>();
  for (const s of soldes) {
    const deLeGroupe = parGroupe.get(s.group_id);
    if (deLeGroupe === undefined) parGroupe.set(s.group_id, [s]);
    else deLeGroupe.push(s);
  }
  return Array.from(parGroupe.values()).flatMap((lignes) => {
    const premiere = lignes[0];
    if (premiere === undefined) return [];
    const { devises, sens } = resumerSoldes(lignes);
    return [{ group_id: premiere.group_id, group_name: premiere.group_name, devises, sens }];
  });
}

export interface PartieSolde {
  readonly devise: string;
  readonly sens: 'positif' | 'negatif' | 'equilibre';
  /** « On vous doit », « Vous devez » ou « À l’équilibre ». */
  readonly etiquette: string;
  /** Montant toujours positif : c'est l'étiquette qui porte le sens, jamais un signe à deviner. */
  readonly montant: string;
}

/** Une partie par devise du groupe, chacune avec son propre sens : « On vous doit 20 € » et « Vous devez 15 $ » ne se mélangent pas. */
export function partiesSolde(
  solde: SoldeGroupe,
  formaterMontant: (montantMineur: number, devise: string) => string,
  etiquettes: Readonly<Record<PartieSolde['sens'], string>>,
): PartieSolde[] {
  return solde.devises.map(([devise, net]) => {
    const sens = net > 0 ? 'positif' : net < 0 ? 'negatif' : 'equilibre';
    return { devise, sens, etiquette: etiquettes[sens], montant: formaterMontant(Math.abs(net), devise) };
  });
}

/**
 * Date d'un événement en toutes lettres : « Aujourd’hui · 20:00 », « Demain · 20:00 », sinon « vendredi 20 mars · 20:00 ».
 * Le jour est celui de l'événement dans son fuseau (`jourDeDebut`), lu en UTC pour ne pas glisser selon le navigateur.
 */
export function dateEnClair(
  el: ElementCalendrier,
  jourAujourdHui: string,
  libelles: { readonly aujourdhui: string; readonly demain: string; readonly horaire: string },
): string {
  const jour = jourDeDebut(el);
  if (jour === jourAujourdHui) return `${libelles.aujourdhui} · ${libelles.horaire}`;
  if (jour === ajouterJours(jourAujourdHui, 1)) return `${libelles.demain} · ${libelles.horaire}`;
  const date = new Date(`${jour}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return jour;
  const enToutesLettres = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(date);
  return `${enToutesLettres} · ${libelles.horaire}`;
}
