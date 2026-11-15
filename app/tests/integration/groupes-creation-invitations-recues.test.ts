import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JOUR_MS } from '../../server/domain/instant.js';
import type { Decor } from '../fixtures/comptes.js';
import { decor, groupe, personne, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';

// Création de groupe et invitations REÇUES (liste, acceptation, refus, lien) — lot 3.
describe('création de groupe', () => {
  let d: Decor;
  let alice: Personne;
  beforeEach(async () => {
    d = decor();
    alice = await personne(d, 'alice_m');
  });
  afterEach(() => d.nettoyer());

  it('le créateur devient administrateur ; un compte peut avoir plusieurs groupes', async () => {
    const r = await alice.client.post('/api/groupes', { name: '  Les potes de l’été  ' });
    expect(r.statut).toBe(201);
    expect(r.corps).toMatchObject({ name: 'Les potes de l’été', mon_role: 'admin' });
    await alice.client.post('/api/groupes', { name: 'Les collègues', default_currency_code: 'CHF', time_zone: 'Europe/Zurich' });
    const liste = (await alice.client.get('/api/groupes')).corps['groupes'] as Array<{ name: string; role: string }>;
    expect(liste.map((g) => [g.name, g.role]).sort()).toEqual([['Les collègues', 'admin'], ['Les potes de l’été', 'admin']]);
    const detail = await alice.client.get(`/api/groupes/${r.corps['id'] as string}`);
    expect(detail.corps).toMatchObject({ default_currency_code: 'EUR', time_zone: 'Europe/Paris', mon_role: 'admin' });
  });

  it('le slug est en ASCII, porte un suffixe aléatoire, et deux groupes de même nom ne partagent pas le leur', async () => {
    await alice.client.post('/api/groupes', { name: 'Été à Zürich !' });
    await alice.client.post('/api/groupes', { name: 'Été à Zürich !' });
    const slugs = d.sql.prepare('SELECT slug FROM groups ORDER BY slug').pluck().all() as string[];
    expect(slugs).toHaveLength(2);
    expect(slugs.every((s) => /^ete-a-zurich-[0-9a-f]{8}$/.test(s))).toBe(true);
    expect(new Set(slugs).size).toBe(2);
  });

  it.each([
    ['nom vide', { name: ' ' }],
    ['nom trop long', { name: 'x'.repeat(81) }],
    ['caractère de contrôle', { name: 'a\u0007b' }],
    ['fuseau inconnu', { name: 'G', time_zone: 'Mars/Olympus' }],
    ['devise mal formée', { name: 'G', default_currency_code: 'euro' }],
    ['champ inattendu (créateur imposé)', { name: 'G', created_by_user_id: 'autre' }],
  ])('refuse %s', async (_nom, corps) => {
    expect((await alice.client.post('/api/groupes', corps)).statut).toBe(400);
    expect(d.sql.prepare('SELECT count(*) FROM groups').pluck().get()).toBe(0);
  });

  it('refuse une devise inconnue sans rien créer', async () => {
    const r = await alice.client.post('/api/groupes', { name: 'G', default_currency_code: 'ZZZ' });
    expect(r.statut).toBe(400);
    expect(r.corps).toEqual({ error: 'groupe.devise_inconnue' });
    expect(d.sql.prepare('SELECT count(*) FROM groups').pluck().get()).toBe(0);
  });

  it('exige une session', async () => {
    expect((await d.client().post('/api/groupes', { name: 'G' })).statut).toBe(401);
  });

  it('GET /api/moi porte les groupes et le nombre d’invitations en attente', async () => {
    const moi = await alice.client.get('/api/moi');
    expect(moi.corps).toMatchObject({ groupes: [], invitations_en_attente: 0 });
    await alice.client.post('/api/groupes', { name: 'G' });
    expect(((await alice.client.get('/api/moi')).corps['groupes'] as unknown[]).length).toBe(1);
  });
});

describe('invitations reçues', () => {
  let d: Decor;
  let alice: Personne; // administratrice
  let bob: Personne; // invité
  let carole: Personne; // tierce
  let g: GroupeAmorce;
  beforeEach(async () => {
    d = decor();
    alice = await personne(d, 'alice_m');
    bob = await personne(d, 'bob_m');
    carole = await personne(d, 'carole_m');
    g = await groupe(d, 'Les potes', [{ personne: alice, role: 'admin' }]);
  });
  afterEach(() => d.nettoyer());

  const inviter = (corps: unknown): ReturnType<Personne['client']['post']> => alice.client.post(`/api/groupes/${g.groupId}/invitations`, corps);
  const recues = async (p: Personne): Promise<Array<Record<string, unknown>>> => (await p.client.get('/api/moi/invitations')).corps['invitations'] as Array<Record<string, unknown>>;
  const membreLigne = (p: Personne): { id: string; status: string; role: string; ended_at: string | null } | undefined =>
    d.sql.prepare('SELECT id, status, role, ended_at FROM memberships WHERE group_id = ? AND user_id = ?').get(g.groupId, p.userId) as never;

  describe('par nom d’utilisateur', () => {
    it('apparaît chez le destinataire seul, avec le badge, sans identifiant de groupe', async () => {
      await inviter({ username: 'bob_m', role: 'admin', message: 'Viens' });
      const [recue] = await recues(bob);
      expect(recue).toMatchObject({ group_name: 'Les potes', invited_by_name: 'alice_m', role: 'admin', message: 'Viens' });
      expect(JSON.stringify(recue)).not.toContain(g.groupId);
      expect((await bob.client.get('/api/moi')).corps['invitations_en_attente']).toBe(1);
      expect(await recues(carole)).toEqual([]);
      expect((await carole.client.get('/api/moi')).corps['invitations_en_attente']).toBe(0);
    });

    it('accepter crée l’appartenance avec le rôle proposé, une seule fois', async () => {
      await inviter({ username: 'bob_m', role: 'admin' });
      const id = (await recues(bob))[0]?.['id'] as string;
      expect(membreLigne(bob)).toBeUndefined();
      expect((await bob.client.post(`/api/moi/invitations/${id}/acceptation`)).statut).toBe(200);
      expect(membreLigne(bob)).toMatchObject({ status: 'active', role: 'admin' });
      expect(d.sql.prepare('SELECT status, resulting_membership_id FROM invitations WHERE id = ?').get(id)).toEqual({ status: 'accepted', resulting_membership_id: membreLigne(bob)?.id });
      expect((await bob.client.get(`/api/groupes/${g.groupId}`)).statut).toBe(200);
      expect((await bob.client.post(`/api/moi/invitations/${id}/acceptation`)).statut).toBe(404); // usage unique
      expect(await recues(bob)).toEqual([]);
    });

    it('refuser ferme l’invitation sans créer d’appartenance', async () => {
      await inviter({ username: 'bob_m' });
      const id = (await recues(bob))[0]?.['id'] as string;
      expect((await bob.client.post(`/api/moi/invitations/${id}/refus`)).statut).toBe(200);
      expect(d.sql.prepare('SELECT status FROM invitations WHERE id = ?').pluck().get(id)).toBe('declined');
      expect(membreLigne(bob)).toBeUndefined();
      expect((await bob.client.post(`/api/moi/invitations/${id}/acceptation`)).statut).toBe(404);
      expect((await bob.client.post(`/api/moi/invitations/${id}/refus`)).statut).toBe(404);
    });

    it('l’invitation d’un autre compte est introuvable, en lecture comme en écriture', async () => {
      await inviter({ username: 'bob_m' });
      const id = (await recues(bob))[0]?.['id'] as string;
      for (const action of ['acceptation', 'refus']) {
        const r = await carole.client.post(`/api/moi/invitations/${id}/${action}`);
        expect(r.statut).toBe(404);
        expect(r.corps).toEqual({ error: 'invitation.introuvable' });
      }
      expect(d.sql.prepare('SELECT status FROM invitations WHERE id = ?').pluck().get(id)).toBe('pending');
      expect(membreLigne(carole)).toBeUndefined();
    });

    it('une invitation échue ou révoquée ne s’accepte plus', async () => {
      await inviter({ username: 'bob_m' });
      const id = (await recues(bob))[0]?.['id'] as string;
      d.temps.avancer(15 * JOUR_MS);
      expect(await recues(bob)).toEqual([]);
      expect((await bob.client.post(`/api/moi/invitations/${id}/acceptation`)).statut).toBe(404);
      await inviter({ username: 'bob_m' });
      const neuve = (await recues(bob))[0]?.['id'] as string;
      const liste = (await alice.client.get(`/api/groupes/${g.groupId}/invitations`)).corps['invitations'] as Array<{ id: string; status: string }>;
      expect(liste.find((i) => i.id === neuve)?.status).toBe('pending');
      await alice.client.delete(`/api/groupes/${g.groupId}/invitations/${neuve}`);
      expect((await bob.client.post(`/api/moi/invitations/${neuve}/acceptation`)).statut).toBe(404);
    });

    it('un groupe supprimé n’invite plus personne', async () => {
      await inviter({ username: 'bob_m' });
      d.sql.prepare('UPDATE groups SET deleted_at = ? WHERE id = ?').run('2026-11-16T00:00:00Z', g.groupId);
      expect(await recues(bob)).toEqual([]);
    });

    it('un membre déjà actif n’entre pas deux fois', async () => {
      await inviter({ username: 'bob_m' });
      const id = (await recues(bob))[0]?.['id'] as string;
      // Entré entre-temps par une autre invitation : la ligne existe déjà.
      d.sql
        .prepare("INSERT INTO memberships (id, group_id, user_id, role, joined_at, created_at, updated_at) VALUES ('mx', ?, ?, 'member', 'x', 'x', 'x')")
        .run(g.groupId, bob.userId);
      const r = await bob.client.post(`/api/moi/invitations/${id}/acceptation`);
      expect(r.statut).toBe(409);
      expect(r.corps).toEqual({ error: 'membre.deja' });
      expect(d.sql.prepare('SELECT count(*) FROM memberships WHERE group_id = ? AND user_id = ?').pluck().get(g.groupId, bob.userId)).toBe(1);
    });

    it('exige une session', async () => {
      expect((await d.client().get('/api/moi/invitations')).statut).toBe(401);
      expect((await d.client().post('/api/moi/invitations/x/acceptation')).statut).toBe(401);
    });
  });

  describe('réintégration', () => {
    it('un ancien membre revient sur SA ligne : pas de doublon, historique retrouvé', async () => {
      const bobDansG = await (async (): Promise<string> => {
        await inviter({ username: 'bob_m' });
        await bob.client.post(`/api/moi/invitations/${(await recues(bob))[0]?.['id'] as string}/acceptation`);
        return membreLigne(bob)?.id ?? '';
      })();
      d.sql
        .prepare(`INSERT INTO threads (id, group_id, title, kind, created_by_membership_id, created_at, updated_at) VALUES ('t1', ?, 'Fil', 'free', ?, 'x', 'x')`)
        .run(g.groupId, bobDansG);
      expect((await alice.client.delete(`/api/groupes/${g.groupId}/membres/${bobDansG}`)).statut).toBe(200);
      expect(membreLigne(bob)).toMatchObject({ status: 'removed' });

      d.temps.avancer(1000);
      await inviter({ username: 'bob_m', role: 'admin' });
      expect((await bob.client.post(`/api/moi/invitations/${(await recues(bob))[0]?.['id'] as string}/acceptation`)).statut).toBe(200);

      expect(d.sql.prepare('SELECT count(*) FROM memberships WHERE group_id = ? AND user_id = ?').pluck().get(g.groupId, bob.userId)).toBe(1);
      expect(membreLigne(bob)).toEqual({ id: bobDansG, status: 'active', role: 'admin', ended_at: null });
      expect(d.sql.prepare("SELECT created_by_membership_id FROM threads WHERE id = 't1'").pluck().get()).toBe(bobDansG);
      expect((await bob.client.get(`/api/groupes/${g.groupId}`)).statut).toBe(200);
    });

    it('un membre parti revient de la même façon', async () => {
      await inviter({ username: 'bob_m' });
      await bob.client.post(`/api/moi/invitations/${(await recues(bob))[0]?.['id'] as string}/acceptation`);
      const avant = membreLigne(bob)?.id;
      await bob.client.post(`/api/groupes/${g.groupId}/depart`);
      expect(membreLigne(bob)?.status).toBe('left');
      await inviter({ username: 'bob_m' });
      await bob.client.post(`/api/moi/invitations/${(await recues(bob))[0]?.['id'] as string}/acceptation`);
      expect(membreLigne(bob)).toMatchObject({ id: avant, status: 'active' });
    });
  });

  describe('par lien', () => {
    const jetonPour = async (p: Personne): Promise<string> => d.jetonMail(p.email, 'invitation_groupe');

    it('l’aperçu est public, nomme le groupe et l’invitant, et ne livre pas l’adresse invitée', async () => {
      await inviter({ email: bob.email });
      const jeton = await jetonPour(bob);
      const r = await d.client('198.51.100.5').post('/api/invitations/apercu', { token: jeton });
      expect(r.statut).toBe(200);
      expect(r.corps).toMatchObject({ etat: 'en_attente', group_name: 'Les potes', invited_by_name: 'alice_m', role: 'member' });
      expect(JSON.stringify(r.corps)).not.toContain('exemple.test');
      expect(JSON.stringify(r.corps)).not.toContain(g.groupId);
    });

    it('accepte pour le compte dont l’adresse est vérifiée et identique, une seule fois', async () => {
      await inviter({ email: bob.email.toUpperCase() });
      const jeton = await jetonPour(bob);
      expect((await d.client().post('/api/invitations/acceptation', { token: jeton })).statut).toBe(401);
      expect((await bob.client.post('/api/invitations/acceptation', { token: jeton })).statut).toBe(200);
      expect(membreLigne(bob)).toMatchObject({ status: 'active', role: 'member' });
      const encore = await bob.client.post('/api/invitations/acceptation', { token: jeton });
      expect(encore.statut).toBe(410);
      expect(encore.corps).toEqual({ error: 'invitation.deja_utilisee' });
      expect((await d.client().post('/api/invitations/apercu', { token: jeton })).statut).toBe(410);
    });

    it('FUITE ENTRE GROUPES : une adresse inscrite mais NON vérifiée ne récupère rien', async () => {
      const victime = 'victime@exemple.test';
      // L'attaquant inscrit l'adresse de la victime avant elle, sans pouvoir la vérifier.
      const pirate = await personne(d, 'victime', { verifie: false });
      expect(pirate.email).toBe(victime);
      await inviter({ email: victime });
      expect(await recues(pirate)).toEqual([]);
      expect((await pirate.client.get('/api/moi')).corps['invitations_en_attente']).toBe(0);
      // Même muni du lien (transféré, intercepté…), il n'entre pas.
      const jeton = await jetonPour(pirate);
      const r = await pirate.client.post('/api/invitations/acceptation', { token: jeton });
      expect(r.statut).toBe(403);
      expect(r.corps).toEqual({ error: 'invitation.adresse_non_verifiee' });
      expect(membreLigne(pirate)).toBeUndefined();
      expect(d.sql.prepare("SELECT status FROM invitations WHERE email = ?").pluck().get(victime)).toBe('pending');
      // Une fois l'adresse réellement vérifiée (par le lien reçu dans SA boîte), l'invitation s'accepte.
      const verif = await d.jetonMail(victime, 'verification_email');
      expect((await pirate.client.post('/api/auth/email/verification', { token: verif })).statut).toBe(200);
      expect((await pirate.client.post('/api/invitations/acceptation', { token: jeton })).statut).toBe(200);
    });

    it('un compte d’une AUTRE adresse, même vérifiée, ne peut pas se servir du lien (404)', async () => {
      await inviter({ email: bob.email });
      const jeton = await jetonPour(bob);
      const r = await carole.client.post('/api/invitations/acceptation', { token: jeton });
      expect(r.statut).toBe(404);
      expect(r.corps).toEqual({ error: 'invitation.introuvable' });
      expect(membreLigne(carole)).toBeUndefined();
      expect(d.sql.prepare('SELECT status FROM invitations WHERE email = ?').pluck().get(bob.email)).toBe('pending');
    });

    it('lien révoqué, expiré, inconnu ou mal formé', async () => {
      await inviter({ email: bob.email });
      const jeton = await jetonPour(bob);
      const id = d.sql.prepare('SELECT id FROM invitations WHERE email = ?').pluck().get(bob.email) as string;
      expect((await bob.client.post('/api/invitations/apercu', { token: jeton })).statut).toBe(200);
      d.temps.avancer(15 * JOUR_MS);
      const expire = await bob.client.post('/api/invitations/acceptation', { token: jeton });
      expect([expire.statut, expire.corps]).toEqual([410, { error: 'invitation.expiree' }]);
      d.temps.avancer(-15 * JOUR_MS);
      await alice.client.delete(`/api/groupes/${g.groupId}/invitations/${id}`);
      const revoque = await bob.client.post('/api/invitations/acceptation', { token: jeton });
      expect([revoque.statut, revoque.corps]).toEqual([410, { error: 'invitation.revoquee' }]);
      expect(membreLigne(bob)).toBeUndefined();
      expect((await bob.client.post('/api/invitations/apercu', { token: 'A'.repeat(43) })).statut).toBe(404);
      expect((await bob.client.post('/api/invitations/apercu', { token: 'trop-court' })).statut).toBe(404);
      expect((await bob.client.post('/api/invitations/acceptation', { token: 'A'.repeat(43) })).statut).toBe(404);
    });
  });
});
