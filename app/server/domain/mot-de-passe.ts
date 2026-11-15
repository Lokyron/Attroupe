// Règles de force d'un mot de passe (architecture §5) : 10 caractères au moins, et refus des mots de
// passe manifestement faibles. Logique pure ; le hachage est dans services/mot-de-passe.ts.

export const LONGUEUR_MIN = 10;
/** Borne haute : au-delà, le hachage coûte plus cher que la sécurité n'y gagne (et c'est une porte de déni de service). */
export const LONGUEUR_MAX = 128;

export type RaisonRefus =
  | 'mot_de_passe.trop_court'
  | 'mot_de_passe.trop_long'
  | 'mot_de_passe.trop_courant'
  | 'mot_de_passe.trop_simple'
  | 'mot_de_passe.contient_identifiant';

/**
 * Mots de passe les plus courants (liste courte embarquée, sans accents ni majuscules). On y compare
 * le mot de passe entier ET sa « racine » (sans chiffres ni signes en fin : `Password123!` → `password`).
 */
const COURANTS: ReadonlySet<string> = new Set([
  'password', 'passw0rd', 'motdepasse', 'motdepass', 'azerty', 'azertyuiop', 'azertyuiopqsdfghjklm', 'qwerty', 'qwertyuiop',
  'qwertz', 'qwertyuiopasdfghjkl', 'abcdefghij', 'abcdefghijklmnop', 'abcdef', 'iloveyou', 'jetaime', 'bonjour', 'bonjour1',
  'soleil', 'chocolat', 'doudou', 'marseille', 'football', 'baseball', 'basketball', 'dragon', 'monkey', 'letmein', 'welcome',
  'bienvenue', 'admin', 'administrateur', 'administrator', 'changeme', 'trustno', 'trustno1', 'superman', 'batman', 'master',
  'sunshine', 'princess', 'shadow', 'michael', 'charlie', 'secret', 'secret123', 'nicolas', 'camille', 'thomas', 'azerty123',
  'attroupe', 'lesamis', 'lesmeilleurs', 'minecraft', 'pokemon', 'naruto', 'loveyou', 'whatever', 'computer', 'internet',
]);

/** Minuscules, sans accents, sans espaces. */
function normaliser(texte: string): string {
  return texte.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, '');
}

/** Substitutions « leet » courantes : `p@ssw0rd` → `password`. */
function sansLeet(texte: string): string {
  return texte.replace(/[@4]/g, 'a').replace(/[3]/g, 'e').replace(/[1!|]/g, 'i').replace(/0/g, 'o').replace(/[$5]/g, 's');
}

export interface ContexteMotDePasse {
  /** Éléments personnels que le mot de passe ne doit pas contenir (nom d'utilisateur, partie locale de l'e-mail). */
  readonly identifiants?: readonly string[];
}

/**
 * Raison du refus, ou `undefined` si le mot de passe est acceptable. La longueur se compte en caractères
 * (points de code), après normalisation NFKC : « é » compte pour un, qu'il soit composé ou non.
 */
export function evaluerMotDePasse(motDePasse: string, contexte: ContexteMotDePasse = {}): RaisonRefus | undefined {
  const brut = motDePasse.normalize('NFKC');
  const longueur = [...brut].length;
  if (longueur < LONGUEUR_MIN) return 'mot_de_passe.trop_court';
  if (longueur > LONGUEUR_MAX) return 'mot_de_passe.trop_long';

  // Peu de caractères distincts (« aaaaaaaaaaaa », « abababababab ») ou suite évidente : faible quelle que soit la longueur.
  if (new Set(brut).size < 5 || (/^\d+$/.test(brut) && new Set(brut).size < 7)) return 'mot_de_passe.trop_simple';
  if (estSuite(normaliser(brut))) return 'mot_de_passe.trop_simple';

  const nu = normaliser(brut);
  // « Password123! » → « password » : on retire les chiffres et signes de queue (ou de tête) AVANT et APRÈS la
  // substitution « leet », sinon les zéros de « p@ssw0rd2024 » seraient pris pour des « o ».
  const sansQueue = (t: string): string => t.replace(/[^a-z]+$/g, '').replace(/^[^a-z]+/g, '');
  const variantes = [nu, sansQueue(nu), sansLeet(nu), sansLeet(sansQueue(nu)), sansQueue(sansLeet(nu))];
  if (variantes.some((v) => COURANTS.has(v))) return 'mot_de_passe.trop_courant';

  for (const identifiant of contexte.identifiants ?? []) {
    const id = normaliser(identifiant);
    if (id.length >= 4 && (nu.includes(id) || sansLeet(nu).includes(id))) return 'mot_de_passe.contient_identifiant';
  }
  return undefined;
}

const SUITES: readonly string[] = (() => {
  const bases = ['01234567890123456789', 'abcdefghijklmnopqrstuvwxyz', 'azertyuiopqsdfghjklmwxcvbn', 'qwertyuiopasdfghjklzxcvbnm'];
  return bases.flatMap((b) => [b, [...b].reverse().join('')]);
})();

/** `1234567890`, `abcdefghij`, `azertyuiop` : un extrait d'une suite évidente (chiffres, alphabet, rangées du clavier), dans un sens ou l'autre. */
function estSuite(texte: string): boolean {
  return SUITES.some((suite) => suite.includes(texte));
}
