/**
 * Défini ici (et ré-exporté par `useLecture`) pour que ce module reste PUR : les tests unitaires, compilés en
 * `nodenext`, ne peuvent pas suivre l'import de `useLecture` (extensions relatives et composants React).
 */
export type EtatLecture = 'chargement' | 'erreur' | 'pret';

/**
 * Combine les états de plusieurs lectures lancées EN PARALLÈLE (celle du groupe, portée par
 * `FournisseurGroupe`, et celle propre à la page) en un seul état à passer à `<ChargementPage>`.
 * Une seule erreur suffit à faire échouer l'écran ; sinon un seul chargement suffit à le garder
 * en squelette. Sans cette fusion, une page afficherait DEUX squelettes de suite : le sien,
 * puis celui de la lecture qui attendait le groupe.
 */
export function fusionnerEtats(...etats: readonly EtatLecture[]): EtatLecture {
  if (etats.includes('erreur')) return 'erreur';
  if (etats.includes('chargement')) return 'chargement';
  return 'pret';
}

/** Le premier message d'erreur non nul, dans l'ordre donné. `null` si aucune lecture n'a échoué. */
export function premiereErreur(...erreurs: readonly (string | null)[]): string | null {
  return erreurs.find((e) => e !== null) ?? null;
}
