import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  enregistrerAbonnementPush,
  lireConfigPush,
  listerAbonnementsPushUtilisateur,
} from '../../server/db/queries/push.js';
import type { DnsLookupImmich } from '../../server/services/immich-client.js';
import { creerPorteeUtilisateur } from '../../server/db/portee-utilisateur.js';
import {
  chiffrerPayloadPush,
  construireEnteteVapid,
  decoderBase64Url,
  genererClesVapid,
  type PayloadPush,
} from '../../server/domain/push.js';
import { envoyerNotificationPush, obtenirClePubliqueVapid } from '../../server/services/push.js';
import { envValide } from '../fixtures/env.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';

/** Déchiffre un message RFC 8291 (`aes128gcm`) côté client simulé pour vérifier la conformité cryptographique. */
function dechiffrerRfc8291(corps: Buffer, clientEcdh: ReturnType<typeof createECDH>, authSecret: Buffer): PayloadPush {
  const salt = corps.subarray(0, 16);
  const rs = corps.readUInt32BE(16);
  expect(rs).toBe(4096);
  const idlen = corps.readUInt8(20);
  expect(idlen).toBe(65);
  const asPublicKey = corps.subarray(21, 21 + idlen);
  const chiffreAvecTag = corps.subarray(21 + idlen);
  const chiffre = chiffreAvecTag.subarray(0, chiffreAvecTag.length - 16);
  const tag = chiffreAvecTag.subarray(chiffreAvecTag.length - 16);

  const sharedSecret = clientEcdh.computeSecret(asPublicKey);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'ascii'), clientEcdh.getPublicKey(), asPublicKey]);
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'ascii'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'ascii'), 12));

  const dechiffreur = createDecipheriv('aes-128-gcm', cek, nonce);
  dechiffreur.setAuthTag(tag);
  const clair = Buffer.concat([dechiffreur.update(chiffre), dechiffreur.final()]);
  // Dernier octet de délimitation RFC 8188 = 0x02
  expect(clair[clair.length - 1]).toBe(0x02);
  return JSON.parse(clair.subarray(0, clair.length - 1).toString('utf8')) as PayloadPush;
}

/** DNS simulé : tout nom résout vers une adresse publique. */
const dnsPublic: DnsLookupImmich = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);

describe('notifications Push Web VAPID + RFC 8291 (unité)', () => {
  let t: BaseTemporaire;
  let d: DeuxGroupes;

  beforeEach(() => {
    t = baseTemporaire();
    d = deuxGroupes(t.base);
  });

  afterEach(() => {
    t.nettoyer();
  });

  it('génère une paire de clés VAPID P-256 valide et signe un JWT ES256 vérifiable', () => {
    const cles = genererClesVapid();
    const pubBrute = decoderBase64Url(cles.publicKey);
    const privBrute = decoderBase64Url(cles.privateKey);
    expect(pubBrute.length).toBe(65);
    expect(pubBrute[0]).toBe(0x04);
    expect(privBrute.length).toBe(32);

    const entete = construireEnteteVapid(
      'https://push.exemple.test/wpush/v2/abc',
      'mailto:contact@attroupe.local',
      cles.publicKey,
      cles.privateKey,
      new Date('2026-11-17T12:00:00Z'),
    );
    expect(entete.startsWith('vapid t=')).toBe(true);
    const [partieT, partieK] = entete.replace('vapid t=', '').split(', k=');
    expect(partieK).toBe(cles.publicKey);
    const segments = partieT?.split('.') ?? [];
    expect(segments).toHaveLength(3);

    const payload = JSON.parse(Buffer.from(segments[1] ?? '', 'base64url').toString('utf8')) as {
      aud: string;
      sub: string;
      exp: number;
    };
    expect(payload.aud).toBe('https://push.exemple.test');
    expect(payload.sub).toBe('mailto:contact@attroupe.local');

    const clePubliqueObj = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: pubBrute.subarray(1, 33).toString('base64url'),
        y: pubBrute.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
    const valide = verify(
      'sha256',
      Buffer.from(`${segments[0]}.${segments[1]}`, 'ascii'),
      { key: clePubliqueObj, dsaEncoding: 'ieee-p1363' },
      Buffer.from(segments[2] ?? '', 'base64url'),
    );
    expect(valide).toBe(true);
  });

  it('chiffre un payload selon RFC 8291 (aes128gcm) et reste déchiffrable par le navigateur', () => {
    const clientEcdh = createECDH('prime256v1');
    clientEcdh.generateKeys();
    const p256dh = clientEcdh.getPublicKey().toString('base64url');
    const authSecret = randomBytes(16);
    const auth = authSecret.toString('base64url');

    const payload: PayloadPush = {
      title: 'Sortie vélo',
      body: 'Alice — RDV à 14h devant la gare !',
      url: 'https://attroupe.exemple.test/#/groupe/123',
      tag: 'message:456',
    };

    const chiffre = chiffrerPayloadPush(payload, p256dh, auth);
    const dechiffre = dechiffrerRfc8291(chiffre, clientEcdh, authSecret);
    expect(dechiffre).toEqual(payload);
  });

  it('persiste et réutilise la clé VAPID en base si absente de l’environnement', () => {
    const env = envValide();
    const cle1 = obtenirClePubliqueVapid(t.base, env);
    const cle2 = obtenirClePubliqueVapid(t.base, env);
    expect(cle1).toBe(cle2);
    expect(decoderBase64Url(cle1).length).toBe(65);
  });

  it('chiffre la clé privée VAPID au repos et la retrouve avec la clé maîtresse, pas avec une autre', () => {
    const env = envValide();
    const cle = obtenirClePubliqueVapid(t.base, env);
    const ligne = t.sql.prepare('SELECT public_key, private_key_cipher, private_key_nonce FROM push_config').get() as {
      public_key: string;
      private_key_cipher: Buffer;
      private_key_nonce: Buffer;
    };
    expect(ligne.public_key).toBe(cle);
    // Le texte chiffré est la clé en base64url (43 caractères) + 16 octets de tag GCM.
    expect(ligne.private_key_cipher.length).toBe(43 + 16);
    const config = lireConfigPush(t.base, env.ATTROUPE_ENCRYPTION_KEY);
    expect(config).not.toBeNull();
    const privee = config?.private_key ?? '';
    expect(decoderBase64Url(privee).length).toBe(32);
    const toutesLesLignes = JSON.stringify(t.sql.prepare('SELECT * FROM push_config').all());
    expect(toutesLesLignes).not.toContain(privee);
    expect(ligne.private_key_cipher.includes(decoderBase64Url(privee))).toBe(false);
    expect(() => lireConfigPush(t.base, envValide().ATTROUPE_ENCRYPTION_KEY)).toThrow(/illisible/);
  });

  it('une seule clé sert partout : la clé de l’environnement l’emporte et rien n’est généré en base', () => {
    const cles = genererClesVapid();
    const env = envValide({ ATTROUPE_VAPID_PUBLIC_KEY: cles.publicKey, ATTROUPE_VAPID_PRIVATE_KEY: cles.privateKey });
    expect(obtenirClePubliqueVapid(t.base, env)).toBe(cles.publicKey);
    expect(t.sql.prepare('SELECT count(*) FROM push_config').pluck().get()).toBe(0);
  });

  it('envoie aux abonnements, supprime les abonnements expirés (410) et ignore les erreurs réseau', async () => {
    const porteeAlice = creerPorteeUtilisateur(t.base, d.a.userId);
    const clientEcdh = createECDH('prime256v1');
    clientEcdh.generateKeys();
    const p256dh = clientEcdh.getPublicKey().toString('base64url');
    const auth = randomBytes(16).toString('base64url');

    enregistrerAbonnementPush(porteeAlice, {
      endpoint: 'https://push.exemple.test/ok',
      p256dh,
      auth,
      userAgent: 'TestBrowser/1.0',
    });
    enregistrerAbonnementPush(porteeAlice, {
      endpoint: 'https://push.exemple.test/expire',
      p256dh,
      auth,
      userAgent: 'TestBrowser/1.0',
    });
    enregistrerAbonnementPush(porteeAlice, {
      endpoint: 'https://push.exemple.test/reseau',
      p256dh,
      auth,
      userAgent: 'TestBrowser/1.0',
    });

    const fauxFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/ok')) return new Response(null, { status: 201 });
      if (url.endsWith('/expire')) return new Response(null, { status: 410 });
      throw new Error('ECONNREFUSED');
    };

    const res = await envoyerNotificationPush(
      t.base,
      d.a.userId,
      { title: 'Attroupe', body: 'Test', url: '/', tag: 'test' },
      { env: envValide(), fetch: fauxFetch, dnsLookup: dnsPublic, maintenant: new Date('2026-11-17T12:00:00Z') },
    );
    expect(res).toEqual({ envoyes: 1, echecs: 2 });

    const restants = listerAbonnementsPushUtilisateur(t.base, d.a.userId);
    expect(restants.map((r) => r.endpoint).sort()).toEqual([
      'https://push.exemple.test/ok',
      'https://push.exemple.test/reseau',
    ]);
  });
});
