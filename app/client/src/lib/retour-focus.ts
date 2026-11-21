// Où rendre le focus à la fermeture d'une feuille ouverte depuis l'un de plusieurs déclencheurs (bandeau du bas, barre
// latérale). Un seul des deux est visible à la fois (media query) : si la fenêtre est redimensionnée pendant que la
// feuille est ouverte, le déclencheur d'origine peut avoir disparu, et lui rendre le focus le perdrait sur `<body>`.

/**
 * Premier candidat visible, dans l'ordre donné (le déclencheur d'origine d'abord), ou `null` s'il n'y en a aucun.
 * `estVisible` est injecté pour que le choix reste pur (le navigateur répond par `getClientRects().length > 0`).
 */
export function premierVisible<T>(candidats: readonly T[], estVisible: (candidat: T) => boolean): T | null {
  for (const candidat of candidats) {
    if (estVisible(candidat)) return candidat;
  }
  return null;
}
