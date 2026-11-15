import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { ErreurHttp } from '../http/erreurs.js';

// Hachage des mots de passe par `scrypt` de node:crypto (ADR-0007) : aucune dépendance native.
// Format versionné `scrypt$N$r$p$sel$empreinte` (sel et empreinte en base64url) : les paramètres voyagent
// avec l'empreinte, donc on peut les durcir plus tard sans invalider un seul compte (réhachage à la connexion).

export interface ParametresScrypt {
  /** Coût CPU/mémoire (puissance de 2). */
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** ADR-0007 : N=2^15, r=8, p=1 (32 Mio par hachage). */
export const PARAMETRES_PRODUCTION: ParametresScrypt = Object.freeze({ N: 2 ** 15, r: 8, p: 1 });

const LONGUEUR_SEL = 16;
const LONGUEUR_EMPREINTE = 64;
/** Garde-fou à la lecture : une empreinte corrompue ne doit pas pouvoir demander des gigaoctets. */
const N_MAX = 2 ** 20;
const FORMAT = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

// Hachages en vol : le thread pool de libuv n'a que 4 fils, et chaque hachage prend 32 Mio. Au-delà de
// MAX_PARALLELE on met en file, au-delà de MAX_EN_ATTENTE on refuse (503) plutôt que d'accumuler : si le
// port est joignable directement, la cadence par adresse se contourne, ce plafond reste.
const MAX_PARALLELE = 4;
const MAX_EN_ATTENTE = 32;
let enCours = 0;
const attente: Array<() => void> = [];

async function obtenirPlace(): Promise<void> {
  if (enCours < MAX_PARALLELE) {
    enCours++;
    return;
  }
  if (attente.length >= MAX_EN_ATTENTE) throw new ErreurHttp(503, 'serveur.occupe', 5);
  await new Promise<void>((resoudre) => attente.push(resoudre));
}

function libererPlace(): void {
  const suivant = attente.shift();
  if (suivant === undefined) enCours--;
  else suivant(); // la place passe directement au suivant : `enCours` ne change pas
}

function deriver(motDePasse: string, sel: Buffer, parametres: ParametresScrypt, longueur: number): Promise<Buffer> {
  return new Promise((resoudre, rejeter) => {
    scrypt(
      motDePasse.normalize('NFKC'),
      sel,
      longueur,
      { N: parametres.N, r: parametres.r, p: parametres.p, maxmem: 256 * parametres.N * parametres.r },
      (erreur, cle) => (erreur === null ? resoudre(cle) : rejeter(erreur)),
    );
  });
}

async function deriverAvecPlace(motDePasse: string, sel: Buffer, parametres: ParametresScrypt, longueur: number): Promise<Buffer> {
  await obtenirPlace();
  try {
    return await deriver(motDePasse, sel, parametres, longueur);
  } finally {
    libererPlace();
  }
}

/** `scrypt$N$r$p$sel$empreinte` pour ce mot de passe, avec un sel neuf. */
export async function hacher(motDePasse: string, parametres: ParametresScrypt): Promise<string> {
  const sel = randomBytes(LONGUEUR_SEL);
  const empreinte = await deriverAvecPlace(motDePasse, sel, parametres, LONGUEUR_EMPREINTE);
  return `scrypt$${String(parametres.N)}$${String(parametres.r)}$${String(parametres.p)}$${sel.toString('base64url')}$${empreinte.toString('base64url')}`;
}

interface HachageLu {
  readonly parametres: ParametresScrypt;
  readonly sel: Buffer;
  readonly empreinte: Buffer;
}

function lire(hachage: string): HachageLu | undefined {
  const m = hachage.match(FORMAT);
  if (m === null) return undefined;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!Number.isSafeInteger(N) || N < 2 || N > N_MAX || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 4) return undefined;
  const sel = Buffer.from(m[4] ?? '', 'base64url');
  const empreinte = Buffer.from(m[5] ?? '', 'base64url');
  if (sel.length === 0 || empreinte.length === 0) return undefined;
  return { parametres: { N, r, p }, sel, empreinte };
}

/** Vrai si le mot de passe correspond à l'empreinte (comparaison en temps constant). Un format illisible vaut faux. */
export async function verifier(motDePasse: string, hachage: string): Promise<boolean> {
  const lu = lire(hachage);
  if (lu === undefined) return false;
  const calcule = await deriverAvecPlace(motDePasse, lu.sel, lu.parametres, lu.empreinte.length);
  return timingSafeEqual(calcule, lu.empreinte);
}

/** L'empreinte est-elle plus faible que les paramètres actuels (à refaire après une connexion réussie) ? */
export function doitEtreRehache(hachage: string, parametres: ParametresScrypt): boolean {
  const lu = lire(hachage);
  return lu === undefined || lu.parametres.N < parametres.N || lu.parametres.r < parametres.r || lu.parametres.p < parametres.p;
}

// Empreinte « leurre » : quand le compte n'existe pas, la connexion vérifie quand même le mot de passe
// contre elle, pour que la durée de réponse ne trahisse pas l'existence de l'adresse. Calculée une fois
// par jeu de paramètres, avec un mot de passe aléatoire que personne ne connaît.
const leurres = new Map<string, Promise<string>>();

export function empreinteLeurre(parametres: ParametresScrypt): Promise<string> {
  const cle = `${String(parametres.N)}/${String(parametres.r)}/${String(parametres.p)}`;
  let leurre = leurres.get(cle);
  if (leurre === undefined) {
    leurre = hacher(randomBytes(24).toString('base64url'), parametres);
    leurres.set(cle, leurre);
  }
  return leurre;
}
