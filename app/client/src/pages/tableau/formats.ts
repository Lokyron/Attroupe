// Mise en forme des textes du tableau de bord (dates, montants, pastilles). Les dérivations de données, elles, sont dans selecteurs.ts.
import { ajouterJours, jourDeDebut } from '../../agenda/dates';
import { libelleHoraire } from '../../agenda/format';
import { t, type CleTexte } from '../../i18n';
import type { ElementCalendrier, StatutPresence } from './selecteurs';

export function libellePastilleCalendrier(el: ElementCalendrier): string {
  return el.sorte === 'groupe'
    ? t('tableau.pastille_groupe', { groupe: el.group_name, titre: el.title })
    : t('tableau.pastille_perso', { titre: el.title });
}

/**
 * Même comportement que `formaterMontant` de `Depenses.tsx` : l'exposant est celui de la devise (lu dans Intl,
 * qui connaît les exposants ISO 4217), et non un cas particulier codé en dur. À factoriser dans `lib/`.
 */
export function formaterMontant(montantMineur: number, devise: string, avecSigne = false): string {
  const exposant = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: devise }).resolvedOptions()
    .maximumFractionDigits ?? 2;
  const valeur = montantMineur / 10 ** exposant;
  const formate = new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: devise,
    minimumFractionDigits: exposant,
    maximumFractionDigits: exposant,
  }).format(valeur);
  if (avecSigne && montantMineur > 0) return `+${formate}`;
  return formate;
}

/**
 * Date d'un événement dans SON fuseau (comme les vignettes et `jourDeDebut`), jamais celui du navigateur.
 * Un événement « toute la journée » est une date sans heure, lue en UTC : sinon, sous un fuseau négatif,
 * le jour affiché serait la veille.
 */
export function formaterDateEvenement(iso: string, touteLaJournee: boolean, fuseau: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  if (touteLaJournee) {
    const jour = new Intl.DateTimeFormat('fr-FR', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    }).format(date);
    return `${jour} · ${t('tableau.journee_entiere')}`;
  }
  return new Intl.DateTimeFormat('fr-FR', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: fuseau,
  }).format(date);
}

/** Date AAAA-MM-JJ d'une dépense (sans heure) : lue en UTC pour ne pas glisser d'un jour selon le fuseau. */
export function formaterDateCourte(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(date);
}

export function formaterDateRelative(el: ElementCalendrier, jourAujourdHui: string): string {
  const jour = jourDeDebut(el);
  const horaire = el.all_day ? t('tableau.journee_entiere') : libelleHoraire(el);
  if (jour === jourAujourdHui) return `${t('tableau.aujourdhui')} · ${horaire}`;
  if (jour === ajouterJours(jourAujourdHui, 1)) return `${t('tableau.demain')} · ${horaire}`;
  return formaterDateEvenement(el.starts_at, el.all_day, el.time_zone);
}

export function partiesVignetteDate(el: ElementCalendrier): { mois: string; jour: string } {
  const isoJour = jourDeDebut(el);
  const date = new Date(`${isoJour}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return { mois: '---', jour: '--' };
  const mois = new Intl.DateTimeFormat('fr-FR', { month: 'short', timeZone: 'UTC' })
    .format(date)
    .replace('.', '')
    .toUpperCase();
  const jour = String(Number(isoJour.slice(8, 10)));
  return { mois, jour };
}

export function cleStatutCompact(statut: StatutPresence): CleTexte {
  if (statut === 'yes') return 'tableau.statut_confirme';
  if (statut === 'maybe') return 'tableau.statut_peut_etre';
  if (statut === 'no') return 'tableau.statut_decline';
  return 'tableau.statut_a_valider';
}

export function badgeMoisCourt(ancre: string): string {
  const date = new Date(`${ancre.slice(0, 7)}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return ancre.slice(0, 7);
  return new Intl.DateTimeFormat('fr-FR', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}
