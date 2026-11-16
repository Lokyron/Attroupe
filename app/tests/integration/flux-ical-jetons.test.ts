import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Decor } from '../fixtures/comptes.js';
import { decor, groupe, personne, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';

// Gestion des abonnements calendrier (lot 5) : /api/moi/flux-ical. Le jeton n'existe en clair qu'à la création ; la base n'en garde que
// l'empreinte ; un abonnement d'un autre compte est introuvable (404) ; restreindre un jeton à un groupe exige l'appartenance ACTIVE.
describe('abonnements calendrier : /api/moi/flux-ical', () => {
  let d: Decor;
  let alice: Personne;
  let bob: Personne;
  let ga: GroupeAmorce;
  let gb: GroupeAmorce;

  beforeEach(async () => {
    d = decor();
    alice = await personne(d, 'alice_f');
    bob = await personne(d, 'bob_f');
    ga = await groupe(d, 'Groupe A', [{ personne: alice, role: 'member' }]);
    gb = await groupe(d, 'Groupe B secret', [{ personne: bob, role: 'admin' }]);
  });
  afterEach(() => d.nettoyer());

  const lignes = (): Array<Record<string, unknown>> => d.sql.prepare('SELECT * FROM calendar_feed_tokens ORDER BY rowid').all() as Array<Record<string, unknown>>;

  describe('création', () => {
    it('rend le jeton en clair UNE fois, avec l’URL complète, et n’en stocke que l’empreinte SHA-256', async () => {
      const r = await alice.client.post('/api/moi/flux-ical', { label: 'Mon iPhone' });
      expect(r.statut).toBe(201);
      const jeton = r.corps['token'] as string;
      expect(jeton).toMatch(/^[a-z2-7]{52}$/);
      expect(r.corps['url']).toBe(`https://attroupe.test/ical/${jeton}.ics`);
      expect(r.corps).toMatchObject({ label: 'Mon iPhone', group_id: null, group_name: null, include_personal: 0, include_declined: 1, last_used_at: null, revoked_at: null });
      const [ligne] = lignes();
      expect(ligne?.['token_hash']).toBe(createHash('sha256').update(jeton, 'utf8').digest('hex'));
      expect(JSON.stringify(ligne)).not.toContain(jeton);
      expect(ligne?.['user_id']).toBe(alice.userId);
    });

    it('deux jetons ne sont jamais égaux', async () => {
      const x = (await alice.client.post('/api/moi/flux-ical', {})).corps['token'];
      const y = (await alice.client.post('/api/moi/flux-ical', {})).corps['token'];
      expect(x).not.toBe(y);
    });

    it('enregistre les réglages demandés', async () => {
      const r = await alice.client.post('/api/moi/flux-ical', { include_personal: true, include_declined: false, group_id: ga.groupId });
      expect(r.statut).toBe(201);
      expect(r.corps).toMatchObject({ include_personal: 1, include_declined: 0, group_id: ga.groupId, group_name: 'Groupe A' });
    });

    it('plafonne à 20 abonnements ACTIFS par compte (409 flux.plafond) ; en révoquer un libère une place ; ceux des autres comptes ne comptent pas', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        // Hors cadence : la cadence de création est testée à part, l'horloge avance d'une heure à chaque lot de dix.
        if (i === 10) d.temps.avancer(3_600_000);
        const r = await alice.client.post('/api/moi/flux-ical', {});
        expect(r.statut, `abonnement ${String(i + 1)}`).toBe(201);
        ids.push(r.corps['id'] as string);
      }
      d.temps.avancer(3_600_000);
      const trop = await alice.client.post('/api/moi/flux-ical', {});
      expect(trop.statut).toBe(409);
      expect(trop.corps).toEqual({ error: 'flux.plafond' });
      expect(lignes().filter((l) => l['user_id'] === alice.userId)).toHaveLength(20);
      expect((await bob.client.post('/api/moi/flux-ical', {})).statut).toBe(201);
      await alice.client.delete(`/api/moi/flux-ical/${ids[0] as string}`);
      expect((await alice.client.post('/api/moi/flux-ical', {})).statut).toBe(201);
    });

    it('applique la cadence de création par compte : 429 au-delà de 10 créations par quart d’heure', async () => {
      for (let i = 0; i < 10; i++) expect((await alice.client.post('/api/moi/flux-ical', {})).statut).toBe(201);
      const r = await alice.client.post('/api/moi/flux-ical', {});
      expect(r.statut).toBe(429);
      expect(r.corps).toEqual({ error: 'cadence.depassee' });
      expect(Number(r.entetes['retry-after'])).toBeGreaterThan(0);
    });

    it('exige une session', async () => {
      const r = await d.client('203.0.113.50').post('/api/moi/flux-ical', {});
      expect(r.statut).toBe(401);
    });

    it('refuse un champ inattendu (aucune affectation de masse : ni user_id ni token_hash ne s’imposent)', async () => {
      for (const corps of [{ user_id: bob.userId }, { token_hash: 'abc' }, { revoked_at: null }, { include_declined: 'oui' }, { label: '' }, { label: 'a\nb' }]) {
        const r = await alice.client.post('/api/moi/flux-ical', corps);
        expect({ corps, statut: r.statut }).toEqual({ corps, statut: 400 });
      }
      expect(lignes()).toEqual([]);
    });

    it('restreint à un groupe dont on n’est pas membre : 404 groupe.introuvable, identique à un groupe inexistant, rien d’écrit', async () => {
      const etranger = await alice.client.post('/api/moi/flux-ical', { group_id: gb.groupId });
      const inexistant = await alice.client.post('/api/moi/flux-ical', { group_id: '00000000-0000-7000-8000-000000000000' });
      expect(etranger.statut).toBe(404);
      expect(etranger.corps).toEqual({ error: 'groupe.introuvable' });
      expect({ statut: etranger.statut, corps: etranger.corps }).toEqual({ statut: inexistant.statut, corps: inexistant.corps });
      expect(lignes()).toEqual([]);
    });

    it('restreint à un groupe QUITTÉ ou dont on a été retiré : 404, jamais 403', async () => {
      d.sql.prepare("UPDATE memberships SET status = 'removed', ended_at = ? WHERE group_id = ? AND user_id = ?").run('2026-11-16T00:00:00Z', ga.groupId, alice.userId);
      const r = await alice.client.post('/api/moi/flux-ical', { group_id: ga.groupId });
      expect(r.statut).toBe(404);
      expect(r.corps).toEqual({ error: 'groupe.introuvable' });
      expect(lignes()).toEqual([]);
    });
  });

  describe('liste', () => {
    it('ne rend JAMAIS le jeton ni son empreinte, seulement les métadonnées', async () => {
      const cree = await alice.client.post('/api/moi/flux-ical', { label: 'Android', group_id: ga.groupId });
      const jeton = cree.corps['token'] as string;
      const r = await alice.client.get('/api/moi/flux-ical');
      expect(r.statut).toBe(200);
      const texte = JSON.stringify(r.corps);
      expect(texte).not.toContain(jeton);
      expect(texte).not.toContain('token');
      expect(texte).not.toContain(createHash('sha256').update(jeton, 'utf8').digest('hex'));
      expect(r.corps['abonnements']).toEqual([
        {
          id: cree.corps['id'],
          label: 'Android',
          group_id: ga.groupId,
          group_name: 'Groupe A',
          include_personal: 0,
          include_declined: 1,
          created_at: expect.any(String) as string,
          last_used_at: null,
          last_user_agent: null,
          revoked_at: null,
        },
      ]);
    });

    it('ne montre que MES abonnements', async () => {
      await alice.client.post('/api/moi/flux-ical', { label: 'à Alice' });
      await bob.client.post('/api/moi/flux-ical', { label: 'à Bob' });
      const r = await alice.client.get('/api/moi/flux-ical');
      expect((r.corps['abonnements'] as Array<{ label: string }>).map((a) => a.label)).toEqual(['à Alice']);
      expect(JSON.stringify(r.corps)).not.toContain('Groupe B secret');
    });

    it('garde les abonnements révoqués, marqués comme tels', async () => {
      const cree = await alice.client.post('/api/moi/flux-ical', {});
      await alice.client.delete(`/api/moi/flux-ical/${cree.corps['id'] as string}`);
      const r = await alice.client.get('/api/moi/flux-ical');
      const [a] = r.corps['abonnements'] as Array<{ revoked_at: string | null }>;
      expect(a?.revoked_at).toEqual(expect.any(String));
    });

    it('ne nomme pas un groupe quitté', async () => {
      await alice.client.post('/api/moi/flux-ical', { group_id: ga.groupId });
      d.sql.prepare("UPDATE memberships SET status = 'left', ended_at = ? WHERE group_id = ? AND user_id = ?").run('2026-11-16T00:00:00Z', ga.groupId, alice.userId);
      const [a] = (await alice.client.get('/api/moi/flux-ical')).corps['abonnements'] as Array<{ group_name: string | null }>;
      expect(a?.group_name).toBeNull();
    });
  });

  describe('révocation', () => {
    it('pose revoked_at, ne supprime jamais la ligne', async () => {
      const cree = await alice.client.post('/api/moi/flux-ical', {});
      const r = await alice.client.delete(`/api/moi/flux-ical/${cree.corps['id'] as string}`);
      expect(r.statut).toBe(200);
      const [ligne] = lignes();
      expect(ligne?.['revoked_at']).toBe('2026-11-15T12:00:00Z');
    });

    it('révoquer deux fois est sans effet (la date de la première révocation reste)', async () => {
      const cree = await alice.client.post('/api/moi/flux-ical', {});
      const id = cree.corps['id'] as string;
      await alice.client.delete(`/api/moi/flux-ical/${id}`);
      d.temps.avancer(3_600_000);
      expect((await alice.client.delete(`/api/moi/flux-ical/${id}`)).statut).toBe(200);
      expect(lignes()[0]?.['revoked_at']).toBe('2026-11-15T12:00:00Z');
    });

    it('le jeton d’un AUTRE compte : 404 flux.introuvable, comme un identifiant inconnu, et il reste valide', async () => {
      const deBob = await bob.client.post('/api/moi/flux-ical', {});
      const etranger = await alice.client.delete(`/api/moi/flux-ical/${deBob.corps['id'] as string}`);
      const inconnu = await alice.client.delete('/api/moi/flux-ical/00000000-0000-7000-8000-000000000000');
      expect(etranger.statut).toBe(404);
      expect(etranger.corps).toEqual({ error: 'flux.introuvable' });
      expect({ statut: etranger.statut, corps: etranger.corps }).toEqual({ statut: inconnu.statut, corps: inconnu.corps });
      expect(lignes()[0]?.['revoked_at']).toBeNull();
      expect((await d.client('203.0.113.51').get(`/ical/${deBob.corps['token'] as string}.ics`)).statut).toBe(200);
    });
  });
});
