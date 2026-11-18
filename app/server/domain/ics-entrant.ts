// Analyseur iCalendar (RFC 5545) ENTRANT : l'agenda externe d'un utilisateur (Google Agenda, Outlook), dont on déduit des
// plages « occupé ». Logique PURE : ni base, ni Express, ni réseau.
//
// Principes :
//  - chaque VEVENT donne ses plages UNE PAR UNE (aucune fusion), avec son titre, sa description et son lieu quand il en a :
//    le PROPRIÉTAIRE doit pouvoir relire ses rendez-vous (ADR-0013, révision du 2026-11-18). Ce module ne décide pas qui voit
//    quoi : c'est au stockage et aux requêtes de groupe de ne montrer aux autres membres que « occupé » ;
//  - on ne DEVINE jamais une occupation, et on ne masque jamais en silence une occupation qu'on n'a pas su lire : un VEVENT
//    dont une propriété utile est illisible ou non prise en charge est ÉCARTÉ EN ENTIER et compté dans `ignores` ;
//  - l'entrée vient d'un tiers potentiellement hostile : TOUTE boucle est plafonnée (voir `PLAFONDS`) et un budget de temps
//    coupe le reste. Un dépassement lève `ErreurIcsTropGros`, jamais un résultat tronqué.
//
// Les récurrences sont évaluées par PRÉDICAT : l'horizon est fini, on parcourt les jours depuis `DTSTART` (nécessaire pour
// `COUNT`) et on demande « ce jour correspond-il à la règle ? ». Le calcul se fait en HEURE MURALE (la réunion de 9 h reste à
// 9 h de part et d'autre d'un changement d'heure) ; chaque occurrence est ensuite convertie en instant via `Intl`.
//
// Format de sortie : un horodaté est un instant `…Z` ; une journée entière est une DATE `AAAA-MM-JJ` et `fin` est le DERNIER
// jour inclus (comme en base, modèle de données §« all_day » : `DTEND − 1 jour`).

import { JOUR_MS, versInstant } from './instant.js';

export interface PlageOccupee {
  /** Instant `AAAA-MM-JJTHH:MM:SSZ`, ou date `AAAA-MM-JJ` si `journeeEntiere`. */
  readonly debut: string;
  /** Même format que `debut` ; pour une journée entière, le DERNIER jour inclus. */
  readonly fin: string;
  readonly journeeEntiere: boolean;
  /** `SUMMARY` de l'événement, tronqué à 140 caractères. Absent si le `VEVENT` n'en a pas. */
  readonly titre?: string;
  /** `DESCRIPTION`, tronquée à 2000 caractères. */
  readonly description?: string;
  /** `LOCATION`, tronqué à 140 caractères. */
  readonly lieu?: string;
}

export interface OptionsAnalyse {
  /** On ignore tout ce qui finit avant. */
  readonly horizonDebut: Date;
  /** On ignore tout ce qui commence après. */
  readonly horizonFin: Date;
  /** Fuseau du profil : heures flottantes, journées entières, repli des TZID inconnus. */
  readonly fuseauParDefaut: string;
}

export interface ResultatAnalyse {
  readonly plages: readonly PlageOccupee[];
  /** VEVENT non pris en charge, comptés et non devinés. */
  readonly ignores: number;
  /** Clés stables, ex. `fuseau_inconnu`. */
  readonly avertissements: readonly string[];
}

export const PLAFONDS = {
  /** VEVENT analysés. */
  evenements: 5000,
  /** Occurrences d'une même règle dans la fenêtre d'horizon (et valeurs de RDATE). */
  occurrences: 1000,
  /** Plages rendues. Sans fusion, c'est la seule borne du nombre de plages. */
  plages: 5000,
  /** Plages brutes, toutes règles confondues (protège la mémoire ; le budget de temps ne la borne pas assez vite). */
  plagesBrutes: 200_000,
  /** Texte cumulé (titres + descriptions + lieux, en caractères) des plages écrites : il sera stocké, chiffré, plage par plage. */
  texte: 2_000_000,
  /** Jours candidats parcourus pour UNE règle (de `DTSTART` à la fin de l'horizon : ~270 ans). */
  iterations: 100_000,
  /** Budget de temps, en ms. */
  tempsMs: 5000,
  /** Profondeur d'imbrication des composants. */
  profondeur: 8,
} as const;

/** Longueurs maximales des textes, en unités UTF-16, après déséchappement (alignées sur les créneaux saisis à la main). */
export const LIMITES_TEXTE = { titre: 140, description: 2000, lieu: 140 } as const;
/** On relit l'horloge toutes les N vérifications seulement. */
const PERIODE_HORLOGE = 256;
const ANNEE_MIN = 1900;
const ANNEE_MAX = 2200;
const MAX_LISTE = 366;
const MAX_INTERVALLE = 10_000;

export class ErreurIcsIllisible extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurIcsIllisible';
  }
}

export type PlafondDepasse = 'evenements' | 'occurrences' | 'plages' | 'plagesBrutes' | 'texte' | 'iterations' | 'temps';

export class ErreurIcsTropGros extends Error {
  readonly plafond: PlafondDepasse;
  constructor(plafond: PlafondDepasse) {
    super(`Calendrier trop volumineux (plafond « ${plafond} » dépassé).`);
    this.name = 'ErreurIcsTropGros';
    this.plafond = plafond;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Budget de temps
// ---------------------------------------------------------------------------------------------------------------------

interface Budget {
  verifier(): void;
}

function nouveauBudget(): Budget {
  const echeance = performance.now() + PLAFONDS.tempsMs;
  let appels = 0;
  return {
    verifier(): void {
      appels += 1;
      if (appels % PERIODE_HORLOGE === 0 && performance.now() > echeance) throw new ErreurIcsTropGros('temps');
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Lignes : dépliage, découpage
// ---------------------------------------------------------------------------------------------------------------------

interface Ligne {
  readonly nom: string;
  readonly params: ReadonlyMap<string, string>;
  readonly valeur: string;
}

/**
 * Dépliage (RFC 5545 §3.1) : une ligne qui commence par une espace ou une tabulation prolonge la précédente. Fait AVANT toute
 * interprétation : un pli peut tomber au milieu d'un caractère UTF-8, ou au milieu d'une valeur de paramètre entre guillemets.
 */
function lignesLogiques(texte: string): string[] {
  const sansBom = texte.charCodeAt(0) === 0xfeff ? texte.slice(1) : texte;
  const sortie: string[] = [];
  for (const brute of sansBom.split(/\r\n|\n|\r/)) {
    const premier = brute.charAt(0);
    const dernier = sortie.length - 1;
    if ((premier === ' ' || premier === '\t') && dernier >= 0) sortie[dernier] += brute.slice(1);
    else sortie.push(brute);
  }
  return sortie;
}

/** `NOM;PARAM=valeur;P2="a:b,c":VALEUR`. Les guillemets protègent `:` et `;`. `null` si la ligne n'a pas de `:`. */
function lireLigne(ligne: string): Ligne | null {
  const coupures: number[] = [];
  let guillemets = false;
  let deuxPoints = -1;
  for (let i = 0; i < ligne.length; i += 1) {
    const c = ligne.charAt(i);
    if (c === '"') guillemets = !guillemets;
    else if (!guillemets) {
      if (c === ';') coupures.push(i);
      else if (c === ':') {
        deuxPoints = i;
        break;
      }
    }
  }
  if (deuxPoints < 0) return null;
  const finNom = coupures[0] ?? deuxPoints;
  const params = new Map<string, string>();
  for (let k = 0; k < coupures.length; k += 1) {
    const debut = (coupures[k] ?? 0) + 1;
    const fin = coupures[k + 1] ?? deuxPoints;
    const segment = ligne.slice(debut, fin);
    const egal = segment.indexOf('=');
    if (egal <= 0) continue;
    const cle = segment.slice(0, egal).trim().toUpperCase();
    if (!params.has(cle)) params.set(cle, segment.slice(egal + 1).replace(/"/g, ''));
  }
  return { nom: ligne.slice(0, finNom).trim().toUpperCase(), params, valeur: ligne.slice(deuxPoints + 1) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Textes (SUMMARY, DESCRIPTION, LOCATION)
// ---------------------------------------------------------------------------------------------------------------------

/** Déséchappement d'une valeur TEXT (RFC 5545 §3.3.11) : `\n`/`\N` → saut de ligne ; `\\`, `\,`, `\;` → le caractère. */
function desechapper(valeur: string): string {
  return valeur.replace(/\\([\\;,nN])/g, (_tout, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Coupe à `max` unités UTF-16 sans scinder une paire de substitution. */
function tronquer(texte: string, max: number): string {
  if (texte.length <= max) return texte;
  const dernier = texte.charCodeAt(max - 1);
  const fin = dernier >= 0xd800 && dernier <= 0xdbff ? max - 1 : max; // le cut tomberait entre les deux moitiés
  return texte.slice(0, fin);
}

/**
 * Valeur TEXT → texte propre, ou `undefined` s'il est vide après nettoyage. Ordre : déséchapper, retirer les caractères de
 * contrôle, couper les blancs, PUIS tronquer (jamais avant : un `\,` coupé en deux fausserait la longueur).
 * Hors description, un saut de ligne devient une espace (« A\nB » ne devient pas « AB »).
 */
function nettoyerTexte(valeur: string | null, max: number, multiligne: boolean): string | undefined {
  if (valeur === null) return undefined;
  let texte = desechapper(valeur);
  if (!multiligne) texte = texte.replace(/\n/g, ' ');
  texte = texte.replace(/\p{Cc}/gu, (c) => (c === '\n' ? c : '')).trim(); // Cc : C0, DEL et C1 (tabulation comprise)
  const coupe = tronquer(texte, max).trimEnd();
  return coupe === '' ? undefined : coupe;
}

interface Textes {
  readonly titre?: string;
  readonly description?: string;
  readonly lieu?: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fuseaux
// ---------------------------------------------------------------------------------------------------------------------

const formateurs = new Map<string, Intl.DateTimeFormat | null>();

/** Le formateur d'un fuseau IANA, ou `null` s'il est inconnu d'`Intl` (noms Windows d'Outlook, « Customized Time Zone »). */
function formateurDe(fuseau: string): Intl.DateTimeFormat | null {
  const connu = formateurs.get(fuseau);
  if (connu !== undefined) return connu;
  let formateur: Intl.DateTimeFormat | null;
  try {
    formateur = new Intl.DateTimeFormat('en-US', {
      timeZone: fuseau,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch (erreur) {
    if (!(erreur instanceof RangeError)) throw erreur;
    formateur = null;
  }
  if (formateurs.size >= 500) formateurs.clear(); // les noms viennent d'un tiers : la mémoire reste bornée
  formateurs.set(fuseau, formateur);
  return formateur;
}

/** Décalage (ms) du fuseau à l'instant `t` : heure murale moins instant. */
function decalage(t: number, fuseau: string): number {
  const formateur = formateurDe(fuseau);
  if (formateur === null) throw new RangeError(`Fuseau inconnu : « ${fuseau} ».`);
  const v: Record<string, number> = {};
  for (const partie of formateur.formatToParts(new Date(t))) {
    if (partie.type !== 'literal') v[partie.type] = Number(partie.value);
  }
  const mur = Date.UTC(v['year'] ?? 0, (v['month'] ?? 1) - 1, v['day'] ?? 1, v['hour'] ?? 0, v['minute'] ?? 0, v['second'] ?? 0);
  return mur - Math.floor(t / 1000) * 1000;
}

/**
 * Heure murale (exprimée comme un « instant UTC » : `Date.UTC` des champs) → vrai instant dans `fuseau`.
 *
 * Deux cas de changement d'heure, tranchés DÉTERMINISTEMENT :
 *  - heure qui existe DEUX fois (fin d'heure d'été) : on retient le PREMIER décalage, c'est-à-dire la première occurrence
 *    de l'heure murale (l'instant le plus tôt, avec le décalage d'été, le plus grand) ;
 *  - heure qui n'existe PAS (début d'heure d'été) : on applique le décalage d'AVANT la transition (RFC 5545 §3.3.5), donc
 *    02:30 devient 03:30 locale.
 */
function murVersInstant(mur: number, fuseau: string): number {
  if (fuseau === 'UTC') return mur;
  const avant = decalage(mur - JOUR_MS, fuseau);
  const apres = decalage(mur + JOUR_MS, fuseau);
  const valides = [...new Set([avant, apres])].filter((d) => decalage(mur - d, fuseau) === d);
  if (valides.length === 0) return mur - avant;
  return Math.min(...valides.map((d) => mur - d));
}

// ---------------------------------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------------------------------

interface Contexte {
  readonly fuseauParDefaut: string;
  readonly avertissements: Set<string>;
}

interface ValeurDate {
  readonly journee: boolean;
  /** Heure murale (ms, comme `Date.UTC`) ; pour un `…Z`, l'instant lui-même (fuseau `UTC`). */
  readonly mur: number;
  readonly fuseau: string;
  readonly utc: boolean;
}

const jourDe = (ms: number): number => Math.floor(ms / JOUR_MS);

function construire(a: number, m: number, j: number, h: number, mi: number, s: number): number | null {
  if (a < ANNEE_MIN || a > ANNEE_MAX || h > 23 || mi > 59 || s > 59) return null;
  const ms = Date.UTC(a, m - 1, j, h, mi, s);
  const d = new Date(ms);
  // Aller-retour : « 30 février » ou « mois 13 » ne se normalisent pas en silence.
  if (d.getUTCFullYear() !== a || d.getUTCMonth() !== m - 1 || d.getUTCDate() !== j) return null;
  return ms;
}

/** `20270320`, `20270320T180000` ou `20270320T180000Z`. `null` si illisible (y compris `VALUE=PERIOD`). */
function lireDate(valeur: string, params: ReadonlyMap<string, string>, ctx: Contexte): ValeurDate | null {
  const v = valeur.trim();
  const type = params.get('VALUE')?.toUpperCase();
  if (type !== undefined && type !== 'DATE' && type !== 'DATE-TIME') return null;
  const jourSeul = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (jourSeul !== null && type !== 'DATE-TIME') {
    const mur = construire(Number(jourSeul[1]), Number(jourSeul[2]), Number(jourSeul[3]), 0, 0, 0);
    return mur === null ? null : { journee: true, mur, fuseau: ctx.fuseauParDefaut, utc: false };
  }
  const horaire = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (horaire === null || type === 'DATE') return null;
  const mur = construire(
    Number(horaire[1]), Number(horaire[2]), Number(horaire[3]), Number(horaire[4]), Number(horaire[5]), Number(horaire[6]),
  );
  if (mur === null) return null;
  if (horaire[7] === 'Z') return { journee: false, mur, fuseau: 'UTC', utc: true };
  const tzid = params.get('TZID');
  if (tzid === undefined || tzid === '') return { journee: false, mur, fuseau: ctx.fuseauParDefaut, utc: false };
  if (formateurDe(tzid) !== null) return { journee: false, mur, fuseau: tzid, utc: false };
  ctx.avertissements.add('fuseau_inconnu'); // repli sur le fuseau du profil
  return { journee: false, mur, fuseau: ctx.fuseauParDefaut, utc: false };
}

const instantDe = (d: ValeurDate): number => murVersInstant(d.mur, d.fuseau);

/** `DURATION` → ms ; `null` si illisible ou négative. */
function lireDuree(valeur: string): number | null {
  const m = valeur.trim().toUpperCase().match(/^([+-])?P(?:(\d{1,6})W)?(?:(\d{1,6})D)?(?:T(?:(\d{1,6})H)?(?:(\d{1,6})M)?(?:(\d{1,6})S)?)?$/);
  if (m === null || m[1] === '-') return null;
  if (m.slice(2).every((x) => x === undefined)) return null;
  const n = (i: number): number => Number(m[i] ?? 0);
  return (((n(2) * 7 + n(3)) * 24 + n(4)) * 60 + n(5)) * 60_000 + n(6) * 1000;
}

// ---------------------------------------------------------------------------------------------------------------------
// Règles de récurrence
// ---------------------------------------------------------------------------------------------------------------------

type Frequence = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

interface JourSemaine {
  /** 0 = pas d'ordinal ; `2` = deuxième, `-1` = dernier. */
  readonly ordinal: number;
  /** 0 = dimanche. */
  readonly jour: number;
}

interface Regle {
  readonly frequence: Frequence;
  readonly intervalle: number;
  readonly compte: number | null;
  readonly until: ValeurDate | null;
  readonly parJourSemaine: readonly JourSemaine[];
  readonly parJourMois: readonly number[];
  readonly parMois: readonly number[];
  readonly debutSemaine: number;
}

const CODES_JOUR: Readonly<Record<string, number>> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function entiers(liste: string, min: number, max: number, interdit0: boolean): number[] | null {
  const morceaux = liste.split(',');
  if (morceaux.length > MAX_LISTE) return null;
  const sortie: number[] = [];
  for (const morceau of morceaux) {
    if (!/^[+-]?\d{1,3}$/.test(morceau)) return null;
    const n = Number(morceau);
    if (n < min || n > max || (interdit0 && n === 0)) return null;
    sortie.push(n);
  }
  return sortie;
}

/**
 * `null` = règle non prise en charge ou illisible : le VEVENT est écarté et compté. Sont refusés : une clé hors liste
 * (BYSETPOS, BYWEEKNO, BYYEARDAY, BYHOUR…), une fréquence infra-journalière, une clé répétée, un ordinal hors MONTHLY/YEARLY.
 */
function lireRegle(texte: string, ctx: Contexte): Regle | null {
  const cles = new Map<string, string>();
  for (const segment of texte.split(';')) {
    const egal = segment.indexOf('=');
    if (egal <= 0) return null;
    const cle = segment.slice(0, egal).trim().toUpperCase();
    if (cles.has(cle)) return null;
    cles.set(cle, segment.slice(egal + 1).trim());
  }
  const permises = ['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST'];
  if ([...cles.keys()].some((c) => !permises.includes(c))) return null;

  const freq = cles.get('FREQ')?.toUpperCase();
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;

  let intervalle = 1;
  const brutIntervalle = cles.get('INTERVAL');
  if (brutIntervalle !== undefined) {
    if (!/^\d{1,5}$/.test(brutIntervalle)) return null;
    intervalle = Number(brutIntervalle);
    if (intervalle < 1 || intervalle > MAX_INTERVALLE) return null;
  }

  let compte: number | null = null;
  const brutCompte = cles.get('COUNT');
  if (brutCompte !== undefined) {
    if (!/^\d{1,9}$/.test(brutCompte)) return null;
    compte = Number(brutCompte);
    if (compte < 1) return null;
  }

  let until: ValeurDate | null = null;
  const brutUntil = cles.get('UNTIL');
  if (brutUntil !== undefined) {
    until = lireDate(brutUntil, new Map(), ctx);
    if (until === null) return null;
  }

  const parJourSemaine: JourSemaine[] = [];
  const brutJours = cles.get('BYDAY');
  if (brutJours !== undefined) {
    const morceaux = brutJours.toUpperCase().split(',');
    if (morceaux.length > MAX_LISTE) return null;
    for (const morceau of morceaux) {
      const m = morceau.match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/);
      if (m === null) return null;
      const ordinal = m[1] === undefined ? 0 : Number(m[1]);
      if (m[1] !== undefined && (ordinal === 0 || Math.abs(ordinal) > 53)) return null;
      if (ordinal !== 0 && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;
      parJourSemaine.push({ ordinal, jour: CODES_JOUR[m[2] ?? ''] ?? 0 });
    }
  }

  let parJourMois: number[] = [];
  const brutJoursMois = cles.get('BYMONTHDAY');
  if (brutJoursMois !== undefined) {
    const liste = entiers(brutJoursMois, -31, 31, true);
    if (liste === null) return null;
    parJourMois = liste;
  }

  let parMois: number[] = [];
  const brutMois = cles.get('BYMONTH');
  if (brutMois !== undefined) {
    const liste = entiers(brutMois, 1, 12, true);
    if (liste === null) return null;
    parMois = liste;
  }

  let debutSemaine = 1;
  const brutWkst = cles.get('WKST');
  if (brutWkst !== undefined) {
    const code = CODES_JOUR[brutWkst.toUpperCase()];
    if (code === undefined) return null;
    debutSemaine = code;
  }

  return { frequence: freq, intervalle, compte, until, parJourSemaine, parJourMois, parMois, debutSemaine };
}

interface Civil {
  readonly annee: number;
  readonly mois: number;
  readonly jour: number;
  readonly jourSemaine: number;
}

function civil(jour: number): Civil {
  const d = new Date(jour * JOUR_MS);
  return { annee: d.getUTCFullYear(), mois: d.getUTCMonth() + 1, jour: d.getUTCDate(), jourSemaine: d.getUTCDay() };
}

const joursDansMois = (annee: number, mois: number): number => new Date(Date.UTC(annee, mois, 0)).getUTCDate();

/** Le jour (`jour`) est-il le `ordinal`-ième `jourSemaine` de sa période (mois ou année) ? */
function ordinalCorrespond(ordinal: number, rang: number, restant: number): boolean {
  // `rang` : 0 pour le premier jour de la période ; `restant` : jours entre ce jour et la fin de la période.
  return ordinal > 0 ? Math.floor(rang / 7) + 1 === ordinal : Math.floor(restant / 7) + 1 === -ordinal;
}

function jourSemaineCorrespond(regle: Regle, j: number, c: Civil): boolean {
  return regle.parJourSemaine.some((e) => {
    if (e.jour !== c.jourSemaine) return false;
    if (e.ordinal === 0) return true;
    if (regle.frequence === 'YEARLY' && regle.parMois.length === 0) {
      const debutAnnee = Date.UTC(c.annee, 0, 1) / JOUR_MS;
      const finAnnee = Date.UTC(c.annee + 1, 0, 1) / JOUR_MS - 1;
      return ordinalCorrespond(e.ordinal, j - debutAnnee, finAnnee - j);
    }
    return ordinalCorrespond(e.ordinal, c.jour - 1, joursDansMois(c.annee, c.mois) - c.jour);
  });
}

function jourMoisCorrespond(regle: Regle, c: Civil): boolean {
  const dernier = joursDansMois(c.annee, c.mois);
  return regle.parJourMois.some((v) => (v > 0 ? c.jour === v : c.jour === dernier + v + 1));
}

/** Le jour `j` (≥ `j0`, le jour de `DTSTART`) appartient-il à la série ? */
function correspond(regle: Regle, j: number, j0: number, c0: Civil): boolean {
  const c = civil(j);
  const intervalle = regle.intervalle;
  switch (regle.frequence) {
    case 'DAILY':
      if ((j - j0) % intervalle !== 0) return false;
      break;
    case 'WEEKLY': {
      const debutSemaine = (x: number, jourSemaine: number): number => x - ((jourSemaine - regle.debutSemaine + 7) % 7);
      const ecart = debutSemaine(j, c.jourSemaine) - debutSemaine(j0, c0.jourSemaine);
      if ((ecart / 7) % intervalle !== 0) return false;
      break;
    }
    case 'MONTHLY':
      if (((c.annee - c0.annee) * 12 + (c.mois - c0.mois)) % intervalle !== 0) return false;
      break;
    case 'YEARLY':
      if ((c.annee - c0.annee) % intervalle !== 0) return false;
      break;
  }
  if (regle.parMois.length > 0 && !regle.parMois.includes(c.mois)) return false;
  const aJourSemaine = regle.parJourSemaine.length > 0;
  const aJourMois = regle.parJourMois.length > 0;
  if (!aJourSemaine && !aJourMois) {
    // Jour implicite : celui de DTSTART.
    if (regle.frequence === 'WEEKLY') return c.jourSemaine === c0.jourSemaine;
    if (regle.frequence === 'MONTHLY') return c.jour === c0.jour;
    if (regle.frequence === 'YEARLY') return c.jour === c0.jour && (regle.parMois.length > 0 || c.mois === c0.mois);
    return true;
  }
  if (aJourSemaine && !jourSemaineCorrespond(regle, j, c)) return false;
  if (aJourMois && !jourMoisCorrespond(regle, c)) return false;
  return true;
}

/** `true` si l'occurrence (jour `j`, heure murale `mur`) dépasse `UNTIL`. */
function apresUntil(until: ValeurDate, mur: number, fuseau: string): boolean {
  if (!until.utc) {
    // `UNTIL` flottant ou date : comparaison en heure murale ; une date couvre toute sa journée.
    return mur > (until.journee ? until.mur + JOUR_MS - 1 : until.mur);
  }
  // `UNTIL` en UTC : on ne convertit (coûteux) que dans la zone où la réponse dépend du fuseau.
  if (mur > until.mur + 2 * JOUR_MS) return true;
  if (mur < until.mur - 2 * JOUR_MS) return false;
  return murVersInstant(mur, fuseau) > until.mur;
}

/**
 * Jours (indices depuis 1970) des occurrences de la série dans [`premier`, `dernier`]. `COUNT` compte depuis DTSTART : sans
 * `COUNT` on saute directement à la fenêtre (l'alignement de l'intervalle se calcule depuis DTSTART, pas depuis le départ).
 * DTSTART est toujours la première occurrence (RFC 5545 §3.8.5.3), même s'il ne correspond pas à la règle.
 */
function joursDeSerie(regle: Regle, mur0: number, fuseau: string, premier: number, dernier: number, budget: Budget): number[] {
  const j0 = jourDe(mur0);
  const t0 = mur0 - j0 * JOUR_MS;
  const c0 = civil(j0);
  const depart = regle.compte === null ? Math.max(j0, premier) : j0;
  const jours: number[] = [];
  let compte = 0;
  let iterations = 0;
  for (let j = depart; j <= dernier; j += 1) {
    iterations += 1;
    if (iterations > PLAFONDS.iterations) throw new ErreurIcsTropGros('iterations');
    budget.verifier();
    if (j !== j0 && !correspond(regle, j, j0, c0)) continue;
    if (regle.until !== null && apresUntil(regle.until, j * JOUR_MS + t0, fuseau)) break;
    compte += 1;
    if (regle.compte !== null && compte > regle.compte) break;
    if (j >= premier) {
      jours.push(j);
      if (jours.length > PLAFONDS.occurrences) throw new ErreurIcsTropGros('occurrences');
    }
  }
  return jours;
}

// ---------------------------------------------------------------------------------------------------------------------
// Événements
// ---------------------------------------------------------------------------------------------------------------------

interface EvenementBrut {
  uid: string | null;
  dtstart: Ligne | null;
  dtend: Ligne | null;
  duration: Ligne | null;
  rrules: Ligne[];
  exdates: Ligne[];
  rdates: Ligne[];
  recurrenceId: Ligne | null;
  transparent: boolean;
  annule: boolean;
  libre: boolean;
  summary: string | null;
  description: string | null;
  location: string | null;
}

function nouvelEvenement(): EvenementBrut {
  return {
    uid: null, dtstart: null, dtend: null, duration: null, rrules: [], exdates: [], rdates: [], recurrenceId: null,
    transparent: false, annule: false, libre: false, summary: null, description: null, location: null,
  };
}

/** Ne retient QUE les propriétés utiles : les textes sont gardés bruts (premier gagnant) et nettoyés à l'écriture des plages. */
function ajouter(ev: EvenementBrut, l: Ligne): void {
  const valeur = l.valeur.trim().toUpperCase();
  switch (l.nom) {
    case 'SUMMARY': ev.summary ??= l.valeur; break;
    case 'DESCRIPTION': ev.description ??= l.valeur; break;
    case 'LOCATION': ev.location ??= l.valeur; break;
    case 'UID': ev.uid = l.valeur.trim(); break;
    case 'DTSTART': ev.dtstart ??= l; break;
    case 'DTEND': ev.dtend ??= l; break;
    case 'DURATION': ev.duration ??= l; break;
    case 'RRULE': ev.rrules.push(l); break;
    case 'EXDATE': ev.exdates.push(l); break;
    case 'RDATE': ev.rdates.push(l); break;
    case 'RECURRENCE-ID': ev.recurrenceId ??= l; break;
    case 'TRANSP': if (valeur === 'TRANSPARENT') ev.transparent = true; break;
    case 'STATUS': if (valeur === 'CANCELLED') ev.annule = true; break;
    case 'X-MICROSOFT-CDO-BUSYSTATUS': if (valeur === 'FREE') ev.libre = true; break;
    default: break;
  }
}

/** Occurrences à écarter : instants pour les horodatés, indices de jour pour les dates. */
interface Exclusions {
  readonly instants: Set<number>;
  readonly jours: Set<number>;
}

function exclusionsVides(): Exclusions {
  return { instants: new Set(), jours: new Set() };
}

function exclure(ex: Exclusions, d: ValeurDate): void {
  if (d.journee) ex.jours.add(jourDe(d.mur));
  else ex.instants.add(instantDe(d));
}

/** Valeurs d'une propriété de dates (`EXDATE`, `RDATE`) : liste séparée par des virgules, TZID propre à chaque ligne. */
function lireListeDates(lignes: readonly Ligne[], ctx: Contexte): ValeurDate[] | null {
  const sortie: ValeurDate[] = [];
  for (const ligne of lignes) {
    for (const morceau of ligne.valeur.split(',')) {
      if (morceau.trim() === '') continue;
      const d = lireDate(morceau, ligne.params, ctx);
      if (d === null) return null;
      sortie.push(d);
      if (sortie.length > PLAFONDS.occurrences * 10) throw new ErreurIcsTropGros('occurrences');
    }
  }
  return sortie;
}

/** Intervalle occupé. Horodaté : instants en ms. Journée entière : indices de jour, `fin` INCLUSE. */
interface Intervalle extends Textes {
  readonly debut: number;
  readonly fin: number;
}

interface Famille {
  readonly horaires: Intervalle[];
  readonly journees: Intervalle[];
}

/**
 * Plages d'un VEVENT dans l'horizon. `null` = événement écarté (à compter dans `ignores`) ; `[]` = événement compris mais
 * sans occupation (transparent, annulé, libre, ou hors horizon).
 */
function developper(ev: EvenementBrut, exclusions: Exclusions, ctx: Contexte, opt: OptionsAnalyse, budget: Budget): Famille | null {
  const sortie: Famille = { horaires: [], journees: [] };
  // Un événement « disponible » à la source ne rend pas l'utilisateur occupé : décidé avant tout, pour qu'un événement
  // libre mais exotique (règle non prise en charge) ne soit pas compté comme une occupation qu'on n'a pas su lire.
  if (ev.transparent || ev.annule || ev.libre) return sortie;
  if (ev.dtstart === null) return null;
  const debut = lireDate(ev.dtstart.valeur, ev.dtstart.params, ctx);
  if (debut === null) return null;

  // Durée : DTEND, sinon DURATION, sinon un jour (date) ; un horodaté sans fin est de durée nulle, donc sans plage.
  let dureeMs = 0;
  let nbJours = 1;
  if (ev.dtend !== null) {
    const fin = lireDate(ev.dtend.valeur, ev.dtend.params, ctx);
    if (fin === null || fin.journee !== debut.journee) return null;
    if (debut.journee) nbJours = jourDe(fin.mur) - jourDe(debut.mur);
    else dureeMs = instantDe(fin) - instantDe(debut);
  } else if (ev.duration !== null) {
    const ms = lireDuree(ev.duration.valeur);
    if (ms === null) return null;
    if (debut.journee) nbJours = Math.ceil(ms / JOUR_MS);
    else dureeMs = ms;
  } else if (!debut.journee) return null;
  if (debut.journee ? nbJours < 1 : dureeMs <= 0) return null;

  if (ev.rrules.length > 1) return null;
  const regleBrute = ev.rrules[0];
  const regle = regleBrute === undefined ? null : lireRegle(regleBrute.valeur, ctx);
  if (regleBrute !== undefined && regle === null) return null;

  const exdates = lireListeDates(ev.exdates, ctx);
  const rdates = lireListeDates(ev.rdates, ctx);
  if (exdates === null || rdates === null) return null;
  if (ev.rdates.some((l) => l.params.get('VALUE')?.toUpperCase() === 'PERIOD')) return null;
  if (rdates.some((d) => d.journee !== debut.journee)) return null;
  const aExclure: Exclusions = { instants: new Set(exclusions.instants), jours: new Set(exclusions.jours) };
  for (const d of exdates) exclure(aExclure, d);

  // Chaque occurrence (et chaque RDATE) hérite des textes de son VEVENT ; une exception RECURRENCE-ID est un VEVENT à part.
  const titre = nettoyerTexte(ev.summary, LIMITES_TEXTE.titre, false);
  const description = nettoyerTexte(ev.description, LIMITES_TEXTE.description, true);
  const lieu = nettoyerTexte(ev.location, LIMITES_TEXTE.lieu, false);
  const textes: Textes = {
    ...(titre === undefined ? {} : { titre }),
    ...(description === undefined ? {} : { description }),
    ...(lieu === undefined ? {} : { lieu }),
  };

  const hd = opt.horizonDebut.getTime();
  const hf = opt.horizonFin.getTime();
  const fuseauEvt = debut.journee ? ctx.fuseauParDefaut : debut.fuseau;
  const dureeJours = debut.journee ? nbJours : Math.ceil(dureeMs / JOUR_MS);
  const premier = jourDe(hd) - dureeJours - 2; // marge : l'heure murale s'écarte de l'instant de ±14 h
  const dernier = jourDe(hf) + 2;

  // Débuts d'occurrences : heure murale (horodaté) ou indice de jour (date).
  const jourDebut = jourDe(debut.mur);
  const heure0 = debut.mur - jourDebut * JOUR_MS;
  const jours = regle === null ? [jourDebut] : joursDeSerie(regle, debut.mur, fuseauEvt, premier, dernier, budget);
  if (debut.journee) {
    const tous = new Set<number>(jours);
    for (const d of rdates) tous.add(jourDe(d.mur));
    for (const j of tous) {
      if (aExclure.jours.has(j)) continue;
      sortie.journees.push({ debut: j, fin: j + nbJours - 1, ...textes });
    }
  } else {
    const instants = new Set<number>(jours.map((j) => murVersInstant(j * JOUR_MS + heure0, fuseauEvt)));
    for (const d of rdates) instants.add(instantDe(d));
    for (const t of instants) {
      if (aExclure.instants.has(t)) continue;
      if (aExclure.jours.has(jourDe(t + decalage(t, fuseauEvt)))) continue; // EXDATE en date : exclut le jour mural
      sortie.horaires.push({ debut: t, fin: t + dureeMs, ...textes });
    }
  }

  // Horizon : on ignore ce qui finit avant et ce qui commence après.
  const horaires = sortie.horaires.filter((p) => p.fin >= hd && p.debut <= hf);
  const journees = sortie.journees.filter(
    (p) => murVersInstant((p.fin + 1) * JOUR_MS, ctx.fuseauParDefaut) >= hd && murVersInstant(p.debut * JOUR_MS, ctx.fuseauParDefaut) <= hf,
  );
  return { horaires, journees };
}

// ---------------------------------------------------------------------------------------------------------------------
// Sortie
// ---------------------------------------------------------------------------------------------------------------------

const dateIso = (jour: number): string => new Date(jour * JOUR_MS).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------------------------------
// Point d'entrée
// ---------------------------------------------------------------------------------------------------------------------

/** Lit le texte en composants et rend les VEVENT bruts. Lève `ErreurIcsIllisible` si ce n'est pas un VCALENDAR bien formé. */
function lireEvenements(texte: string, budget: Budget): EvenementBrut[] {
  const pile: string[] = [];
  const evenements: EvenementBrut[] = [];
  let courant: EvenementBrut | null = null;
  let calendrierVu = false;
  let nbEvenements = 0;

  for (const brute of lignesLogiques(texte)) {
    budget.verifier();
    if (brute.trim() === '') continue;
    const ligne = lireLigne(brute);
    if (ligne === null) throw new ErreurIcsIllisible('Ligne sans « : » : ce n\'est pas de l\'iCalendar.');
    const haut = pile[pile.length - 1];
    if (ligne.nom === 'BEGIN') {
      const nom = ligne.valeur.trim().toUpperCase();
      if (haut === undefined && nom !== 'VCALENDAR') throw new ErreurIcsIllisible('Le texte ne commence pas par un VCALENDAR.');
      if (pile.length >= PLAFONDS.profondeur) throw new ErreurIcsIllisible('Composants trop imbriqués.');
      if (nom === 'VCALENDAR') calendrierVu = true;
      if (nom === 'VEVENT' && haut === 'VCALENDAR') {
        if (courant !== null) throw new ErreurIcsIllisible('VEVENT imbriqué.');
        nbEvenements += 1;
        if (nbEvenements > PLAFONDS.evenements) throw new ErreurIcsTropGros('evenements');
        courant = nouvelEvenement();
      }
      pile.push(nom);
    } else if (ligne.nom === 'END') {
      const nom = ligne.valeur.trim().toUpperCase();
      if (haut === undefined || haut !== nom) throw new ErreurIcsIllisible(`END:${nom} sans BEGIN correspondant.`);
      pile.pop();
      if (nom === 'VEVENT' && courant !== null && pile[pile.length - 1] === 'VCALENDAR') {
        evenements.push(courant);
        courant = null;
      }
    } else if (haut === undefined) {
      throw new ErreurIcsIllisible('Contenu hors de tout composant.');
    } else if (haut === 'VEVENT' && courant !== null) {
      ajouter(courant, ligne);
    }
  }
  if (!calendrierVu) throw new ErreurIcsIllisible('Aucun VCALENDAR.');
  if (pile.length > 0) throw new ErreurIcsIllisible('Composant non refermé (texte tronqué ?).');
  return evenements;
}

export function analyserIcs(texte: string, options: OptionsAnalyse): ResultatAnalyse {
  const hd = options.horizonDebut.getTime();
  const hf = options.horizonFin.getTime();
  if (Number.isNaN(hd) || Number.isNaN(hf) || hd > hf) throw new RangeError('Horizon invalide.');
  if (formateurDe(options.fuseauParDefaut) === null) throw new RangeError(`Fuseau par défaut inconnu : « ${options.fuseauParDefaut} ».`);

  const budget = nouveauBudget();
  const ctx: Contexte = { fuseauParDefaut: options.fuseauParDefaut, avertissements: new Set() };
  const evenements = lireEvenements(texte, budget);

  // RECURRENCE-ID : l'exception remplace l'occurrence visée de la série de même UID. Première passe : on relève les
  // occurrences remplacées (même si l'exception est annulée ou libre : l'occurrence d'origine disparaît quand même).
  let ignores = 0;
  const remplacees = new Map<string, Exclusions>();
  const ecartes = new Set<EvenementBrut>();
  for (const ev of evenements) {
    budget.verifier();
    if (ev.recurrenceId === null) continue;
    const cible = lireDate(ev.recurrenceId.valeur, ev.recurrenceId.params, ctx);
    // THISANDFUTURE (RANGE) et RECURRENCE-ID illisible ne sont pas pris en charge : l'exception est écartée et comptée.
    if (cible === null || ev.recurrenceId.params.has('RANGE')) {
      ecartes.add(ev);
      continue;
    }
    if (ev.uid === null) continue;
    const exclusions = remplacees.get(ev.uid) ?? exclusionsVides();
    exclure(exclusions, cible);
    remplacees.set(ev.uid, exclusions);
  }

  const horaires: Intervalle[] = [];
  const journees: Intervalle[] = [];
  let texteTotal = 0;
  for (const ev of evenements) {
    budget.verifier();
    if (ecartes.has(ev)) {
      ignores += 1;
      continue;
    }
    const exclusions = ev.recurrenceId === null && ev.uid !== null ? remplacees.get(ev.uid) : undefined;
    const famille = developper(ev, exclusions ?? exclusionsVides(), ctx, options, budget);
    if (famille === null) {
      ignores += 1;
      continue;
    }
    horaires.push(...famille.horaires);
    journees.push(...famille.journees);
    if (horaires.length + journees.length > PLAFONDS.plagesBrutes) throw new ErreurIcsTropGros('plagesBrutes');
    for (const p of [...famille.horaires, ...famille.journees]) {
      texteTotal += (p.titre?.length ?? 0) + (p.description?.length ?? 0) + (p.lieu?.length ?? 0);
    }
    if (texteTotal > PLAFONDS.texte) throw new ErreurIcsTropGros('texte');
  }

  // Aucune fusion : deux rendez-vous distincts restent deux plages. Tri par début (puis par fin, pour un ordre déterministe).
  // Un journée entière et un créneau horodaté se trient comme des chaînes : `AAAA-MM-JJ` précède `AAAA-MM-JJTHH…`.
  const plages: PlageOccupee[] = [
    ...horaires.map((p) => ({ ...p, debut: versInstant(new Date(p.debut)), fin: versInstant(new Date(p.fin)), journeeEntiere: false })),
    ...journees.map((p) => ({ ...p, debut: dateIso(p.debut), fin: dateIso(p.fin), journeeEntiere: true })),
  ].sort((a, b) => (a.debut < b.debut ? -1 : a.debut > b.debut ? 1 : a.fin < b.fin ? -1 : a.fin > b.fin ? 1 : 0));
  if (plages.length > PLAFONDS.plages) throw new ErreurIcsTropGros('plages');

  return { plages, ignores, avertissements: [...ctx.avertissements].sort() };
}
