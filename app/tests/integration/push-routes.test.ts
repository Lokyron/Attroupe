import { createECDH, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decor, inscrireEtConnecter, type Client, type Decor } from '../fixtures/comptes.js';

// Routes /api/moi/push/* : anti-SSRF, accusé neutre, cadence, réattribution d'un endpoint entre comptes.

function cles(): { p256dh: string; auth: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}

const PUBLIC = 'https://93.184.216.34/push/secret';

describe('/api/moi/push', () => {
  let d: Decor;
  let alice: Client;
  let bob: Client;
  beforeEach(async () => {
    d = decor();
    alice = await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m', '10.0.0.1');
    bob = await inscrireEtConnecter(d, 'bob@exemple.test', 'bob_m', '10.0.0.2');
  });
  afterEach(() => d.nettoyer());

  const abonner = (c: Client, endpoint: string): ReturnType<Client['post']> =>
    c.post('/api/moi/push/abonnement', { endpoint, keys: cles() });
  const compte = (): number => Number(d.sql.prepare('SELECT count(*) FROM push_subscriptions').pluck().get());

  it('refuse un endpoint vers le réseau interne, la boucle locale ou les métadonnées cloud, et ne stocke rien', async () => {
    for (const endpoint of [
      'https://10.1.20.5/push',
      'https://10.1.20.5:2283/api',
      'https://127.0.0.1:6379/',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/x',
      'https://localhost/x',
      'https://immich/x',
      'http://93.184.216.34/push', // pas https
      'https://user:mdp@93.184.216.34/push',
      'https://93.184.216.34:8443/push',
    ]) {
      const r = await abonner(alice, endpoint);
      expect([endpoint, r.statut]).toEqual([endpoint, 400]);
    }
    expect(compte()).toBe(0);
  });

  it('refuse sans distinguer les causes : même réponse pour toutes les cibles interdites', async () => {
    const a = await abonner(alice, 'https://10.1.20.5/push');
    const b = await abonner(alice, 'https://169.254.169.254/x');
    expect(a.corps).toEqual({ error: 'push.endpoint_invalide' });
    expect(b.corps).toEqual(a.corps);
  });

  it('accepte un endpoint public', async () => {
    const r = await abonner(alice, PUBLIC);
    expect(r.statut).toBe(201);
    expect(compte()).toBe(1);
  });

  it('refuse un champ inconnu dans le corps', async () => {
    const r = await alice.post('/api/moi/push/abonnement', { endpoint: PUBLIC, keys: cles(), extra: 1 });
    expect(r.statut).toBe(400);
  });

  it('POST /push/test rend un accusé neutre qui ne dépend pas de la cible', async () => {
    const vide = await alice.post('/api/moi/push/test');
    expect(vide.statut).toBe(202);
    expect(vide.corps).toEqual({ ok: true, appareils: 0 });

    // Ligne antérieure au contrôle, vers une cible interne : le test ne l'atteint pas et n'en dit rien.
    d.sql
      .prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy-1', (d.sql.prepare("SELECT id FROM users WHERE username = 'alice_m'").pluck().get() as string), 'https://10.1.20.5/push', cles().p256dh, cles().auth, '2026-11-15T12:00:00Z');
    const r = await alice.post('/api/moi/push/test');
    expect(r.statut).toBe(202);
    expect(r.corps).toEqual({ ok: true, appareils: 1 });
    expect(r.corps).not.toHaveProperty('envoyes');
    expect(r.corps).not.toHaveProperty('echecs');
  });

  it('la cadence borne les enregistrements et les tests (429)', async () => {
    let dernier = 0;
    for (let i = 0; i < 12; i++) dernier = (await alice.post('/api/moi/push/test')).statut;
    expect(dernier).toBe(429);
    const r = await abonner(alice, PUBLIC);
    expect(r.statut).toBe(429); // même clé de cadence `push` pour le compte
  });

  it('un endpoint repris par un autre compte quitte le premier (navigateur partagé)', async () => {
    expect((await abonner(alice, PUBLIC)).statut).toBe(201);
    expect((await abonner(bob, PUBLIC)).statut).toBe(201);
    expect(compte()).toBe(1);
    expect((await alice.get('/api/moi/push/cle')).corps['nb_appareils']).toBe(0);
    expect((await bob.get('/api/moi/push/cle')).corps['nb_appareils']).toBe(1);
  });

  it('une seule clé VAPID est générée, persistée et servie à tous les comptes', async () => {
    const cle = (await alice.get('/api/moi/push/cle')).corps['cle_publique'];
    const autre = (await bob.get('/api/moi/push/cle')).corps['cle_publique'];
    expect(cle).toBe(autre);
    expect(d.sql.prepare('SELECT count(*) FROM push_config').pluck().get()).toBe(1);
  });
});
