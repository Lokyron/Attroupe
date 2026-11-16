import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Jetons d'accès (session, vérification d'e-mail, réinitialisation de mot de passe) : 32 octets
// aléatoires, jamais stockés en clair. Le jeton ne vit que dans le cookie ou dans l'e-mail ; la base ne
// garde que son SHA-256. Un hachage rapide suffit ici (et non scrypt) parce que le jeton a 256 bits
// d'entropie : il n'y a rien à deviner par force brute, contrairement à un mot de passe.

/** Jeton de 43 caractères (base64url, 32 octets). */
export const FORME_JETON = /^[A-Za-z0-9_-]{43}$/;

export function nouveauJeton(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hexadécimal du jeton : c'est ce qui est écrit en base. */
export function empreinteJeton(jeton: string): string {
  return createHash('sha256').update(jeton, 'utf8').digest('hex');
}

/** Comparaison en temps constant de deux empreintes hexadécimales (longueurs différentes : faux, sans fuite utile). */
export function egalTempsConstant(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

// Jeton de flux iCal (architecture §7.1) : 32 octets aléatoires en base32 (alphabet RFC 4648, minuscules, sans `=`), soit 52
// caractères, sûrs dans une URL et insensibles aux majuscules mal copiées côté affichage. Même stockage que les sessions : seule
// l'empreinte SHA-256 est écrite en base (`empreinteJeton`).
const ALPHABET_BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Jeton de flux : 52 caractères `a-z2-7`. */
export const FORME_JETON_FLUX = /^[a-z2-7]{52}$/;

/** Encode des octets en base32 sans remplissage. */
export function base32(octets: Uint8Array): string {
  let sortie = '';
  let tampon = 0;
  let bits = 0;
  for (const octet of octets) {
    tampon = (tampon << 8) | octet;
    bits += 8;
    while (bits >= 5) {
      sortie += ALPHABET_BASE32.charAt((tampon >>> (bits - 5)) & 31);
      bits -= 5;
    }
    tampon &= (1 << bits) - 1;
  }
  if (bits > 0) sortie += ALPHABET_BASE32.charAt((tampon << (5 - bits)) & 31);
  return sortie;
}

export function nouveauJetonFlux(): string {
  return base32(randomBytes(32));
}
