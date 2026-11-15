import fr from './fr.json';

export type CleTexte = keyof typeof fr;

/**
 * Traduit une clé de fr.json ; `{nom}` est remplacé par la valeur fournie.
 * La clé est typée : une faute de frappe échoue à la compilation.
 */
export function t(cle: CleTexte, valeurs: Readonly<Record<string, string>> = {}): string {
  return fr[cle].replace(/\{(\w+)\}/g, (motif, nom: string) => valeurs[nom] ?? motif);
}
