import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

// Domaine pur de l'intégration Immich (architecture §7.2, modèle de données §3.11, ADR-0003) :
// 1. Chiffrement AES-256-GCM des clés d'API Immich au repos (clé maîtresse ATTROUPE_ENCRYPTION_KEY).
// 2. Validation anti-SSRF des URL d'instances Immich (blocage des adresses privées, locales et métadonnées cloud).
// 3. Signature et vérification HMAC-SHA256 d'URL de médias courtes et liées à l'utilisateur courant.

export const LONGUEUR_CLE_SECRETE_OCTETS = 32;
export const LONGUEUR_NONCE_GCM_OCTETS = 12;
export const LONGUEUR_TAG_GCM_OCTETS = 16;
export const LONGUEUR_EMPREINTE_CLE_HEX = 8;

export interface CleImmichChiffree {
  readonly cipher: Buffer;
  readonly nonce: Buffer;
  readonly fingerprint: string;
}

/** Décode une clé secrète en base64 et vérifie qu'elle fait exactement 32 octets (256 bits). */
function decoderCleSecrete32Octets(cleBase64: string, nomCle: string): Buffer {
  if (typeof cleBase64 !== 'string' || cleBase64.trim() === '') {
    throw new Error(`La clé ${nomCle} est absente ou vide.`);
  }
  const cle = Buffer.from(cleBase64.trim(), 'base64');
  if (cle.length !== LONGUEUR_CLE_SECRETE_OCTETS) {
    throw new Error(
      `La clé ${nomCle} doit faire exactement ${LONGUEUR_CLE_SECRETE_OCTETS} octets une fois décodée (reçu : ${cle.length}).`,
    );
  }
  return cle;
}

/**
 * Empreinte courte non réversible (8 premiers caractères hexadécimaux du SHA-256)
 * permettant d'afficher qu'une clé est enregistrée sans jamais l'exposer.
 */
export function empreinteCleImmich(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(0, LONGUEUR_EMPREINTE_CLE_HEX);
}

/**
 * Chiffre une clé d'API Immich en AES-256-GCM avec un nonce aléatoire de 12 octets.
 * Le tag d'authentification GCM (16 octets) est concaténé à la fin de `cipher`.
 */
export function chiffrerCleImmich(apiKey: string, encryptionKeyBase64: string): CleImmichChiffree {
  const cle = decoderCleSecrete32Octets(encryptionKeyBase64, 'ATTROUPE_ENCRYPTION_KEY');
  const nonce = randomBytes(LONGUEUR_NONCE_GCM_OCTETS);
  const chiffreur = createCipheriv('aes-256-gcm', cle, nonce);
  const chiffrage = Buffer.concat([chiffreur.update(apiKey, 'utf8'), chiffreur.final()]);
  const tag = chiffreur.getAuthTag();

  return {
    cipher: Buffer.concat([chiffrage, tag]),
    nonce,
    fingerprint: empreinteCleImmich(apiKey),
  };
}

/**
 * Déchiffre une clé d'API Immich chiffrée par `chiffrerCleImmich`.
 * Lève une erreur si la clé maîtresse, le nonce, le texte chiffré ou le tag GCM est invalide.
 */
export function dechiffrerCleImmich(cipher: Buffer, nonce: Buffer, encryptionKeyBase64: string): string {
  const cle = decoderCleSecrete32Octets(encryptionKeyBase64, 'ATTROUPE_ENCRYPTION_KEY');
  if (!Buffer.isBuffer(nonce) || nonce.length !== LONGUEUR_NONCE_GCM_OCTETS) {
    throw new Error(`Le nonce GCM doit faire exactement ${LONGUEUR_NONCE_GCM_OCTETS} octets.`);
  }
  if (!Buffer.isBuffer(cipher) || cipher.length < LONGUEUR_TAG_GCM_OCTETS) {
    throw new Error(`Le texte chiffré GCM doit contenir au moins les ${LONGUEUR_TAG_GCM_OCTETS} octets du tag.`);
  }

  const donnees = cipher.subarray(0, cipher.length - LONGUEUR_TAG_GCM_OCTETS);
  const tag = cipher.subarray(cipher.length - LONGUEUR_TAG_GCM_OCTETS);
  const dechiffreur = createDecipheriv('aes-256-gcm', cle, nonce);
  dechiffreur.setAuthTag(tag);

  return Buffer.concat([dechiffreur.update(donnees), dechiffreur.final()]).toString('utf8');
}

// ============================================================================
// Validation anti-SSRF de l'URL d'instance Immich
// ============================================================================

export type RaisonUrlImmichInvalide =
  | 'url_mal_formee'
  | 'schema_interdit'
  | 'identifiants_interdits'
  | 'hote_interdit'
  | 'adresse_privee_interdite';

export type ResultatValidationUrlImmich =
  | { readonly valide: true; readonly urlNormalisee: string }
  | { readonly valide: false; readonly raison: RaisonUrlImmichInvalide };

type CategorieHote = 'publique' | 'privee_ou_locale' | 'toujours_interdite';

/** Analyse une adresse IPv4 décimale pointée en 4 octets `0..255`, ou `null` si ce n'en est pas une. */
function analyserIpv4(hote: string): [number, number, number, number] | null {
  const correspondance = hote.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!correspondance) return null;
  const octets = [
    Number(correspondance[1]),
    Number(correspondance[2]),
    Number(correspondance[3]),
    Number(correspondance[4]),
  ] as [number, number, number, number];
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return octets;
}

/**
 * Analyse une adresse IPv6 (sans crochets) en 8 mots de 16 bits, en prenant en charge
 * la notation compressée `::` ainsi que les adresses IPv4 embarquées en fin d'adresse (`::ffff:127.0.0.1`).
 */
function analyserIpv6(hote: string): number[] | null {
  // Une éventuelle zone (`%eth0` ou `%25eth0`) est retirée avant l'analyse numérique.
  const sansZone = hote.split('%')[0] ?? '';
  if (!sansZone.includes(':')) return null;

  let canonique = sansZone;
  const dernierDeuxPoints = canonique.lastIndexOf(':');
  const queue = canonique.slice(dernierDeuxPoints + 1);
  if (queue.includes('.')) {
    const ipv4 = analyserIpv4(queue);
    if (!ipv4) return null;
    const motHaut = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const motBas = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    canonique = `${canonique.slice(0, dernierDeuxPoints + 1)}${motHaut}:${motBas}`;
  }

  const morceauxCompression = canonique.split('::');
  if (morceauxCompression.length > 2) return null;

  let segments: string[];
  if (morceauxCompression.length === 2) {
    const gauche = morceauxCompression[0] === '' ? [] : (morceauxCompression[0]?.split(':') ?? []);
    const droite = morceauxCompression[1] === '' ? [] : (morceauxCompression[1]?.split(':') ?? []);
    const manquants = 8 - (gauche.length + droite.length);
    if (manquants < 1) return null;
    segments = [...gauche, ...Array.from({ length: manquants }, () => '0'), ...droite];
  } else {
    segments = canonique.split(':');
    if (segments.length !== 8) return null;
  }

  const mots: number[] = [];
  for (const seg of segments) {
    if (!/^[0-9a-f]{1,4}$/i.test(seg)) return null;
    mots.push(Number.parseInt(seg, 16));
  }
  return mots;
}

/** Classe un quadruplet IPv4 entre adresse publique, plage privée/loopback, et plage toujours interdite. */
function classerIpv4(octets: [number, number, number, number]): CategorieHote {
  const [a, b, c] = octets;

  // Toujours interdites, même avec ATTROUPE_IMMICH_ALLOW_PRIVATE=true :
  // - 0.0.0.0/8 (réseau courant / adresse non spécifiée)
  // - 169.254.0.0/16 (link-local et métadonnées cloud 169.254.169.254)
  // - 224.0.0.0/4 (multicast) et 240.0.0.0/4 (réservé / broadcast)
  if (a === 0) return 'toujours_interdite';
  if (a === 169 && b === 254) return 'toujours_interdite';
  if (a >= 224) return 'toujours_interdite';

  // Plages privées, loopback, CGNAT et réservées IETF :
  // - 10.0.0.0/8
  // - 100.64.0.0/10 (CGNAT)
  // - 127.0.0.0/8 (loopback)
  // - 172.16.0.0/12
  // - 192.168.0.0/16
  // - 192.0.0.0/24, 192.0.2.0/24, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24
  if (a === 10) return 'privee_ou_locale';
  if (a === 100 && b >= 64 && b <= 127) return 'privee_ou_locale';
  if (a === 127) return 'privee_ou_locale';
  if (a === 172 && b >= 16 && b <= 31) return 'privee_ou_locale';
  if (a === 192 && b === 168) return 'privee_ou_locale';
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'privee_ou_locale';
  if (a === 198 && (b === 18 || b === 19)) return 'privee_ou_locale';
  if (a === 198 && b === 51 && c === 100) return 'privee_ou_locale';
  if (a === 203 && b === 0 && c === 113) return 'privee_ou_locale';

  return 'publique';
}

/** Classe une adresse IPv6 (8 mots de 16 bits) entre publique, privée/loopback et toujours interdite. */
function classerIpv6(mots: number[]): CategorieHote {
  const m0 = mots[0] ?? 0;
  const m1 = mots[1] ?? 0;
  const m2 = mots[2] ?? 0;
  const m3 = mots[3] ?? 0;
  const m4 = mots[4] ?? 0;
  const m5 = mots[5] ?? 0;
  const m6 = mots[6] ?? 0;
  const m7 = mots[7] ?? 0;

  // :: (adresse non spécifiée) : toujours interdite.
  if (m0 === 0 && m1 === 0 && m2 === 0 && m3 === 0 && m4 === 0 && m5 === 0 && m6 === 0 && m7 === 0) {
    return 'toujours_interdite';
  }

  // ::1 (loopback) : privée / locale.
  if (m0 === 0 && m1 === 0 && m2 === 0 && m3 === 0 && m4 === 0 && m5 === 0 && m6 === 0 && m7 === 1) {
    return 'privee_ou_locale';
  }

  // Adresse IPv4 mappée en IPv6 (::ffff:w.x.y.z / ::ffff:0:0/96) ou compatible IPv4 (::w.x.y.z)
  // ou préfixe NAT64 bien connu (64:ff9b::/96).
  const estIpv4Mappee = m0 === 0 && m1 === 0 && m2 === 0 && m3 === 0 && m4 === 0 && (m5 === 0xffff || m5 === 0);
  const estNat64 = m0 === 0x0064 && m1 === 0xff9b && m2 === 0 && m3 === 0 && m4 === 0 && m5 === 0;
  if (estIpv4Mappee || estNat64) {
    const ipv4: [number, number, number, number] = [
      (m6 >> 8) & 0xff,
      m6 & 0xff,
      (m7 >> 8) & 0xff,
      m7 & 0xff,
    ];
    return classerIpv4(ipv4);
  }

  // 6to4 (2002::/16, RFC 3056) : l'IPv4 embarquée occupe les bits 16 à 47 ; on la reclasse comme pour NAT64 (une IPv4 publique
  // embarquée reste acceptée, une privée ou réservée est refusée avec la même catégorie).
  if (m0 === 0x2002) {
    return classerIpv4([(m1 >> 8) & 0xff, m1 & 0xff, (m2 >> 8) & 0xff, m2 & 0xff]);
  }

  // Refusés en bloc, sans extraction de l'IPv4 embarquée (sa position dépend de la longueur de préfixe choisie par l'opérateur,
  // l'extraire compliquerait le code pour un bénéfice nul) : tous permettent d'atteindre l'interne via une passerelle de traduction.
  // - 64:ff9b:1::/48 : NAT64 à préfixe local (RFC 8215), distinct du 64:ff9b::/96 bien connu traité plus haut ;
  // - ::ffff:0:0:0/96 : SIIT (RFC 7915), à ne pas confondre avec ::ffff:0:0/96 (IPv4 mappée) ;
  // - 2001::/32 : Teredo (RFC 4380).
  const estNat64Local = m0 === 0x0064 && m1 === 0xff9b && m2 === 0x0001;
  const estSiit = m0 === 0 && m1 === 0 && m2 === 0 && m3 === 0 && m4 === 0xffff && m5 === 0;
  const estTeredo = m0 === 0x2001 && m1 === 0;
  if (estNat64Local || estSiit || estTeredo) return 'toujours_interdite';

  // fe80::/10 (link-local) et ff00::/8 (multicast) : toujours interdites.
  if ((m0 & 0xffc0) === 0xfe80) return 'toujours_interdite';
  if ((m0 & 0xff00) === 0xff00) return 'toujours_interdite';

  // fc00::/7 (Unique Local Addresses fc00:: / fd00::) et 2001:db8::/32 (documentation) : privées / locales.
  if ((m0 & 0xfe00) === 0xfc00) return 'privee_ou_locale';
  if (m0 === 0x2001 && m1 === 0x0db8) return 'privee_ou_locale';

  return 'publique';
}

/** Classe un nom d'hôte ou une adresse IP brute. */
function classerHote(hoteBrut: string): CategorieHote {
  const hote = hoteBrut.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (hote === '') return 'toujours_interdite';

  // Hôte de métadonnées cloud connu : toujours interdit.
  if (hote === 'metadata.google.internal') return 'toujours_interdite';

  const ipv4 = analyserIpv4(hote);
  if (ipv4) return classerIpv4(ipv4);

  const ipv6 = analyserIpv6(hote);
  if (ipv6) return classerIpv6(ipv6);

  // Toute chaîne contenant ':' qui n'est pas une IPv6 valide est mal formée / interdite.
  if (hote.includes(':')) return 'toujours_interdite';

  // Noms d'hôtes locaux : localhost, *.localhost, *.local, *.internal ou nom court sans point (ex. conteneur local).
  if (
    hote === 'localhost' ||
    hote.endsWith('.localhost') ||
    hote.endsWith('.local') ||
    hote.endsWith('.internal') ||
    !hote.includes('.')
  ) {
    return 'privee_ou_locale';
  }

  return 'publique';
}

/**
 * Retourne `true` si l'hôte donné est un nom local (`localhost`, `*.local`, `*.internal`)
 * ou une adresse IPv4 / IPv6 privée, loopback, link-local, métadonnées cloud ou réservée.
 */
export function estAdresseIpPriveeOuReservee(hote: string): boolean {
  return classerHote(hote) !== 'publique';
}

/**
 * Valide et normalise l'URL de base d'une instance Immich contre les attaques SSRF.
 * - N'accepte que `http:` et `https:`, sans identifiants, ni paramètres de requête, ni fragment.
 * - Retire les `/` finaux du chemin (`https://photos.exemple.fr/api/` → `https://photos.exemple.fr/api`).
 * - Refuse toujours `169.254.169.254`, `169.254.0.0/16`, `0.0.0.0/8`, `::`, `fe80::/10` et multicast, même si `allowPrivate = true`.
 * - Refuse les plages privées/locales (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `127/8`, `localhost`, `::1`, `fc00::/7`)
 *   lorsque `allowPrivate = false`, et les accepte lorsque `allowPrivate = true`.
 */
export function validerUrlImmich(rawUrl: string, allowPrivate = false): ResultatValidationUrlImmich {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { valide: false, raison: 'url_mal_formee' };
  }

  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { valide: false, raison: 'url_mal_formee' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { valide: false, raison: 'schema_interdit' };
  }

  if (url.username !== '' || url.password !== '') {
    return { valide: false, raison: 'identifiants_interdits' };
  }

  if (url.search !== '' || url.hash !== '' || rawUrl.includes('?') || rawUrl.includes('#')) {
    return { valide: false, raison: 'url_mal_formee' };
  }

  if (url.hostname === '' || url.hostname.includes('%')) {
    return { valide: false, raison: 'hote_interdit' };
  }

  const categorie = classerHote(url.hostname);
  if (categorie === 'toujours_interdite') {
    return { valide: false, raison: 'hote_interdit' };
  }
  if (categorie === 'privee_ou_locale' && !allowPrivate) {
    return { valide: false, raison: 'adresse_privee_interdite' };
  }

  const cheminNormalise = url.pathname.replace(/\/+$/, '');
  return {
    valide: true,
    urlNormalisee: `${url.origin}${cheminNormalise}`,
  };
}

// ============================================================================
// URL signées et expirantes pour les médias (architecture §7.2)
// ============================================================================

export const TAILLES_MEDIA = ['thumbnail', 'preview', 'fullsize', 'original'] as const;
export type TailleMedia = (typeof TAILLES_MEDIA)[number];

/** Durée de vie d'une URL de vignette (`thumbnail`, `preview`, `fullsize`) : 15 minutes (900 secondes). */
export const DUREE_URL_VIGNETTE_SECONDES = 15 * 60;
/** Durée de vie d'une URL de média original (`original`) : 5 minutes (300 secondes). */
export const DUREE_URL_ORIGINAL_SECONDES = 5 * 60;

export interface ParametresSignatureMedia {
  readonly albumId: string;
  readonly assetId: string;
  readonly taille: TailleMedia;
  readonly userId: string;
  /** Timestamp Unix d'expiration en secondes (calculé selon `taille` et `maintenant` si omis). */
  readonly exp?: number;
  /** Instant de référence pour calculer l'expiration par défaut (défaut : `new Date()`). */
  readonly maintenant?: Date;
}

export interface SignatureMedia {
  readonly exp: number;
  readonly sig: string;
}

export interface ParametresVerificationMedia {
  readonly albumId: string;
  readonly assetId: string;
  readonly taille: string;
  readonly userId: string;
  readonly exp: number | string;
  readonly sig: string;
  readonly maintenant?: Date;
}

export type RaisonSignatureMediaInvalide = 'parametres_invalides' | 'expiree' | 'signature_invalide';

export type ResultatVerificationMedia =
  | { readonly valide: true; readonly taille: TailleMedia; readonly exp: number }
  | { readonly valide: false; readonly raison: RaisonSignatureMediaInvalide };

/** Vérifie qu'une chaîne fait partie des tailles de média autorisées. */
export function estTailleMedia(valeur: unknown): valeur is TailleMedia {
  return typeof valeur === 'string' && (TAILLES_MEDIA as readonly string[]).includes(valeur);
}

/** Retourne la durée de vie en secondes associée à une taille de média (900 s pour une vignette, 300 s pour l'original). */
export function dureeVieMediaSecondes(taille: TailleMedia): number {
  return taille === 'original' ? DUREE_URL_ORIGINAL_SECONDES : DUREE_URL_VIGNETTE_SECONDES;
}

function identifiantSansSeparateurValide(valeur: string): boolean {
  return typeof valeur === 'string' && valeur.length > 0 && !valeur.includes('|');
}

function calculerHmacMedia(
  albumId: string,
  assetId: string,
  taille: TailleMedia,
  userId: string,
  exp: number,
  cleSecrete: Buffer,
): string {
  const message = `${albumId}|${assetId}|${taille}|${userId}|${exp}`;
  return createHmac('sha256', cleSecrete).update(message, 'utf8').digest('hex');
}

/**
 * Calcule la signature HMAC-SHA256 et le timestamp d'expiration (`exp` en secondes)
 * pour l'accès d'un utilisateur donné à un média Immich.
 */
export function signerUrlMedia(params: ParametresSignatureMedia, signedUrlSecretBase64: string): SignatureMedia {
  const cle = decoderCleSecrete32Octets(signedUrlSecretBase64, 'ATTROUPE_SIGNED_URL_SECRET');
  if (
    !identifiantSansSeparateurValide(params.albumId) ||
    !identifiantSansSeparateurValide(params.assetId) ||
    !identifiantSansSeparateurValide(params.userId) ||
    !estTailleMedia(params.taille)
  ) {
    throw new Error('Paramètres de signature de média invalides.');
  }

  let exp: number;
  if (params.exp !== undefined) {
    if (!Number.isSafeInteger(params.exp) || params.exp <= 0) {
      throw new Error("Le timestamp d'expiration exp doit être un entier strictement positif.");
    }
    exp = params.exp;
  } else {
    const maintenantSec = Math.floor((params.maintenant ?? new Date()).getTime() / 1000);
    exp = maintenantSec + dureeVieMediaSecondes(params.taille);
  }

  const sig = calculerHmacMedia(params.albumId, params.assetId, params.taille, params.userId, exp, cle);
  return { exp, sig };
}

/**
 * Construit le chemin relatif signé `/media/:albumId/:assetId/:taille?exp=...&sig=...`
 * lié à l'utilisateur courant.
 */
export function construireUrlMediaSignee(
  params: ParametresSignatureMedia,
  signedUrlSecretBase64: string,
): string {
  const { exp, sig } = signerUrlMedia(params, signedUrlSecretBase64);
  return `/media/${encodeURIComponent(params.albumId)}/${encodeURIComponent(params.assetId)}/${params.taille}?exp=${exp}&sig=${sig}`;
}

/**
 * Vérifie la validité et la non-expiration d'une URL de média signée pour l'utilisateur courant.
 * La comparaison du HMAC est effectuée en temps constant (`timingSafeEqual`).
 */
export function verifierSignatureMedia(
  params: ParametresVerificationMedia,
  signedUrlSecretBase64: string,
): ResultatVerificationMedia {
  const cle = decoderCleSecrete32Octets(signedUrlSecretBase64, 'ATTROUPE_SIGNED_URL_SECRET');

  if (
    !identifiantSansSeparateurValide(params.albumId) ||
    !identifiantSansSeparateurValide(params.assetId) ||
    !identifiantSansSeparateurValide(params.userId) ||
    !estTailleMedia(params.taille)
  ) {
    return { valide: false, raison: 'parametres_invalides' };
  }

  let exp: number;
  if (typeof params.exp === 'number') {
    exp = params.exp;
  } else if (typeof params.exp === 'string' && /^\d+$/.test(params.exp)) {
    exp = Number(params.exp);
  } else {
    return { valide: false, raison: 'parametres_invalides' };
  }

  if (!Number.isSafeInteger(exp) || exp <= 0) {
    return { valide: false, raison: 'parametres_invalides' };
  }

  const maintenantSec = Math.floor((params.maintenant ?? new Date()).getTime() / 1000);
  if (exp <= maintenantSec) {
    return { valide: false, raison: 'expiree' };
  }

  if (typeof params.sig !== 'string' || !/^[0-9a-f]{64}$/i.test(params.sig)) {
    return { valide: false, raison: 'signature_invalide' };
  }

  const attendue = calculerHmacMedia(params.albumId, params.assetId, params.taille, params.userId, exp, cle);
  const octetsRecus = Buffer.from(params.sig.toLowerCase(), 'utf8');
  const octetsAttendus = Buffer.from(attendue, 'utf8');

  if (octetsRecus.length !== octetsAttendus.length || !timingSafeEqual(octetsRecus, octetsAttendus)) {
    return { valide: false, raison: 'signature_invalide' };
  }

  return { valide: true, taille: params.taille, exp };
}
