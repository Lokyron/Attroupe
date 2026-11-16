import { versInstant } from './instant.js';

// Règles de date d'un événement (modèle de données §1 et table `events`). Logique pure : le schéma SQL les impose déjà
// (CHECK sur la longueur de `starts_at` / `ends_at`), mais une contrainte SQLite qui saute est un 500 : on les valide
// AVANT la base, pour répondre 400 en nommant le champ fautif.
//  - `all_day = 0` : `starts_at` est un instant UTC `AAAA-MM-JJTHH:MM:SSZ` (20 caractères) ;
//  - `all_day = 1` : `starts_at` est une date `AAAA-MM-JJ` (10 caractères), sans heure ni fuseau ;
//  - `ends_at`, s'il existe, a le MÊME format que `starts_at` et lui est supérieur ou égal.

const FORME_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const FORME_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Un instant UTC réel au format du modèle (le 31 février ou 25 h 00 sont refusés). */
export function instantValide(valeur: string): boolean {
  if (!FORME_INSTANT.test(valeur)) return false;
  const date = new Date(valeur);
  return !Number.isNaN(date.getTime()) && versInstant(date) === valeur;
}

/** Une date civile réelle `AAAA-MM-JJ`. */
export function dateValide(valeur: string): boolean {
  if (!FORME_DATE.test(valeur)) return false;
  const date = new Date(`${valeur}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === valeur;
}

export interface Horaire {
  readonly all_day: boolean;
  readonly starts_at: string;
  readonly ends_at: string | null;
}

/**
 * Champs de l'horaire qui violent les règles, dans l'ordre (`starts_at` puis `ends_at`). Liste vide : l'horaire est
 * acceptable par la base. Si `starts_at` est invalide, `ends_at` n'est pas comparé (il n'y a rien de fiable à comparer).
 */
export function champsHoraireInvalides(horaire: Horaire): Array<'starts_at' | 'ends_at'> {
  const valide = horaire.all_day ? dateValide : instantValide;
  if (!valide(horaire.starts_at)) return ['starts_at'];
  if (horaire.ends_at === null) return [];
  // Même format que `starts_at`, puis ordre : à format égal, l'ordre lexicographique est l'ordre chronologique.
  if (!valide(horaire.ends_at) || horaire.ends_at < horaire.starts_at) return ['ends_at'];
  return [];
}

/** Fenêtre d'agenda au-delà de laquelle la requête est refusée (une année et un peu : mois, semaine, liste). */
export const FENETRE_MAX_JOURS = 400;

/** `du` et `au` (inclus) forment-ils une fenêtre admise ? Les deux sont déjà des dates valides. */
export function fenetreValide(du: string, au: string): boolean {
  const jours = (new Date(`${au}T00:00:00Z`).getTime() - new Date(`${du}T00:00:00Z`).getTime()) / 86_400_000;
  return jours >= 0 && jours <= FENETRE_MAX_JOURS;
}
