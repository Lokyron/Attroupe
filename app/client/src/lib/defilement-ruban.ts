// Calcul pur du défilement horizontal d'un ruban de pastilles : le composant ne fait que mesurer et appliquer.

/**
 * `scrollLeft` qui centre la cible dans le champ, borné à `[0, largeurTotale - largeurVisible]` (le navigateur borne de
 * même, mais le résultat est ainsi testable). `positionCible` est la position de la cible dans le contenu défilant
 * (pas dans le champ). Un contenu qui tient dans le champ donne 0.
 */
export function defilementPourCentrer(largeurVisible: number, largeurTotale: number, positionCible: number, largeurCible: number): number {
  const maximum = Math.max(0, largeurTotale - largeurVisible);
  const souhaite = positionCible - (largeurVisible - largeurCible) / 2;
  return Math.min(maximum, Math.max(0, souhaite));
}
