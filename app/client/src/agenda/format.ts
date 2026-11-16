import { t } from '../i18n';
import type { EvenementDates } from './dates';

// Affichage des dates de l'agenda : les mots viennent de fr.json, les noms de jours et de mois d'`Intl` (locale fr).

const LOCALE = 'fr';

/** `AAAA-MM-JJ` → libellé (« samedi 20 mars 2027 »). Le jour est lu en UTC : aucun décalage. */
export function libelleJour(jour: string, options: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }): string {
  return new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: 'UTC' }).format(new Date(`${jour}T00:00:00Z`));
}

export function libelleMois(jour: string): string {
  return libelleJour(jour, { month: 'long', year: 'numeric' });
}

/** Initiale du jour de la semaine (lundi, mardi…), pour l'en-tête de la grille du mois. */
export function libelleJourCourt(jour: string): string {
  return libelleJour(jour, { weekday: 'short' });
}

/** Heure d'un instant UTC, lue dans le fuseau de l'événement. */
function heure(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(instant));
}

/** « 18:00 – 22:00 » ou « toute la journée », sans date (celle-ci est donnée par le contexte : cellule du jour, titre). */
export function libelleHoraire(e: EvenementDates): string {
  if (e.all_day) return t('agenda.toute_la_journee');
  return e.ends_at === null ? heure(e.starts_at, e.time_zone) : `${heure(e.starts_at, e.time_zone)} – ${heure(e.ends_at, e.time_zone)}`;
}

/** Date et horaire complets pour le détail. */
export function libelleDateHoraire(e: EvenementDates): string {
  const debut = e.all_day ? e.starts_at : new Intl.DateTimeFormat(LOCALE, { dateStyle: 'full', timeStyle: 'short', timeZone: e.time_zone }).format(new Date(e.starts_at));
  const jour = e.all_day ? libelleJour(e.starts_at) : debut;
  if (e.ends_at === null) return e.all_day ? `${jour} — ${t('agenda.toute_la_journee')}` : jour;
  if (e.all_day) return e.ends_at === e.starts_at ? `${jour} — ${t('agenda.toute_la_journee')}` : t('agenda.du_au', { du: libelleJour(e.starts_at), au: libelleJour(e.ends_at) });
  return t('agenda.du_au', { du: debut, au: new Intl.DateTimeFormat(LOCALE, { dateStyle: 'full', timeStyle: 'short', timeZone: e.time_zone }).format(new Date(e.ends_at)) });
}
