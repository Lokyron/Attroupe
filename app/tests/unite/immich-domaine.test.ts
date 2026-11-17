import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  chiffrerCleImmich,
  construireUrlMediaSignee,
  dechiffrerCleImmich,
  DUREE_URL_ORIGINAL_SECONDES,
  DUREE_URL_VIGNETTE_SECONDES,
  empreinteCleImmich,
  estAdresseIpPriveeOuReservee,
  LONGUEUR_EMPREINTE_CLE_HEX,
  LONGUEUR_NONCE_GCM_OCTETS,
  LONGUEUR_TAG_GCM_OCTETS,
  signerUrlMedia,
  validerUrlImmich,
  verifierSignatureMedia,
} from '../../server/domain/immich.js';

const CLE_MAITRESSE = Buffer.alloc(32, 0x11).toString('base64');
const AUTRE_CLE_MAITRESSE = Buffer.alloc(32, 0x22).toString('base64');
const SECRET_URL = Buffer.alloc(32, 0x33).toString('base64');

describe('domaine Immich : chiffrement AES-256-GCM des clés API', () => {
  it('effectue un aller-retour chiffrerCleImmich / dechiffrerCleImmich et produit une empreinte de 8 caractères hex', () => {
    const apiKey = 'immich_secret_api_key_2026';
    const chiffree1 = chiffrerCleImmich(apiKey, CLE_MAITRESSE);
    const chiffree2 = chiffrerCleImmich(apiKey, CLE_MAITRESSE);

    expect(chiffree1.nonce).toHaveLength(LONGUEUR_NONCE_GCM_OCTETS);
    expect(chiffree1.cipher.length).toBeGreaterThanOrEqual(apiKey.length + LONGUEUR_TAG_GCM_OCTETS);
    expect(chiffree1.nonce.equals(chiffree2.nonce)).toBe(false);

    expect(chiffree1.fingerprint).toBe(empreinteCleImmich(apiKey));
    expect(chiffree1.fingerprint).toMatch(new RegExp(`^[0-9a-f]{${LONGUEUR_EMPREINTE_CLE_HEX}}$`));

    expect(dechiffrerCleImmich(chiffree1.cipher, chiffree1.nonce, CLE_MAITRESSE)).toBe(apiKey);
    expect(dechiffrerCleImmich(chiffree2.cipher, chiffree2.nonce, CLE_MAITRESSE)).toBe(apiKey);
  });

  it('refuse le déchiffrement si le tag, le texte chiffré, le nonce ou la clé est altéré', () => {
    const chiffree = chiffrerCleImmich('immich_api_key', CLE_MAITRESSE);

    // Altération du dernier octet (tag GCM).
    const tagAltere = Buffer.from(chiffree.cipher);
    tagAltere[tagAltere.length - 1] = (tagAltere[tagAltere.length - 1] ?? 0) ^ 0xff;
    expect(() => dechiffrerCleImmich(tagAltere, chiffree.nonce, CLE_MAITRESSE)).toThrow();

    // Altération du premier octet (texte chiffré).
    const cipherAltere = Buffer.from(chiffree.cipher);
    cipherAltere[0] = (cipherAltere[0] ?? 0) ^ 0xff;
    expect(() => dechiffrerCleImmich(cipherAltere, chiffree.nonce, CLE_MAITRESSE)).toThrow();

    // Altération du nonce.
    const nonceAltere = Buffer.from(chiffree.nonce);
    nonceAltere[0] = (nonceAltere[0] ?? 0) ^ 0xff;
    expect(() => dechiffrerCleImmich(chiffree.cipher, nonceAltere, CLE_MAITRESSE)).toThrow();

    // Longueur de nonce invalide.
    expect(() => dechiffrerCleImmich(chiffree.cipher, randomBytes(8), CLE_MAITRESSE)).toThrow();

    // Mauvaise clé maîtresse ou clé maîtresse invalide.
    expect(() => dechiffrerCleImmich(chiffree.cipher, chiffree.nonce, AUTRE_CLE_MAITRESSE)).toThrow();
    expect(() => dechiffrerCleImmich(chiffree.cipher, chiffree.nonce, 'trop-courte')).toThrow();
    expect(() => chiffrerCleImmich('x', '')).toThrow();
  });
});

describe('domaine Immich : validation anti-SSRF des URL', () => {
  it('accepte les URL publiques et normalise les / finaux', () => {
    expect(validerUrlImmich('https://photos.exemple.fr')).toEqual({
      valide: true,
      urlNormalisee: 'https://photos.exemple.fr',
    });
    expect(validerUrlImmich('https://photos.exemple.fr/')).toEqual({
      valide: true,
      urlNormalisee: 'https://photos.exemple.fr',
    });
    expect(validerUrlImmich('https://photos.exemple.fr/api///')).toEqual({
      valide: true,
      urlNormalisee: 'https://photos.exemple.fr/api',
    });
    expect(validerUrlImmich('http://93.184.216.34:2283/')).toEqual({
      valide: true,
      urlNormalisee: 'http://93.184.216.34:2283',
    });

    expect(estAdresseIpPriveeOuReservee('photos.exemple.fr')).toBe(false);
    expect(estAdresseIpPriveeOuReservee('93.184.216.34')).toBe(false);
  });

  it('refuse schémas dangereux, identifiants, query, fragment et URL mal formées', () => {
    expect(validerUrlImmich('javascript:alert(1)')).toEqual({ valide: false, raison: 'schema_interdit' });
    expect(validerUrlImmich('ftp://photos.exemple.fr')).toEqual({ valide: false, raison: 'schema_interdit' });
    expect(validerUrlImmich('https://user:pass@photos.exemple.fr')).toEqual({
      valide: false,
      raison: 'identifiants_interdits',
    });
    expect(validerUrlImmich('https://photos.exemple.fr/?a=1')).toEqual({ valide: false, raison: 'url_mal_formee' });
    expect(validerUrlImmich('https://photos.exemple.fr/#frag')).toEqual({ valide: false, raison: 'url_mal_formee' });
    expect(validerUrlImmich('')).toEqual({ valide: false, raison: 'url_mal_formee' });
    expect(validerUrlImmich('pas-une-url')).toEqual({ valide: false, raison: 'url_mal_formee' });
  });

  it.each([
    'http://169.254.169.254/latest/meta-data',
    'http://0.0.0.0:2283',
    'http://[fe80::1]:2283',
    'http://[::]:2283',
    'http://metadata.google.internal',
    'http://[64:ff9b:1::a00:1]:2283', // NAT64 à préfixe local (RFC 8215) : atteindrait 10.0.0.1
    'http://[64:ff9b:1:0:0:0:808:808]:2283', // NAT64 local, y compris autour d'une IPv4 publique (refusé en bloc)
    'http://[::ffff:0:a00:1]:2283', // SIIT (::ffff:0:0:0/96)
    'http://[2001::1]:2283', // Teredo
    'http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]:2283', // Teredo
  ])('refuse toujours %s même lorsque allowPrivate = true', (url) => {
    expect(validerUrlImmich(url, false)).toEqual({ valide: false, raison: 'hote_interdit' });
    expect(validerUrlImmich(url, true)).toEqual({ valide: false, raison: 'hote_interdit' });
  });

  it.each([
    ['http://10.1.20.110:2283', 'http://10.1.20.110:2283'],
    ['http://192.168.1.10:2283/', 'http://192.168.1.10:2283'],
    ['http://172.16.0.1:2283', 'http://172.16.0.1:2283'],
    ['http://127.0.0.1:2283', 'http://127.0.0.1:2283'],
    ['http://localhost:2283/', 'http://localhost:2283'],
    ['http://[::1]:2283', 'http://[::1]:2283'],
    ['http://[fc00::1]:2283', 'http://[fc00::1]:2283'],
    ['http://[::ffff:127.0.0.1]:2283', 'http://[::ffff:7f00:1]:2283'],
    ['http://[64:ff9b::a00:1]:2283', 'http://[64:ff9b::a00:1]:2283'], // NAT64 bien connu vers 10.0.0.1
    ['http://[2002:a00:1::1]:2283', 'http://[2002:a00:1::1]:2283'], // 6to4 vers 10.0.0.1
    ['http://[2002:7f00:1::]:2283', 'http://[2002:7f00:1::]:2283'], // 6to4 vers 127.0.0.1
  ])('refuse %s si allowPrivate = false et l’accepte si allowPrivate = true', (url, attendue) => {
    expect(validerUrlImmich(url, false)).toEqual({ valide: false, raison: 'adresse_privee_interdite' });
    expect(validerUrlImmich(url, true)).toEqual({ valide: true, urlNormalisee: attendue });
    expect(estAdresseIpPriveeOuReservee(new URL(url).hostname)).toBe(true);
  });
});

describe('domaine Immich : adresses IPv6 de traduction', () => {
  it('une IPv4 publique embarquée en 6to4 ou en NAT64 bien connu reste acceptée', () => {
    expect(estAdresseIpPriveeOuReservee('2002:5db8:d822::1')).toBe(false); // 93.184.216.34
    expect(estAdresseIpPriveeOuReservee('64:ff9b::5db8:d822')).toBe(false);
  });

  it.each(['2001::1', '64:ff9b:1::5db8:d822', '::ffff:0:5db8:d822'])('%s est refusée même avec une IPv4 publique embarquée', (ip) => {
    expect(estAdresseIpPriveeOuReservee(ip)).toBe(true);
  });
});

describe('domaine Immich : URL signées HMAC-SHA256', () => {
  const T0 = new Date('2026-11-15T12:00:00Z');
  const T0_SEC = Math.floor(T0.getTime() / 1000);

  it('applique 900 s pour thumbnail et 300 s pour original et vérifie avant expiration', () => {
    const sigThumb = signerUrlMedia(
      { albumId: 'alb1', assetId: 'ast1', taille: 'thumbnail', userId: 'u1', maintenant: T0 },
      SECRET_URL,
    );
    expect(sigThumb.exp).toBe(T0_SEC + DUREE_URL_VIGNETTE_SECONDES);
    expect(DUREE_URL_VIGNETTE_SECONDES).toBe(900);

    const sigOrig = signerUrlMedia(
      { albumId: 'alb1', assetId: 'ast1', taille: 'original', userId: 'u1', maintenant: T0 },
      SECRET_URL,
    );
    expect(sigOrig.exp).toBe(T0_SEC + DUREE_URL_ORIGINAL_SECONDES);
    expect(DUREE_URL_ORIGINAL_SECONDES).toBe(300);

    // Valide 1 seconde avant expiration.
    expect(
      verifierSignatureMedia(
        {
          albumId: 'alb1',
          assetId: 'ast1',
          taille: 'thumbnail',
          userId: 'u1',
          exp: String(sigThumb.exp),
          sig: sigThumb.sig,
          maintenant: new Date((sigThumb.exp - 1) * 1000),
        },
        SECRET_URL,
      ),
    ).toEqual({ valide: true, taille: 'thumbnail', exp: sigThumb.exp });

    // Expirée à exp exactement.
    expect(
      verifierSignatureMedia(
        {
          albumId: 'alb1',
          assetId: 'ast1',
          taille: 'thumbnail',
          userId: 'u1',
          exp: sigThumb.exp,
          sig: sigThumb.sig,
          maintenant: new Date(sigThumb.exp * 1000),
        },
        SECRET_URL,
      ),
    ).toEqual({ valide: false, raison: 'expiree' });

    // URL complète construite et vérifiable.
    const url = construireUrlMediaSignee(
      { albumId: 'alb1', assetId: 'ast1', taille: 'original', userId: 'u1', maintenant: T0 },
      SECRET_URL,
    );
    expect(url).toBe(`/media/alb1/ast1/original?exp=${sigOrig.exp}&sig=${sigOrig.sig}`);
  });

  it('rejette une URL rejouée par un autre userId ou avec un paramètre altéré', () => {
    const { exp, sig } = signerUrlMedia(
      { albumId: 'alb1', assetId: 'ast1', taille: 'thumbnail', userId: 'u1', maintenant: T0 },
      SECRET_URL,
    );
    const baseParams = {
      albumId: 'alb1',
      assetId: 'ast1',
      taille: 'thumbnail',
      userId: 'u1',
      exp,
      sig,
      maintenant: T0,
    };

    // Rejeu par un autre utilisateur.
    expect(verifierSignatureMedia({ ...baseParams, userId: 'u2' }, SECRET_URL)).toEqual({
      valide: false,
      raison: 'signature_invalide',
    });

    // Altération de albumId, assetId, taille, exp, sig.
    expect(verifierSignatureMedia({ ...baseParams, albumId: 'alb2' }, SECRET_URL)).toEqual({
      valide: false,
      raison: 'signature_invalide',
    });
    expect(verifierSignatureMedia({ ...baseParams, assetId: 'ast2' }, SECRET_URL)).toEqual({
      valide: false,
      raison: 'signature_invalide',
    });
    expect(verifierSignatureMedia({ ...baseParams, taille: 'original' }, SECRET_URL)).toEqual({
      valide: false,
      raison: 'signature_invalide',
    });
    expect(verifierSignatureMedia({ ...baseParams, exp: exp + 1 }, SECRET_URL)).toEqual({
      valide: false,
      raison: 'signature_invalide',
    });

    const sigAlteree = `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`;
    expect(verifierSignatureMedia({ ...baseParams, sig: sigAlteree }, SECRET_URL)).toEqual({
      valide: false,
      raison: 'signature_invalide',
    });

    // Taille inconnue ou exp non numérique → parametres_invalides.
    expect(verifierSignatureMedia({ ...baseParams, taille: 'giant' }, SECRET_URL)).toEqual({
      valide: false,
      raison: 'parametres_invalides',
    });
    expect(verifierSignatureMedia({ ...baseParams, exp: 'abc' }, SECRET_URL)).toEqual({
      valide: false,
      raison: 'parametres_invalides',
    });
  });
});
