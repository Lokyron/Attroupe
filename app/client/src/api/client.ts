// Appels à l'API JSON. Une erreur HTTP devient une `ErreurApi` portant le statut et la clé de traduction du serveur
// (`domaine.cas`) : l'interface la traduit, elle n'affiche jamais un texte venu du réseau.

export class ErreurApi extends Error {
  constructor(
    public readonly statut: number,
    public readonly cle: string,
    /** Corps JSON de la réponse d'erreur (ex. `pris_par` d'un 409) : relu champ par champ par qui s'en sert. */
    public readonly donnees: unknown = null,
  ) {
    super(cle);
    this.name = 'ErreurApi';
  }
}

/**
 * Refus décidé par le CLIENT lui-même, avant tout appel réseau : fichier image illisible, par exemple.
 *
 * Elle porte une clé `domaine.cas` comme celles du serveur, pour être traduite de la même façon. Sans elle,
 * un `new Error('avatar.invalide')` ordinaire n'était pas reconnu par `messageDe`, qui retombait sur le
 * message générique : le libellé « Ce fichier image n'est pas valide » existait mais ne s'affichait jamais.
 */
export class ErreurLocale extends Error {
  constructor(public readonly cle: string) {
    super(cle);
    this.name = 'ErreurLocale';
  }
}

function estObjet(valeur: unknown): valeur is Record<string, unknown> {
  return typeof valeur === 'object' && valeur !== null;
}

export async function appeler(methode: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', chemin: string, corps?: unknown): Promise<unknown> {
  const reponse = await fetch(chemin, {
    method: methode,
    credentials: 'same-origin',
    ...(corps === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) }),
  });
  const json: unknown = await reponse.json().catch(() => null);
  if (!reponse.ok) {
    const cle = estObjet(json) && typeof json['error'] === 'string' ? json['error'] : 'erreur.interne';
    throw new ErreurApi(reponse.status, cle, json);
  }
  return json;
}

/** Lit une propriété d'un corps JSON, ou lève une erreur si la forme n'est pas celle attendue (jamais de `any`). */
export function champ(valeur: unknown, nom: string): unknown {
  if (!estObjet(valeur) || !(nom in valeur)) throw new Error(`Réponse inattendue : « ${nom} » absent.`);
  return valeur[nom];
}

export function liste(valeur: unknown): unknown[] {
  if (!Array.isArray(valeur)) throw new Error('Réponse inattendue : liste attendue.');
  return valeur;
}

export function texte(valeur: unknown): string {
  if (typeof valeur !== 'string') throw new Error('Réponse inattendue : texte attendu.');
  return valeur;
}

export function texteOuNul(valeur: unknown): string | null {
  return valeur === null ? null : texte(valeur);
}

export function nombre(valeur: unknown): number {
  if (typeof valeur !== 'number') throw new Error('Réponse inattendue : nombre attendu.');
  return valeur;
}

export function role(valeur: unknown): 'admin' | 'member' {
  if (valeur !== 'admin' && valeur !== 'member') throw new Error('Réponse inattendue : rôle inconnu.');
  return valeur;
}

export function booleen(valeur: unknown): boolean {
  if (typeof valeur !== 'boolean') throw new Error('Réponse inattendue : booléen attendu.');
  return valeur;
}

export function nombreOuNul(valeur: unknown): number | null {
  return valeur === null ? null : nombre(valeur);
}
