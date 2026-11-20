/** Accord en nombre des libellés comptés. Pas de bibliothèque d'i18n : fr.json porte deux clés, `<base>_singulier` et `<base>_pluriel`. */

export type FormeAccord = 'singulier' | 'pluriel';

/** Règle du français : 0 et 1 (et tout nombre de valeur absolue inférieure à 2) restent au singulier. */
export function formeAccord(n: number): FormeAccord {
  return Math.abs(n) >= 2 ? 'pluriel' : 'singulier';
}

/**
 * La clé à passer à `t()` : `cleAccord('push.appareils', 3)` → `'push.appareils_pluriel'`.
 * Le type de retour est un littéral : si l'une des deux clés manque dans fr.json, `t()` refuse de compiler.
 */
export function cleAccord<B extends string>(base: B, n: number): `${B}_singulier` | `${B}_pluriel` {
  return `${base}_${formeAccord(n)}`;
}
