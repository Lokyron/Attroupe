/** Mise en forme des montants en unités mineures, partagée par les dépenses et le tableau de bord. */

/**
 * Formate un montant mineur dans la devise donnée, avec un exposant fourni par l'appelant (les deux appelants
 * ne le déduisent pas de la même source). `avecSigne` préfixe « + » les montants strictement positifs.
 */
export function formaterMontantExposant(montantMineur: number, devise: string, exposant: number, avecSigne = false): string {
  const formate = new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: devise,
    minimumFractionDigits: exposant,
    maximumFractionDigits: exposant,
  }).format(montantMineur / 10 ** exposant);
  if (avecSigne && montantMineur > 0) return `+${formate}`;
  return formate;
}

/** Exposant d'une devise tel que le connaît Intl (ISO 4217), 2 à défaut. */
export function exposantIntl(devise: string): number {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: devise }).resolvedOptions().maximumFractionDigits ?? 2;
}
