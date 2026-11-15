import { JOUR_MS, HEURE_MS, plus } from './instant.js';

// Durée de vie d'une session (architecture §5) : 30 jours GLISSANTS, plafond ABSOLU de 90 jours depuis
// l'ouverture. Logique pure : les dates sont passées par l'appelant.

export const DUREE_GLISSANTE_MS = 30 * JOUR_MS;
export const PLAFOND_ABSOLU_MS = 90 * JOUR_MS;
/** La prolongation n'écrit en base qu'une fois par heure : pas une écriture par requête. */
export const SEUIL_PROLONGATION_MS = HEURE_MS;

/** Échéance d'une session ouverte à `creation`, utilisée à l'instant `maintenant`. */
export function echeanceSession(creation: Date, maintenant: Date): Date {
  const glissante = plus(maintenant, DUREE_GLISSANTE_MS).getTime();
  const plafond = plus(creation, PLAFOND_ABSOLU_MS).getTime();
  return new Date(Math.min(glissante, plafond));
}
