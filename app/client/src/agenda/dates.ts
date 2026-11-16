// Dates de l'agenda (lot 4). Logique pure, sans DOM ni dépendance : les jours sont des chaînes `AAAA-MM-JJ` calculées en UTC
// (aucun décalage d'heure d'été ne peut les faire glisser), les instants sont ceux de l'API (`AAAA-MM-JJTHH:MM:SSZ`).

const JOUR_MS = 86_400_000;

const enMs = (jour: string): number => Date.parse(`${jour}T00:00:00Z`);
const enJour = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function ajouterJours(jour: string, n: number): string {
  return enJour(enMs(jour) + n * JOUR_MS);
}

/** Lundi de la semaine du jour donné. */
export function debutSemaine(jour: string): string {
  const joursDepuisLundi = (new Date(enMs(jour)).getUTCDay() + 6) % 7;
  return ajouterJours(jour, -joursDepuisLundi);
}

/** Les 7 jours (lundi à dimanche) de la semaine du jour donné. */
export function joursDeSemaine(jour: string): string[] {
  const lundi = debutSemaine(jour);
  return Array.from({ length: 7 }, (_, i) => ajouterJours(lundi, i));
}

/** Grille d'un mois : des semaines complètes (lundi à dimanche) qui couvrent le mois, 4 à 6 lignes de 7 jours. */
export function grilleMois(mois: string): string[][] {
  const premier = `${mois.slice(0, 7)}-01`;
  const suivant = new Date(enMs(premier));
  suivant.setUTCMonth(suivant.getUTCMonth() + 1);
  const dernier = ajouterJours(enJour(suivant.getTime()), -1);
  const lignes: string[][] = [];
  for (let debut = debutSemaine(premier); debut <= dernier; debut = ajouterJours(debut, 7)) {
    lignes.push(Array.from({ length: 7 }, (_, i) => ajouterJours(debut, i)));
  }
  return lignes;
}

/** Premier jour du mois précédent (`sens` = -1) ou suivant (`sens` = 1). */
export function moisVoisin(mois: string, sens: -1 | 1): string {
  const d = new Date(enMs(`${mois.slice(0, 7)}-01`));
  d.setUTCMonth(d.getUTCMonth() + sens);
  return enJour(d.getTime());
}

/** Date locale d'aujourd'hui (`AAAA-MM-JJ`), dans le fuseau du navigateur. */
export function aujourdhui(maintenant: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${String(maintenant.getFullYear())}-${p(maintenant.getMonth() + 1)}-${p(maintenant.getDate())}`;
}

/** Décalage (ms) du fuseau `timeZone` par rapport à UTC à l'instant `ms` : heure murale lue dans le fuseau, moins l'instant. */
function decalage(timeZone: string, ms: number): number {
  const parties = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const v = (type: string): number => Number(parties.find((x) => x.type === type)?.value ?? '0');
  const mural = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
  return mural - Math.floor(ms / 1000) * 1000;
}

/** `AAAA-MM-JJTHH:MM` (heure murale dans `timeZone`) → instant UTC `AAAA-MM-JJTHH:MM:00Z`. */
export function instantDepuisHeureLocale(local: string, timeZone: string): string {
  const mural = Date.parse(`${local}:00Z`);
  if (Number.isNaN(mural)) throw new Error(`Heure illisible : « ${local} ».`);
  // Deux passes : le décalage se lit à l'instant cherché, qu'on ne connaît qu'avec le décalage (changement d'heure).
  const premiere = mural - decalage(timeZone, mural);
  const instant = mural - decalage(timeZone, premiere);
  return `${new Date(instant).toISOString().slice(0, 19)}Z`;
}

/** Instant UTC → `AAAA-MM-JJTHH:MM`, heure murale dans `timeZone`. */
export function heureLocaleDepuisInstant(instant: string, timeZone: string): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new Error(`Instant illisible : « ${instant} ».`);
  return new Date(ms + decalage(timeZone, ms)).toISOString().slice(0, 16);
}

export interface EvenementDates {
  readonly all_day: boolean;
  readonly starts_at: string;
  readonly ends_at: string | null;
  readonly time_zone: string;
}

/** Jour civil (dans le fuseau de l'événement) où l'événement commence. */
export function jourDeDebut(e: EvenementDates): string {
  return e.all_day ? e.starts_at : heureLocaleDepuisInstant(e.starts_at, e.time_zone).slice(0, 10);
}

/** Tous les jours civils que touche l'événement (au plus 62, pour qu'une saisie absurde ne fige pas l'écran). */
export function joursDe(e: EvenementDates): string[] {
  const debut = jourDeDebut(e);
  const finBrute = e.ends_at === null ? debut : e.all_day ? e.ends_at : heureLocaleDepuisInstant(e.ends_at, e.time_zone).slice(0, 10);
  const fin = finBrute < debut ? debut : finBrute;
  const jours: string[] = [];
  for (let j = debut; j <= fin && jours.length < 62; j = ajouterJours(j, 1)) jours.push(j);
  return jours;
}
