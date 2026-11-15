// Outils de FORGE de la suite générique de cloisonnement : poser l'identifiant d'une ressource à l'endroit que le registre
// déclare (corps JSON ou chaîne de requête), jamais deviné. Un chemin déclaré qui ne mène à rien est une erreur : sinon la
// route serait « attaquée » sans que rien ne soit forgé, et la suite donnerait une fausse assurance.

/** Copie profonde de `corps` où la valeur au `chemin` (`shares.0.membership_id`) est remplacée par `valeur`. */
export function poserDansCorps(corps: unknown, chemin: string, valeur: string): unknown {
  const copie: unknown = structuredClone(corps ?? {});
  const segments = chemin.split('.');
  const dernier = segments.pop();
  let courant: unknown = copie;
  for (const segment of segments) courant = enfant(courant, segment, chemin);
  if (dernier === undefined || !existe(courant, dernier)) throw new Error(`ressourcesCorps : le chemin « ${chemin} » n'existe pas dans le corps déclaré`);
  (courant as Record<string, unknown>)[dernier] = valeur;
  return copie;
}

function existe(noeud: unknown, cle: string): boolean {
  return typeof noeud === 'object' && noeud !== null && Object.hasOwn(noeud, cle);
}

function enfant(noeud: unknown, cle: string, chemin: string): unknown {
  if (!existe(noeud, cle)) throw new Error(`ressourcesCorps : le chemin « ${chemin} » n'existe pas dans le corps déclaré`);
  return (noeud as Record<string, unknown>)[cle];
}

/** Ajoute la chaîne de requête `?nom=valeur&…` (valeurs encodées) à `chemin`. */
export function avecRequete(chemin: string, requete: Readonly<Record<string, string>>): string {
  const parties = Object.entries(requete).map(([nom, valeur]) => `${encodeURIComponent(nom)}=${encodeURIComponent(valeur)}`);
  return parties.length === 0 ? chemin : `${chemin}?${parties.join('&')}`;
}
