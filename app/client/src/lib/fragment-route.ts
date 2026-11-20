/** Vrai si le fragment d'URL désigne une route du routeur (`''`, `#`, `#/…`). Un fragment d'ancrage de page
 *  (`#contenu-principal`, lien d'évitement) n'est pas une route : la coque doit alors laisser la page telle quelle. */
export function estFragmentDeRoute(hash: string): boolean {
  return hash === '' || hash === '#' || hash.startsWith('#/');
}

/**
 * Forme retenue pour l'état de consultation dans l'URL : une CHAÎNE DE REQUÊTE après le chemin du fragment
 * (`#/groupe/g1/agenda?vue=semaine&date=2027-03-12`). Le chemin désigne la page, la requête son état ; le fragment
 * commence toujours par `#/`, donc `estFragmentDeRoute` le reconnaît comme une route.
 */
export function separerFragment(hash: string): { segments: string[]; requete: string } {
  const sansDiese = hash.replace(/^#/, '');
  const interrogation = sansDiese.indexOf('?');
  const chemin = interrogation === -1 ? sansDiese : sansDiese.slice(0, interrogation);
  const requete = interrogation === -1 ? '' : sansDiese.slice(interrogation + 1);
  // Le premier élément est ce qui précède le `/` initial (toujours vide) : on ne le rend pas.
  return { segments: chemin.split('/').slice(1), requete };
}

/**
 * Décode un segment de chemin, ou rend `null` s'il est mal formé (`%E0`, `%`, séquence UTF-8 invalide) :
 * `decodeURIComponent` lèverait une `URIError`, qui viderait l'écran au premier rendu et casserait l'écouteur
 * de `hashchange`. L'appelant route alors vers « introuvable ».
 */
export function decoderSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch (err: unknown) {
    if (err instanceof URIError) return null;
    throw err;
  }
}
