/** Liste des fuseaux IANA connus du navigateur (null si `Intl.supportedValuesOf` n'est pas disponible). */
export function fuseauxConnus(): readonly string[] | null {
  try {
    const fn = (Intl as { supportedValuesOf?: (cle: string) => string[] }).supportedValuesOf;
    if (typeof fn !== 'function') return null;
    return fn('timeZone');
  } catch {
    return null;
  }
}

/** Vérifie qu'un identifiant de fuseau IANA est accepté par `Intl.DateTimeFormat`. */
export function fuseauValide(valeur: string): boolean {
  try {
    new Intl.DateTimeFormat('fr', { timeZone: valeur });
    return true;
  } catch {
    return false;
  }
}
