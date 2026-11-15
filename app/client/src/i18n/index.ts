import fr from './fr.json';

export type CleTexte = keyof typeof fr;

/**
 * Traduit une clé de fr.json ; `{nom}` est remplacé par la valeur fournie.
 * La clé est typée : une faute de frappe échoue à la compilation.
 */
export function t(cle: CleTexte, valeurs: Readonly<Record<string, string>> = {}): string {
  return fr[cle].replace(/\{(\w+)\}/g, (motif, nom: string) => valeurs[nom] ?? motif);
}

/** Texte d'une erreur d'API : la clé `domaine.cas` du serveur devient `erreur.domaine.cas` ; une clé inconnue donne le message générique. */
export function texteErreur(cle: string): string {
  const complete = `erreur.${cle}`;
  return complete in fr ? t(complete as CleTexte) : t('erreur.inconnue');
}
