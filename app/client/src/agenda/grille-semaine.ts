// Placement de la grille horaire de la semaine. Logique pure, sans DOM ni React ni texte : le composant
// `components/GrilleSemaine.tsx` ne fait que dessiner ce que calculent ces fonctions (testées sous Node).
// Les minutes sont celles de l'heure murale dans le fuseau de l'événement, comme les jours du reste de l'agenda.
// Deux limites connues et assumées de toute grille en heure murale (voir les tests « changement d'heure ») :
//  - en octobre, l'heure de 02 h à 03 h existe deux fois : deux événements disjoints placés dans cette heure répétée
//    ont les mêmes minutes murales et s'affichent côte à côte, comme s'ils se chevauchaient ;
//  - un créneau de 02h30 (heure d'été) à 02h15 (heure d'hiver) dure réellement 45 min mais finit « avant » de commencer
//    sur la grille : il est traité comme un créneau de durée minimale.
import { heureLocaleDepuisInstant, type EvenementDates } from './dates.js';

export type CouleurGrille = 'indigo' | 'cyan' | 'violet' | 'emeraude' | 'ambre' | 'rose';

/**
 * Ce que la grille sait dessiner. Les deux surfaces (page agenda du groupe, tableau de bord) ont des données de
 * formes différentes : chacune est ramenée à ce type par un adaptateur, la grille ne connaît pas les autres.
 */
export interface EntreeGrille extends EvenementDates {
  /** Clé stable et unique dans la grille. */
  readonly cle: string;
  readonly titre: string;
  /** `null` : l'entrée n'est pas cliquable (créneau « occupé » d'un membre). */
  readonly lien: string | null;
  readonly genre: 'evenement' | 'occupe';
  readonly couleur: CouleurGrille;
  readonly annule: boolean;
}

export const MINUTES_PAR_JOUR = 1440;
/** Durée prêtée à un événement sans fin. */
export const DUREE_DEFAUT_MIN = 60;
/**
 * Durée minimale d'un bloc : à 3,5 rem par heure (`--grille-hauteur-heure`), 48 min font 44,8 px, soit la cible tactile
 * minimale. Elle compte aussi dans le calcul des chevauchements : un bloc grossi qui en recouvre un autre doit lui céder la largeur.
 * C'est la SEULE source de la hauteur minimale : la feuille de style n'en pose pas (la hauteur d'un bloc vient de `--hauteur`).
 * Prêtée aussi à un événement dont la fin n'est pas postérieure au début (durée nulle, ou fin antérieure à cause d'un changement d'heure).
 */
export const DUREE_MINIMALE_MIN = 48;
/** Heures affichées au moins, même sans événement (début inclus, fin exclue). */
export const PLAGE_DEFAUT: PlageHoraire = { debut: 8, fin: 22 };
/** Au-delà, la bande « journée entière » défile plutôt que de manger l'écran. */
export const LIGNES_BANDE_MAX = 3;

export interface PlageHoraire {
  readonly debut: number;
  readonly fin: number;
}

export type CreneauJour = { readonly type: 'journee' } | { readonly type: 'horaire'; readonly debut: number; readonly fin: number };

export interface BlocPlace {
  readonly entree: EntreeGrille;
  /** Début et fin réels dans le jour, en minutes depuis minuit (bornés à ce jour). */
  readonly debut: number;
  readonly fin: number;
  /** Position verticale (toujours l'heure de début) et hauteur affichées, en minutes (hauteur minimale appliquée : peut dépasser minuit). */
  readonly decalage: number;
  readonly hauteur: number;
  /** Rang de la colonne (à partir de 0) parmi `colonnes` colonnes qui se partagent la largeur du jour. */
  readonly colonne: number;
  readonly colonnes: number;
}

export interface JourPlace {
  readonly jour: string;
  /** Entrées sur la journée entière, pour la bande du haut. */
  readonly journee: readonly EntreeGrille[];
  /** Entrées horaires, triées par début. */
  readonly blocs: readonly BlocPlace[];
}

export interface SemainePlacee {
  readonly jours: readonly JourPlace[];
  readonly plage: PlageHoraire;
  /** Hauteur de la bande « journée entière », en lignes (0 : pas de bande). */
  readonly lignesBande: number;
}

/** Début et fin en « heure murale » (lue comme de l'UTC) ; calculés une fois par entrée, car Intl coûte cher. */
interface Mural {
  readonly debut: number;
  readonly fin: number;
}

const muraux = new WeakMap<EvenementDates, Mural>();

function muralDe(e: EvenementDates): Mural {
  const connu = muraux.get(e);
  if (connu !== undefined) return connu;
  const debut = Date.parse(`${heureLocaleDepuisInstant(e.starts_at, e.time_zone)}:00Z`);
  const finBrute = e.ends_at === null ? Number.NaN : Date.parse(`${heureLocaleDepuisInstant(e.ends_at, e.time_zone)}:00Z`);
  const dureeSansFin = e.ends_at === null ? DUREE_DEFAUT_MIN : DUREE_MINIMALE_MIN;
  const mural = {
    debut,
    fin: finBrute > debut ? finBrute : debut + dureeSansFin * 60_000,
  };
  muraux.set(e, mural);
  return mural;
}

/**
 * Part du jour (`AAAA-MM-JJ`) que couvre l'entrée : `null` si elle ne le touche pas, `journee` si elle l'occupe en entier
 * (événement « toute la journée », ou créneau horaire qui commence avant minuit et finit après), sinon ses minutes bornées.
 */
export function creneauDuJour(e: EvenementDates, jour: string): CreneauJour | null {
  if (e.all_day) {
    const fin = e.ends_at !== null && e.ends_at > e.starts_at ? e.ends_at : e.starts_at;
    return jour >= e.starts_at && jour <= fin ? { type: 'journee' } : null;
  }
  const minuit = Date.parse(`${jour}T00:00:00Z`);
  const { debut: debutMural, fin: finMurale } = muralDe(e);
  const debut = Math.max(0, (debutMural - minuit) / 60_000);
  const fin = Math.min(MINUTES_PAR_JOUR, (finMurale - minuit) / 60_000);
  if (fin <= debut) return null;
  if (debut === 0 && fin === MINUTES_PAR_JOUR) return { type: 'journee' };
  return { type: 'horaire', debut, fin };
}

/**
 * Place les entrées d'un jour. Deux entrées qui se recouvrent se partagent la largeur : on découpe le jour en groupes de
 * blocs liés par des recouvrements, et dans chaque groupe chaque bloc prend la première colonne libre. Tous les blocs d'un
 * groupe ont le même nombre de colonnes, pour que leurs largeurs s'alignent.
 */
export function placerJour(entrees: readonly EntreeGrille[], jour: string): JourPlace {
  const journee: EntreeGrille[] = [];
  const horaires: {
    entree: EntreeGrille;
    debut: number;
    fin: number;
    decalage: number;
    hauteur: number;
  }[] = [];
  for (const entree of entrees) {
    const creneau = creneauDuJour(entree, jour);
    if (creneau === null) continue;
    if (creneau.type === 'journee') {
      journee.push(entree);
      continue;
    }
    const hauteur = Math.max(creneau.fin - creneau.debut, DUREE_MINIMALE_MIN);
    horaires.push({
      entree,
      debut: creneau.debut,
      fin: creneau.fin,
      // Le haut du bloc reste à l'heure de début réelle ; un bloc de fin de journée dépasse plutôt que de remonter et mentir.
      decalage: creneau.debut,
      hauteur,
    });
  }
  horaires.sort((a, b) => a.decalage - b.decalage || b.hauteur - a.hauteur || a.entree.cle.localeCompare(b.entree.cle));

  const blocs: BlocPlace[] = [];
  let groupe: {
    entree: EntreeGrille;
    debut: number;
    fin: number;
    decalage: number;
    hauteur: number;
    colonne: number;
  }[] = [];
  let finsColonnes: number[] = [];
  const clore = (): void => {
    for (const b of groupe) blocs.push({ ...b, colonnes: finsColonnes.length });
    groupe = [];
    finsColonnes = [];
  };
  for (const h of horaires) {
    // Le groupe se ferme quand le bloc suivant commence après la fin de tout ce qui précède.
    if (finsColonnes.length > 0 && h.decalage >= Math.max(...finsColonnes)) clore();
    let colonne = finsColonnes.findIndex((fin) => fin <= h.decalage);
    if (colonne === -1) colonne = finsColonnes.length;
    finsColonnes[colonne] = h.decalage + h.hauteur;
    groupe.push({ ...h, colonne });
  }
  clore();
  return { jour, journee, blocs };
}

/** Heures à afficher : la plage par défaut, élargie pour que tout bloc de la semaine soit visible sans défilement. */
export function plageUtile(blocs: readonly Pick<BlocPlace, 'decalage' | 'hauteur'>[], defaut: PlageHoraire = PLAGE_DEFAUT): PlageHoraire {
  let debut = defaut.debut;
  let fin = defaut.fin;
  for (const b of blocs) {
    debut = Math.min(debut, Math.floor(b.decalage / 60));
    // Un bloc de fin de journée peut dépasser minuit (hauteur minimale) : la plage s'arrête à 24 h, le surplus défile.
    fin = Math.max(fin, Math.min(24, Math.ceil((b.decalage + b.hauteur) / 60)));
  }
  return { debut, fin };
}

/** Tout ce que le composant dessine pour une semaine : les jours placés, la plage utile, la hauteur de la bande. */
export function composerSemaine(semaine: readonly string[], entrees: readonly EntreeGrille[]): SemainePlacee {
  const jours = semaine.map((jour) => placerJour(entrees, jour));
  const plage = plageUtile(jours.flatMap((j) => j.blocs));
  const lignesBande = Math.min(LIGNES_BANDE_MAX, Math.max(0, ...jours.map((j) => j.journee.length)));
  return { jours, plage, lignesBande };
}

/** Jour affiché (rang dans la semaine) d'après le défilement horizontal, quand les jours défilent un par un. */
export function indexJourVisible(defilement: number, largeurJour: number, nbJours: number): number {
  if (largeurJour <= 0 || nbJours <= 0) return 0;
  return Math.min(nbJours - 1, Math.max(0, Math.round(defilement / largeurJour)));
}

/** Vrai si la semaine n'a ni événement horaire ni journée entière : le composant affiche alors l'état vide. */
export function semaineVide(semaine: SemainePlacee): boolean {
  return semaine.jours.every((j) => j.journee.length === 0 && j.blocs.length === 0);
}

/** Marge laissée au-dessus de l'heure visée à l'ouverture, pour ne pas la coller au haut de la grille. */
export const MARGE_CALAGE_MIN = 60;

/**
 * Début (minutes depuis minuit) du premier bloc horaire du jour de rang `index`, ou de toute la semaine si `index` est `null`
 * (jours côte à côte). `null` s'il n'y a aucun bloc horaire.
 */
export function premierDebut(jours: readonly JourPlace[], index: number | null): number | null {
  const debuts = (index === null ? jours : jours.slice(index, index + 1)).flatMap((j) => j.blocs.map((b) => b.decalage));
  return debuts.length === 0 ? null : Math.min(...debuts);
}

/**
 * Minute (depuis minuit) qui doit se trouver en haut de la grille à l'ouverture : l'heure courante si la semaine contient
 * aujourd'hui (`heureCourante` non nul), sinon le premier événement affiché, à défaut le début de la plage utile ; moins
 * une marge d'une heure. Bornée à la plage, et pour que la fin de la plage reste visible quand `minutesVisibles` la couvre.
 * On ne s'appuie PAS seulement sur le début de la plage : un événement sans fin tard le soir la fait déborder jusqu'à minuit.
 */
export function minuteDeCalage(
  plage: PlageHoraire,
  heureCourante: number | null,
  premierEvenement: number | null,
  minutesVisibles: number,
): number {
  const haut = plage.debut * 60;
  const bas = Math.max(haut, plage.fin * 60 - Math.max(0, minutesVisibles));
  const visee = (heureCourante ?? premierEvenement ?? haut) - MARGE_CALAGE_MIN;
  return Math.min(bas, Math.max(haut, visee));
}
