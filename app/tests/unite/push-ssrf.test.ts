import { createECDH, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo, LookupFunction } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { creerPorteeUtilisateur } from '../../server/db/portee-utilisateur.js';
import {
  enregistrerAbonnementPush,
  listerAbonnementsPushUtilisateur,
  MAX_ABONNEMENTS_PUSH,
} from '../../server/db/queries/push.js';
import { limiterPayloadPush, TAILLE_MAX_PAYLOAD_PUSH, validerEndpointPush, chiffrerPayloadPush } from '../../server/domain/push.js';
import type { Journal } from '../../server/http/middleware/journal.js';
import type { DnsLookupImmich } from '../../server/services/immich-client.js';
import { ErreurEndpointPush, envoyerNotificationPush, verifierEndpointPublic } from '../../server/services/push.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';
import { envValide } from '../fixtures/env.js';

// Anti-SSRF du Web Push : le serveur POSTe vers une URL choisie par l'utilisateur.

const dnsVers = (...adresses: string[]): DnsLookupImmich =>
  vi.fn(() => Promise.resolve(adresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))));

function cles(): { p256dh: string; auth: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

describe('validerEndpointPush (partie statique)', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/xyz',
    'https://web.push.apple.com/QAbc',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAA', // WNS : la requête est admise
    'https://93.184.216.34/push/abc',
  ])('accepte %s', (url) => {
    expect(validerEndpointPush(url).valide).toBe(true);
  });

  it.each([
    ['http://fcm.googleapis.com/fcm/send/abc', 'schema_interdit'],
    ['https://10.1.20.5/push', 'hote_interdit'],
    ['https://10.1.20.5:2283/api', 'port_interdit'],
    ['https://127.0.0.1/push', 'hote_interdit'],
    ['https://127.0.0.1:6379/', 'port_interdit'],
    ['https://169.254.169.254/latest/meta-data/', 'hote_interdit'],
    ['https://192.168.1.10/x', 'hote_interdit'],
    ['https://172.16.0.1/x', 'hote_interdit'],
    ['https://100.64.0.1/x', 'hote_interdit'],
    ['https://[::1]/x', 'hote_interdit'],
    ['https://[::ffff:127.0.0.1]/x', 'hote_interdit'],
    ['https://[fe80::1]/x', 'hote_interdit'],
    ['https://[fd00::1]/x', 'hote_interdit'],
    ['https://2130706433/x', 'hote_interdit'], // 127.0.0.1 en décimal : normalisé par l'URL
    ['https://localhost/x', 'hote_interdit'],
    ['https://immich/x', 'hote_interdit'], // nom sans point : hôte de réseau interne
    ['https://nas.local/x', 'hote_interdit'],
    ['https://metadata.google.internal/x', 'hote_interdit'],
    ['https://user:mdp@fcm.googleapis.com/x', 'identifiants_interdits'],
    ['https://fcm.googleapis.com:8443/x', 'port_interdit'],
    ['pas une url', 'url_mal_formee'],
    ['ftp://fcm.googleapis.com/x', 'schema_interdit'],
  ])('refuse %s (%s)', (url, raison) => {
    expect(validerEndpointPush(url)).toEqual({ valide: false, raison });
  });
});

describe('verifierEndpointPublic (DNS)', () => {
  it('rend les adresses publiques à épingler', async () => {
    const adresses = await verifierEndpointPublic('https://push.exemple.org/x', dnsVers('93.184.216.34'));
    expect(adresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('refuse un nom qui résout vers une adresse privée ou de métadonnées', async () => {
    for (const ip of ['10.1.20.5', '127.0.0.1', '169.254.169.254', '::1', 'fd00::5']) {
      await expect(verifierEndpointPublic('https://push.exemple.org/x', dnsVers(ip))).rejects.toMatchObject({ code: 'interdit' });
    }
  });

  it('refuse dès qu’UNE des adresses résolues est non publique (rebinding à plusieurs réponses)', async () => {
    await expect(verifierEndpointPublic('https://push.exemple.org/x', dnsVers('93.184.216.34', '10.0.0.7'))).rejects.toBeInstanceOf(ErreurEndpointPush);
  });

  it('une adresse IP littérale ne passe pas par le DNS', async () => {
    const dns = dnsVers('10.0.0.1');
    await expect(verifierEndpointPublic('https://93.184.216.34/x', dns)).resolves.toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(dns).not.toHaveBeenCalled();
  });

  it('un DNS en échec est « injoignable », pas « interdit »', async () => {
    const dns: DnsLookupImmich = () => Promise.reject(new Error('ENOTFOUND'));
    await expect(verifierEndpointPublic('https://push.exemple.org/x', dns)).rejects.toMatchObject({ code: 'injoignable' });
  });
});

describe('envoi, plafond et réattribution des abonnements push', () => {
  let t: BaseTemporaire;
  let d: DeuxGroupes;
  const env = envValide();
  const ouvrirPortee = (userId: string): ReturnType<typeof creerPorteeUtilisateur> => creerPorteeUtilisateur(t.base, userId);

  beforeEach(() => {
    t = baseTemporaire();
    d = deuxGroupes(t.base);
  });
  afterEach(() => t.nettoyer());

  const payload = { title: 'Groupe', body: 'Test', url: '/', tag: 't' };

  it('n’appelle jamais fetch pour un endpoint non public, conserve la ligne et journalise un simple échec', async () => {
    const portee = ouvrirPortee(d.a.userId);
    const k = cles();
    for (const endpoint of ['https://10.1.20.5/push', 'https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data/']) {
      enregistrerAbonnementPush(portee, { endpoint, ...k, userAgent: null });
    }
    const fetchEspion = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 201 })));
    const warn = vi.fn();
    const journal: Journal = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };

    const res = await envoyerNotificationPush(t.base, d.a.userId, payload, { env, fetch: fetchEspion, journal });

    expect(fetchEspion).not.toHaveBeenCalled();
    expect(res).toEqual({ envoyes: 0, echecs: 3 });
    expect(listerAbonnementsPushUtilisateur(t.base, d.a.userId)).toHaveLength(3);
    expect(warn).toHaveBeenCalledWith('push.envoi_echec', expect.anything());
  });

  it('« interdit » (DNS vers une adresse privée) et « injoignable » (DNS en échec) sont indiscernables : mêmes lignes, même journal', async () => {
    const portee = ouvrirPortee(d.a.userId);
    const k = cles();
    for (const nom of ['interne', 'inexistant']) {
      enregistrerAbonnementPush(portee, { endpoint: `https://${nom}.exemple.org/x`, ...k, userAgent: null });
    }
    const avant = listerAbonnementsPushUtilisateur(t.base, d.a.userId).length;
    const dns: DnsLookupImmich = (hote) =>
      hote.startsWith('interne') ? Promise.resolve([{ address: '10.0.0.5', family: 4 }]) : Promise.reject(new Error('ENOTFOUND'));
    const warn = vi.fn();
    const journal: Journal = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };

    const res = await envoyerNotificationPush(t.base, d.a.userId, payload, { env, fetch: vi.fn<typeof fetch>(), dnsLookup: dns, journal });

    expect(res).toEqual({ envoyes: 0, echecs: 2 });
    expect(listerAbonnementsPushUtilisateur(t.base, d.a.userId)).toHaveLength(avant);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toBe(warn.mock.calls[1]?.[0]);
    expect(Object.keys(warn.mock.calls[0]?.[1] as object)).toEqual(Object.keys(warn.mock.calls[1]?.[1] as object));
    expect((warn.mock.calls[0]?.[1] as { type: string }).type).toBe((warn.mock.calls[1]?.[1] as { type: string }).type);
  });

  it('n’appelle pas fetch non plus quand le nom résout (à l’envoi) vers une adresse interne', async () => {
    const portee = ouvrirPortee(d.a.userId);
    enregistrerAbonnementPush(portee, { endpoint: 'https://push.exemple.org/rebind', ...cles(), userAgent: null });
    const fetchEspion = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 201 })));
    const res = await envoyerNotificationPush(t.base, d.a.userId, payload, { env, fetch: fetchEspion, dnsLookup: dnsVers('192.168.1.20') });
    expect(fetchEspion).not.toHaveBeenCalled();
    expect(res).toEqual({ envoyes: 0, echecs: 1 });
  });

  it('un DNS en échec ne supprime pas l’abonnement (panne passagère)', async () => {
    const portee = ouvrirPortee(d.a.userId);
    enregistrerAbonnementPush(portee, { endpoint: 'https://push.exemple.org/x', ...cles(), userAgent: null });
    const dns: DnsLookupImmich = () => Promise.reject(new Error('EAI_AGAIN'));
    const res = await envoyerNotificationPush(t.base, d.a.userId, payload, { env, fetch: vi.fn<typeof fetch>(), dnsLookup: dns });
    expect(res).toEqual({ envoyes: 0, echecs: 1 });
    expect(listerAbonnementsPushUtilisateur(t.base, d.a.userId)).toHaveLength(1);
  });

  it('n’envoie que vers un endpoint public, sans suivre de redirection (statut 3xx = échec)', async () => {
    const portee = ouvrirPortee(d.a.userId);
    enregistrerAbonnementPush(portee, { endpoint: 'https://push.exemple.org/redirige', ...cles(), userAgent: null });
    const fetchEspion = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } })));
    const res = await envoyerNotificationPush(t.base, d.a.userId, payload, { env, fetch: fetchEspion, dnsLookup: dnsVers('93.184.216.34') });
    expect(fetchEspion).toHaveBeenCalledTimes(1);
    expect(fetchEspion.mock.calls[0]?.[1]?.redirect).toBe('manual');
    expect(res).toEqual({ envoyes: 0, echecs: 1 });
  });

  it('le plafond tient : au-delà de MAX_ABONNEMENTS_PUSH, le plus ancien est remplacé, jamais refusé', () => {
    const portee = ouvrirPortee(d.a.userId);
    const k = cles();
    for (let i = 0; i < MAX_ABONNEMENTS_PUSH + 3; i++) {
      enregistrerAbonnementPush(portee, { endpoint: `https://push.exemple.org/appareil-${i}`, ...k, userAgent: null });
    }
    const restants = listerAbonnementsPushUtilisateur(t.base, d.a.userId).map((a) => a.endpoint);
    expect(restants).toHaveLength(MAX_ABONNEMENTS_PUSH);
    expect(restants).not.toContain('https://push.exemple.org/appareil-0');
    expect(restants).not.toContain('https://push.exemple.org/appareil-2');
    expect(restants).toContain('https://push.exemple.org/appareil-3');
    expect(restants).toContain(`https://push.exemple.org/appareil-${MAX_ABONNEMENTS_PUSH + 2}`);
  });

  it('réenregistrer le même endpoint ne consomme pas de place et rafraîchit les clés', () => {
    const portee = ouvrirPortee(d.a.userId);
    const k1 = cles();
    const k2 = cles();
    enregistrerAbonnementPush(portee, { endpoint: 'https://push.exemple.org/a', ...k1, userAgent: null });
    enregistrerAbonnementPush(portee, { endpoint: 'https://push.exemple.org/a', ...k2, userAgent: null });
    const liste = listerAbonnementsPushUtilisateur(t.base, d.a.userId);
    expect(liste).toHaveLength(1);
    expect(liste[0]?.p256dh).toBe(k2.p256dh);
  });

  it('le plafond d’un compte ne touche pas aux appareils d’un autre', () => {
    const k = cles();
    enregistrerAbonnementPush(ouvrirPortee(d.b.userId), { endpoint: 'https://push.exemple.org/bob', ...k, userAgent: null });
    for (let i = 0; i < MAX_ABONNEMENTS_PUSH + 2; i++) {
      enregistrerAbonnementPush(ouvrirPortee(d.a.userId), { endpoint: `https://push.exemple.org/a-${i}`, ...k, userAgent: null });
    }
    expect(listerAbonnementsPushUtilisateur(t.base, d.b.userId)).toHaveLength(1);
  });

  it('un endpoint réattribué à un autre compte ne notifie plus l’ancien', async () => {
    const endpoint = 'https://push.exemple.org/navigateur-partage';
    enregistrerAbonnementPush(ouvrirPortee(d.a.userId), { endpoint, ...cles(), userAgent: 'Partage/1.0' });
    // Alice se déconnecte, Bob se connecte sur le même navigateur : même endpoint.
    enregistrerAbonnementPush(ouvrirPortee(d.b.userId), { endpoint, ...cles(), userAgent: 'Partage/1.0' });

    expect(listerAbonnementsPushUtilisateur(t.base, d.a.userId)).toEqual([]);
    expect(listerAbonnementsPushUtilisateur(t.base, d.b.userId).map((a) => a.endpoint)).toEqual([endpoint]);

    const fetchEspion = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 201 })));
    const pourAlice = await envoyerNotificationPush(t.base, d.a.userId, payload, { env, fetch: fetchEspion, dnsLookup: dnsVers('93.184.216.34') });
    expect(pourAlice).toEqual({ envoyes: 0, echecs: 0 });
    expect(fetchEspion).not.toHaveBeenCalled();
    const pourBob = await envoyerNotificationPush(t.base, d.b.userId, payload, { env, fetch: fetchEspion, dnsLookup: dnsVers('93.184.216.34') });
    expect(pourBob).toEqual({ envoyes: 1, echecs: 0 });
  });
});

describe('épinglage réel de la connexion (sans options.fetch)', () => {
  let t: BaseTemporaire;
  let d: DeuxGroupes;
  let serveur: http.Server | undefined;
  beforeEach(() => {
    t = baseTemporaire();
    d = deuxGroupes(t.base);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (serveur !== undefined) await new Promise<void>((fin) => serveur?.close(() => fin()));
    serveur = undefined;
    t.nettoyer();
  });

  // Un vrai HTTPS ne tient pas ici : l'endpoint doit être en 443 (port imposé par validerEndpointPush) et le certificat doit
  // correspondre au nom. On exerce donc le chemin RÉEL de `posterEpingle` (pas d'`options.fetch`) en détournant seulement
  // `https.request` vers `http.request` sur un serveur local. L'option `lookup` — le mécanisme d'épinglage — est transmise telle
  // quelle (enveloppée pour relever l'adresse qu'elle impose) ; le nom fictif `.invalid` ne se résout nulle part, donc si
  // l'épinglage disparaissait, la connexion échouerait. La seule substitution : l'adresse publique épinglée est remplacée par
  // 127.0.0.1 au dernier moment, pour joindre le serveur local.
  it('connecte vers l’adresse épinglée (résolue une seule fois) et jamais par le DNS du système', async () => {
    const recus: Array<{ hote: string | undefined; corps: number }> = [];
    serveur = http.createServer((req, res) => {
      const morceaux: Buffer[] = [];
      req.on('data', (c: Buffer) => morceaux.push(c));
      req.on('end', () => {
        recus.push({ hote: req.headers.host, corps: Buffer.concat(morceaux).length });
        res.statusCode = 201;
        res.end();
      });
    });
    await new Promise<void>((ok) => serveur?.listen(0, '127.0.0.1', ok));
    const portLocal = (serveur.address() as AddressInfo).port;

    const adressesEpinglees: string[] = [];
    const vraiRequest = http.request.bind(http);
    vi.spyOn(https, 'request').mockImplementation(((url: URL, options: https.RequestOptions, rappel: (res: http.IncomingMessage) => void) => {
      expect(url.protocol).toBe('https:');
      const lookupEpingle = options.lookup;
      if (lookupEpingle === undefined) throw new Error('posterEpingle doit transmettre un `lookup` (épinglage)');
      const lookupDetourne: LookupFunction = (hote, opt, cb) => {
        lookupEpingle(hote, opt, (err, resultat, famille) => {
          if (err !== null) return cb(err, resultat, famille);
          if (typeof resultat === 'string') {
            adressesEpinglees.push(resultat);
            return cb(null, '127.0.0.1', 4);
          }
          adressesEpinglees.push(...resultat.map((r) => r.address));
          return cb(null, [{ address: '127.0.0.1', family: 4 }]);
        });
      };
      return vraiRequest(
        { host: url.hostname, port: portLocal, path: url.pathname, method: options.method, headers: options.headers, signal: options.signal, lookup: lookupDetourne },
        rappel,
      );
    }) as unknown as typeof https.request);

    enregistrerAbonnementPush(creerPorteeUtilisateur(t.base, d.a.userId), { endpoint: 'https://push.epingle.invalid/abc', ...cles(), userAgent: null });
    const dns = dnsVers('93.184.216.34');
    const res = await envoyerNotificationPush(t.base, d.a.userId, { title: 'G', body: 'B', url: '/', tag: 't' }, { env: envValide(), dnsLookup: dns });

    expect(res).toEqual({ envoyes: 1, echecs: 0 });
    expect(dns).toHaveBeenCalledTimes(1); // une seule résolution : celle qui est vérifiée, puis épinglée
    expect(adressesEpinglees).toEqual(['93.184.216.34']);
    expect(recus).toHaveLength(1);
    expect(recus[0]?.hote).toContain('push.epingle.invalid'); // le nom (SNI / Host) reste celui de l'endpoint
    expect(recus[0]?.corps).toBeGreaterThan(0);
  });
});

describe('taille du payload (aes128gcm)', () => {
  const k = cles();

  it('un payload court passe inchangé', () => {
    const p = { title: 'T', body: 'court', url: '/', tag: 'x' };
    expect(limiterPayloadPush(p)).toBe(p);
  });

  it('un corps trop long est raccourci sans couper un caractère, et le chiffrement tient dans 4096 octets', () => {
    const p = { title: 'Groupe', body: 'é😀'.repeat(5000), url: 'https://attroupe.test/#/x', tag: 'x' };
    const borne = limiterPayloadPush(p);
    expect(Buffer.byteLength(JSON.stringify(borne), 'utf8')).toBeLessThanOrEqual(TAILLE_MAX_PAYLOAD_PUSH);
    expect(borne.body.endsWith('…')).toBe(true);
    expect(borne.body).not.toContain('�');
    expect(chiffrerPayloadPush(borne, k.p256dh, k.auth).length).toBeLessThanOrEqual(4096);
  });

  it('chiffrerPayloadPush refuse un payload non borné plutôt que d’émettre un corps que le service push rejetterait', () => {
    expect(() => chiffrerPayloadPush({ title: 'T', body: 'x'.repeat(5000) }, k.p256dh, k.auth)).toThrow(RangeError);
  });

  it('un payload inenvoyable même sans corps lève', () => {
    expect(() => limiterPayloadPush({ title: 'T', body: 'x', url: 'https://attroupe.test/' + 'a'.repeat(5000) })).toThrow(RangeError);
  });
});
