import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import { estAdresseIpPriveeOuReservee } from './immich.js';

export interface ClesVapid {
  /** Clé publique EC P-256 non compressée (65 octets) encodée en base64url. */
  readonly publicKey: string;
  /** Scalaire privé EC P-256 (32 octets) encodé en base64url. */
  readonly privateKey: string;
}

export interface PayloadPush {
  readonly title: string;
  readonly body: string;
  readonly url?: string | undefined;
  readonly tag?: string | undefined;
}

const TAILLE_ENREGISTREMENT_AES128GCM = 4096;
/** En-tête du corps `aes128gcm` : sel (16) + taille d'enregistrement (4) + longueur de l'identifiant (1) + clé publique éphémère (65). */
const TAILLE_ENTETE_AES128GCM = 16 + 4 + 1 + 65;
/** Après le texte clair : l'octet de délimitation (1) et le tag d'authentification GCM (16). */
const TAILLE_FIN_AES128GCM = 1 + 16;
/**
 * Taille maximale du JSON en clair : 3993 octets. Un service push n'est tenu d'accepter que 4096 octets de corps (RFC 8030 §7.2),
 * en-tête et tag compris ; au-delà il répond 413. (Le plafond de 4079 octets de la RFC 8188 ne vaut que pour l'enregistrement, pas pour le corps.)
 */
export const TAILLE_MAX_PAYLOAD_PUSH = TAILLE_ENREGISTREMENT_AES128GCM - TAILLE_ENTETE_AES128GCM - TAILLE_FIN_AES128GCM;
const INFO_WEBPUSH = Buffer.from('WebPush: info\0', 'ascii');
const INFO_CEK = Buffer.from('Content-Encoding: aes128gcm\0', 'ascii');
const INFO_NONCE = Buffer.from('Content-Encoding: nonce\0', 'ascii');

/** Normalise une chaîne base64 ou base64url et la décode en Buffer. */
export function decoderBase64Url(valeur: string): Buffer {
  const normalisee = valeur.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return Buffer.from(normalisee, 'base64url');
}

function padGauche32(buf: Buffer): Buffer {
  if (buf.length === 32) return buf;
  if (buf.length > 32) return buf.subarray(buf.length - 32);
  return Buffer.concat([Buffer.alloc(32 - buf.length, 0), buf]);
}

/** Génère une paire de clés VAPID EC P-256 encodées en base64url. */
export function genererClesVapid(): ClesVapid {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwkPub = publicKey.export({ format: 'jwk' });
  const jwkPriv = privateKey.export({ format: 'jwk' });
  if (jwkPub.x === undefined || jwkPub.y === undefined || jwkPriv.d === undefined) {
    throw new Error('Impossible d’exporter la paire de clés VAPID P-256.');
  }
  const pubBrute = Buffer.concat([
    Buffer.from([0x04]),
    padGauche32(decoderBase64Url(jwkPub.x)),
    padGauche32(decoderBase64Url(jwkPub.y)),
  ]);
  const privBrute = padGauche32(decoderBase64Url(jwkPriv.d));
  return {
    publicKey: pubBrute.toString('base64url'),
    privateKey: privBrute.toString('base64url'),
  };
}

function importerClePriveeVapid(publicKeyB64Url: string, privateKeyStr: string): KeyObject {
  if (privateKeyStr.includes('BEGIN')) {
    return createPrivateKey(privateKeyStr);
  }
  const pubBrute = decoderBase64Url(publicKeyB64Url);
  if (pubBrute.length !== 65 || pubBrute[0] !== 0x04) {
    throw new Error('Clé publique VAPID invalide (65 octets non compressés attendus).');
  }
  const privBrute = decoderBase64Url(privateKeyStr);
  if (privBrute.length !== 32) {
    throw new Error('Clé privée VAPID invalide (32 octets attendus).');
  }
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: pubBrute.subarray(1, 33).toString('base64url'),
      y: pubBrute.subarray(33, 65).toString('base64url'),
      d: privBrute.toString('base64url'),
    },
    format: 'jwk',
  });
}

/**
 * Construit l'en-tête HTTP `Authorization` VAPID (`vapid t=..., k=...`) avec un JWT signé en ES256 (RFC 8292).
 */
export function construireEnteteVapid(
  endpoint: string,
  subject: string,
  publicKey: string,
  privateKey: string,
  maintenant: Date = new Date(),
): string {
  const origine = new URL(endpoint).origin;
  const exp = Math.floor(maintenant.getTime() / 1000) + 12 * 3600;
  const entete = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const charge = Buffer.from(JSON.stringify({ aud: origine, exp, sub: subject })).toString('base64url');
  const aSigner = `${entete}.${charge}`;
  const clePrivee = importerClePriveeVapid(publicKey, privateKey);
  const signature = sign('sha256', Buffer.from(aSigner, 'ascii'), {
    key: clePrivee,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${aSigner}.${signature.toString('base64url')}, k=${publicKey}`;
}

/**
 * Chiffre un payload JSON pour Web Push selon la RFC 8291 (`aes128gcm`) en utilisant exclusivement `node:crypto`.
 */
export function chiffrerPayloadPush(payload: PayloadPush, p256dh: string, auth: string): Buffer {
  const uaPublicKey = decoderBase64Url(p256dh);
  if (uaPublicKey.length !== 65 || uaPublicKey[0] !== 0x04) {
    throw new Error('Clé p256dh invalide (65 octets non compressés attendus).');
  }
  const authSecret = decoderBase64Url(auth);
  if (authSecret.length !== 16) {
    throw new Error('Secret auth invalide (16 octets attendus).');
  }

  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublicKey = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublicKey);

  const keyInfo = Buffer.concat([INFO_WEBPUSH, uaPublicKey, asPublicKey]);
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));

  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, INFO_CEK, 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, INFO_NONCE, 12));

  const donneesJson = Buffer.from(JSON.stringify(payload), 'utf8');
  if (donneesJson.length > TAILLE_MAX_PAYLOAD_PUSH) {
    throw new RangeError(`Payload push trop volumineux (${donneesJson.length} octets, maximum ${TAILLE_MAX_PAYLOAD_PUSH}).`);
  }
  const texteClair = Buffer.concat([donneesJson, Buffer.from([0x02])]);

  const chiffreur = createCipheriv('aes-128-gcm', cek, nonce);
  const chiffre = Buffer.concat([chiffreur.update(texteClair), chiffreur.final(), chiffreur.getAuthTag()]);

  const enteteEnregistrement = Buffer.alloc(16 + 4 + 1 + asPublicKey.length);
  salt.copy(enteteEnregistrement, 0);
  enteteEnregistrement.writeUInt32BE(TAILLE_ENREGISTREMENT_AES128GCM, 16);
  enteteEnregistrement.writeUInt8(asPublicKey.length, 20);
  asPublicKey.copy(enteteEnregistrement, 21);

  return Buffer.concat([enteteEnregistrement, chiffre]);
}

/** Taille en octets du JSON en clair d'un payload. */
function tailleJsonPayload(payload: PayloadPush): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

/**
 * Ramène un payload sous `TAILLE_MAX_PAYLOAD_PUSH` en raccourcissant le corps (suffixé de « … »), par points de code pour ne jamais
 * couper un caractère en deux. Si le titre, l'adresse et l'étiquette dépassent à eux seuls la limite, le payload est inenvoyable : on lève.
 */
export function limiterPayloadPush(payload: PayloadPush): PayloadPush {
  if (tailleJsonPayload(payload) <= TAILLE_MAX_PAYLOAD_PUSH) return payload;
  const sansCorps = tailleJsonPayload({ ...payload, body: '…' });
  if (sansCorps > TAILLE_MAX_PAYLOAD_PUSH) {
    throw new RangeError(`Payload push trop volumineux même sans corps (${sansCorps} octets, maximum ${TAILLE_MAX_PAYLOAD_PUSH}).`);
  }
  const points = Array.from(payload.body);
  let bas = 0;
  let haut = points.length;
  // Recherche dichotomique du plus long préfixe qui tient.
  while (bas < haut) {
    const milieu = Math.ceil((bas + haut) / 2);
    const candidat: PayloadPush = { ...payload, body: `${points.slice(0, milieu).join('')}…` };
    if (tailleJsonPayload(candidat) <= TAILLE_MAX_PAYLOAD_PUSH) bas = milieu;
    else haut = milieu - 1;
  }
  return { ...payload, body: `${points.slice(0, bas).join('')}…` };
}

export type RaisonEndpointPushInvalide = 'url_mal_formee' | 'schema_interdit' | 'identifiants_interdits' | 'port_interdit' | 'hote_interdit';

export type ResultatValidationEndpointPush =
  | { readonly valide: true; readonly url: URL }
  | { readonly valide: false; readonly raison: RaisonEndpointPushInvalide };

/**
 * Valide l'endpoint d'un abonnement push contre les attaques SSRF (partie statique : pas de DNS, voir services/push.ts pour la
 * résolution). Le serveur POSTe vers cette URL, choisie par un utilisateur : on exige donc
 *  - `https` seulement, sans identifiants, sur le port 443 (ceux des services push des navigateurs) ;
 *  - un hôte PUBLIC. Même classification que pour Immich (`estAdresseIpPriveeOuReservee` : privées, loopback, link-local, métadonnées
 *    cloud, noms locaux), mais SANS l'exception `ATTROUPE_IMMICH_ALLOW_PRIVATE` : un service push est toujours sur Internet.
 * Contrairement à `validerUrlImmich`, une requête (`?token=…`) est admise : certains services push (WNS) en portent une.
 */
export function validerEndpointPush(brut: string): ResultatValidationEndpointPush {
  if (typeof brut !== 'string' || !URL.canParse(brut)) return { valide: false, raison: 'url_mal_formee' };
  const url = new URL(brut);
  if (url.protocol !== 'https:') return { valide: false, raison: 'schema_interdit' };
  if (url.username !== '' || url.password !== '') return { valide: false, raison: 'identifiants_interdits' };
  if (url.port !== '') return { valide: false, raison: 'port_interdit' };
  if (url.hostname === '' || url.hostname.includes('%') || estAdresseIpPriveeOuReservee(url.hostname)) {
    return { valide: false, raison: 'hote_interdit' };
  }
  return { valide: true, url };
}
