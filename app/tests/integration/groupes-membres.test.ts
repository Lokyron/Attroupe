import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nouvelIdentifiant } from '../../server/db/identifiant.js';
import { decor, groupe, membreDe, personne, T0, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';
import type { Decor } from '../fixtures/comptes.js';

// Groupe, membres, rôles, retrait, départ (lot 3) et les règles d'intégrité de l'ADR-0009.
describe('groupe et membres', () => {
  let d: Decor;
  let alice: Personne; // administratrice
  let bob: Personne; // membre
  let carole: Personne; // membre
  let g: GroupeAmorce;
  beforeEach(async () => {
    d = decor();
    alice = await personne(d, 'alice_m');
    bob = await personne(d, 'bob_m');
    carole = await personne(d, 'carole_m');
    g = await groupe(d, 'Les potes', [
      { personne: alice, role: 'admin' },
      { personne: bob, role: 'member' },
      { personne: carole, role: 'member' },
    ]);
  });
  afterEach(() => d.nettoyer());

  const statutMembre = (p: Personne): { status: string; role: string; ended_at: string | null } =>
    d.sql.prepare('SELECT status, role, ended_at FROM memberships WHERE group_id = ? AND user_id = ?').get(g.groupId, p.userId) as {
      status: string;
      role: string;
      ended_at: string | null;
    };

  describe('lecture', () => {
    it('le sélecteur ne rend que mes groupes', async () => {
      const autre = await groupe(d, 'Les collègues', [{ personne: bob, role: 'admin' }]);
      const r = await alice.client.get('/api/groupes');
      expect(r.statut).toBe(200);
      expect((r.corps['groupes'] as Array<{ group_id: string }>).map((x) => x.group_id)).toEqual([g.groupId]);
      expect(JSON.stringify(r.corps)).not.toContain(autre.groupId);
      const rb = await bob.client.get('/api/groupes');
      expect((rb.corps['groupes'] as Array<{ group_id: string }>).map((x) => x.group_id).sort()).toEqual([g.groupId, autre.groupId].sort());
    });

    it('le détail donne mon rôle et ne révèle pas le créateur', async () => {
      const r = await bob.client.get(`/api/groupes/${g.groupId}`);
      expect(r.statut).toBe(200);
      expect(r.corps).toMatchObject({ id: g.groupId, name: 'Les potes', default_currency_code: 'EUR', mon_role: 'member', mon_appartenance_id: membreDe(g, bob) });
      expect(r.corps).not.toHaveProperty('created_by_user_id');
    });

    it('la liste des membres ne porte ni adresse e-mail ni nom d’utilisateur', async () => {
      const r = await bob.client.get(`/api/groupes/${g.groupId}/membres`);
      expect(r.statut).toBe(200);
      const membres = r.corps['membres'] as Array<Record<string, unknown>>;
      expect(membres).toHaveLength(3);
      expect(membres.every((m) => m['status'] === 'active')).toBe(true);
      expect(JSON.stringify(r.corps)).not.toContain('exemple.test');
      // (le nom affiché vaut le nom d'utilisateur par défaut : on contrôle les CLÉS, pas la valeur)
      expect(membres.flatMap((m) => Object.keys(m)).sort()).toEqual(
        [...Array<string[]>(3).fill(['display_name', 'ended_at', 'id', 'joined_at', 'nickname', 'role', 'status'])].flat().sort(),
      );
    });
  });

  describe('modification du groupe', () => {
    it('un administrateur renomme, change devise et fuseau', async () => {
      const r = await alice.client.patch(`/api/groupes/${g.groupId}`, { name: '  Les potes de toujours ', default_currency_code: 'CHF', time_zone: 'Europe/Zurich' });
      expect(r.statut).toBe(200);
      expect(r.corps).toMatchObject({ name: 'Les potes de toujours', default_currency_code: 'CHF', time_zone: 'Europe/Zurich' });
      expect(d.sql.prepare('SELECT name FROM groups WHERE id = ?').pluck().get(g.groupId)).toBe('Les potes de toujours');
    });

    it('un simple membre reçoit 403 (le droit manque, le groupe est le sien) et rien ne change', async () => {
      const r = await bob.client.patch(`/api/groupes/${g.groupId}`, { name: 'Piraté' });
      expect(r.statut).toBe(403);
      expect(r.corps).toEqual({ error: 'droit.admin_requis' });
      expect(d.sql.prepare('SELECT name FROM groups WHERE id = ?').pluck().get(g.groupId)).toBe('Les potes');
    });

    it.each([
      ['nom vide', { name: '   ' }],
      ['nom trop long', { name: 'x'.repeat(81) }],
      ['caractère de contrôle', { name: 'a\nb' }],
      ['fuseau inconnu', { time_zone: 'Mars/Olympus' }],
      ['champ inattendu', { slug: 'pirate' }],
      ['corps vide', {}],
    ])('refuse %s', async (_nom, corps) => {
      expect((await alice.client.patch(`/api/groupes/${g.groupId}`, corps)).statut).toBe(400);
    });

    it('refuse une devise inconnue', async () => {
      const r = await alice.client.patch(`/api/groupes/${g.groupId}`, { default_currency_code: 'ZZZ' });
      expect(r.statut).toBe(400);
      expect(r.corps).toEqual({ error: 'groupe.devise_inconnue' });
    });

    it('un groupe supprimé n’existe plus pour ses membres, un groupe archivé passe en lecture seule', async () => {
      d.sql.prepare('UPDATE groups SET archived_at = ? WHERE id = ?').run(T0, g.groupId);
      expect((await alice.client.get(`/api/groupes/${g.groupId}`)).statut).toBe(200);
      const r = await alice.client.patch(`/api/groupes/${g.groupId}`, { name: 'Nouveau' });
      expect(r.statut).toBe(409);
      expect(r.corps).toEqual({ error: 'groupe.archive' });
      d.sql.prepare('UPDATE groups SET deleted_at = ? WHERE id = ?').run(T0, g.groupId);
      expect((await alice.client.get(`/api/groupes/${g.groupId}`)).statut).toBe(404);
      expect(((await alice.client.get('/api/groupes')).corps['groupes'] as unknown[]).length).toBe(0);
    });
  });

  describe('cloisonnement et rôles', () => {
    it('un non-membre reçoit 404 (jamais 403), identifiant exact fourni', async () => {
      const dave = await personne(d, 'dave_m');
      for (const chemin of ['', '/membres', '/invitations']) {
        const r = await dave.client.get(`/api/groupes/${g.groupId}${chemin}`);
        expect(r.statut).toBe(404);
        expect(r.corps).toEqual({ error: 'groupe.introuvable' });
      }
      // Même réponse qu'un groupe qui n'a jamais existé.
      expect((await dave.client.get(`/api/groupes/${nouvelIdentifiant()}`)).corps).toEqual({ error: 'groupe.introuvable' });
    });

    it('l’administrateur de l’instance n’a aucun accès au contenu d’un groupe', async () => {
      const root = await personne(d, 'root_m');
      d.sql.prepare('UPDATE users SET is_instance_admin = 1 WHERE id = ?').run(root.userId);
      expect((await root.client.get(`/api/groupes/${g.groupId}`)).statut).toBe(404);
      expect((await root.client.get(`/api/groupes/${g.groupId}/membres`)).statut).toBe(404);
      expect((await root.client.patch(`/api/groupes/${g.groupId}`, { name: 'Root' })).statut).toBe(404);
    });

    it('sans session : 401', async () => {
      expect((await d.client().get(`/api/groupes/${g.groupId}`)).statut).toBe(401);
      expect((await d.client().get('/api/groupes')).statut).toBe(401);
    });

    it('un ancien membre reçoit 404 alors que son historique est intact', async () => {
      expect((await alice.client.delete(`/api/groupes/${g.groupId}/membres/${membreDe(g, bob)}`)).statut).toBe(200);
      expect((await bob.client.get(`/api/groupes/${g.groupId}`)).statut).toBe(404);
      expect(((await bob.client.get('/api/groupes')).corps['groupes'] as unknown[]).length).toBe(0);
    });
  });

  describe('changement de rôle', () => {
    it('promeut un membre, qui peut alors administrer', async () => {
      expect((await alice.client.patch(`/api/groupes/${g.groupId}/membres/${membreDe(g, bob)}`, { role: 'admin' })).statut).toBe(200);
      expect(statutMembre(bob).role).toBe('admin');
      expect((await bob.client.patch(`/api/groupes/${g.groupId}`, { name: 'Géré par Bob' })).statut).toBe(200);
    });

    it('un simple membre ne change aucun rôle (403) et ne peut pas se promouvoir', async () => {
      const r = await bob.client.patch(`/api/groupes/${g.groupId}/membres/${membreDe(g, bob)}`, { role: 'admin' });
      expect(r.statut).toBe(403);
      expect(statutMembre(bob).role).toBe('member');
    });

    it('le dernier administrateur ne peut pas être rétrogradé, deux le peuvent chacun à leur tour', async () => {
      const soi = await alice.client.patch(`/api/groupes/${g.groupId}/membres/${membreDe(g, alice)}`, { role: 'member' });
      expect(soi.statut).toBe(409);
      expect(soi.corps).toEqual({ error: 'groupe.dernier_admin' });
      expect(statutMembre(alice).role).toBe('admin');

      await alice.client.patch(`/api/groupes/${g.groupId}/membres/${membreDe(g, bob)}`, { role: 'admin' });
      expect((await alice.client.patch(`/api/groupes/${g.groupId}/membres/${membreDe(g, alice)}`, { role: 'member' })).statut).toBe(200);
      // Bob est seul administrateur à son tour : il ne peut pas se rétrograder.
      const bobSeul = await bob.client.patch(`/api/groupes/${g.groupId}/membres/${membreDe(g, bob)}`, { role: 'member' });
      expect(bobSeul.statut).toBe(409);
    });

    it('refuse un rôle inconnu, et un membre retiré est inactif', async () => {
      expect((await alice.client.patch(`/api/groupes/${g.groupId}/membres/${membreDe(g, bob)}`, { role: 'owner' })).statut).toBe(400);
      await alice.client.delete(`/api/groupes/${g.groupId}/membres/${membreDe(g, bob)}`);
      const r = await alice.client.patch(`/api/groupes/${g.groupId}/membres/${membreDe(g, bob)}`, { role: 'admin' });
      expect(r.statut).toBe(409);
      expect(r.corps).toEqual({ error: 'membre.inactif' });
    });
  });

  describe('retrait et départ', () => {
    it('retirer marque l’appartenance (jamais supprimée) et la liste la garde comme ancien membre', async () => {
      expect((await alice.client.delete(`/api/groupes/${g.groupId}/membres/${membreDe(g, bob)}`)).statut).toBe(200);
      const ligne = statutMembre(bob);
      expect(ligne.status).toBe('removed');
      expect(ligne.ended_at).toEqual(expect.any(String));
      const membres = (await alice.client.get(`/api/groupes/${g.groupId}/membres`)).corps['membres'] as Array<{ id: string; status: string }>;
      expect(membres.map((m) => m.status)).toEqual(['active', 'active', 'removed']); // les actifs d'abord
      expect(membres.find((m) => m.id === membreDe(g, bob))?.status).toBe('removed');
      expect((await alice.client.delete(`/api/groupes/${g.groupId}/membres/${membreDe(g, bob)}`)).statut).toBe(409); // déjà retiré
    });

    it('un simple membre ne retire personne (403)', async () => {
      const r = await bob.client.delete(`/api/groupes/${g.groupId}/membres/${membreDe(g, carole)}`);
      expect(r.statut).toBe(403);
      expect(statutMembre(carole).status).toBe('active');
    });

    it('on ne se retire pas soi-même par la route de retrait (c’est le départ), et le dernier administrateur reste', async () => {
      const r = await alice.client.delete(`/api/groupes/${g.groupId}/membres/${membreDe(g, alice)}`);
      expect(r.statut).toBe(409);
      expect(r.corps).toEqual({ error: 'membre.retrait_de_soi' });
      // Un second administrateur ne peut pas retirer le dernier autre administrateur... sauf s'il en reste un.
      await alice.client.patch(`/api/groupes/${g.groupId}/membres/${membreDe(g, bob)}`, { role: 'admin' });
      expect((await bob.client.delete(`/api/groupes/${g.groupId}/membres/${membreDe(g, alice)}`)).statut).toBe(200);
      expect(statutMembre(alice).status).toBe('removed');
    });

    it('le départ volontaire marque « left » ; le dernier administrateur ne part pas, même seul', async () => {
      expect((await bob.client.post(`/api/groupes/${g.groupId}/depart`)).statut).toBe(200);
      expect(statutMembre(bob).status).toBe('left');
      expect((await bob.client.get(`/api/groupes/${g.groupId}`)).statut).toBe(404);
      expect((await bob.client.post(`/api/groupes/${g.groupId}/depart`)).statut).toBe(404); // déjà parti

      const refus = await alice.client.post(`/api/groupes/${g.groupId}/depart`);
      expect(refus.statut).toBe(409);
      expect(refus.corps).toEqual({ error: 'groupe.dernier_admin' });
      // Seule membre restante : le groupe ne se retrouve pas sans administrateur.
      await alice.client.delete(`/api/groupes/${g.groupId}/membres/${membreDe(g, carole)}`);
      expect((await alice.client.post(`/api/groupes/${g.groupId}/depart`)).statut).toBe(409);
      expect(statutMembre(alice).status).toBe('active');
    });

    it('un administrateur part dès qu’un autre administrateur existe', async () => {
      await alice.client.patch(`/api/groupes/${g.groupId}/membres/${membreDe(g, bob)}`, { role: 'admin' });
      expect((await alice.client.post(`/api/groupes/${g.groupId}/depart`)).statut).toBe(200);
      expect(statutMembre(alice).status).toBe('left');
      const admins = d.sql.prepare("SELECT count(*) FROM memberships WHERE group_id = ? AND role = 'admin' AND status = 'active'").pluck().get(g.groupId);
      expect(admins).toBe(1);
    });

    it('un membre retiré ne perd pas son historique', async () => {
      const m = membreDe(g, carole);
      d.sql
        .prepare(`INSERT INTO threads (id, group_id, title, kind, created_by_membership_id, created_at, updated_at) VALUES ('t1', ?, 'Fil', 'free', ?, ?, ?)`)
        .run(g.groupId, m, T0, T0);
      d.sql
        .prepare(`INSERT INTO messages (id, thread_id, group_id, author_membership_id, body, created_at) VALUES ('msg1', 't1', ?, ?, 'Salut', ?)`)
        .run(g.groupId, m, T0);
      d.sql
        .prepare(
          `INSERT INTO expenses (id, group_id, label, spent_on, payer_membership_id, amount_minor, currency_code, target_currency_code, rate_ppm,
             rate_source, amount_target_minor, split_mode, created_by_membership_id, created_at, updated_at)
           VALUES ('x1', ?, 'Pizzas', '2026-11-01', ?, 1000, 'EUR', 'EUR', 1000000, 'identity', 1000, 'equal', ?, ?, ?)`,
        )
        .run(g.groupId, m, m, T0, T0);
      expect((await alice.client.delete(`/api/groupes/${g.groupId}/membres/${m}`)).statut).toBe(200);
      const compte = (table: string): unknown => d.sql.prepare(`SELECT count(*) FROM ${table} WHERE group_id = ?`).pluck().get(g.groupId);
      expect([compte('messages'), compte('expenses'), compte('threads')]).toEqual([1, 1, 1]);
      // Et la jointure d'affichage sans filtre de statut retrouve l'auteur.
      const auteur = d.sql
        .prepare('SELECT m.status AS statut FROM messages AS x JOIN memberships AS m ON m.id = x.author_membership_id AND m.group_id = x.group_id WHERE x.id = ?')
        .get('msg1') as { statut: string };
      expect(auteur.statut).toBe('removed');
    });

    it('rétrograder un administrateur révoque ses invitations de rôle admin, pas les autres', async () => {
      await alice.client.patch(`/api/groupes/${g.groupId}/membres/${membreDe(g, bob)}`, { role: 'admin' });
      await bob.client.post(`/api/groupes/${g.groupId}/invitations`, { email: 'complice@exemple.test', role: 'admin' });
      await bob.client.post(`/api/groupes/${g.groupId}/invitations`, { email: 'ami@exemple.test', role: 'member' });
      const statut = (email: string): unknown => d.sql.prepare('SELECT status FROM invitations WHERE email = ?').pluck().get(email);
      expect([statut('complice@exemple.test'), statut('ami@exemple.test')]).toEqual(['pending', 'pending']);
      expect((await alice.client.patch(`/api/groupes/${g.groupId}/membres/${membreDe(g, bob)}`, { role: 'member' })).statut).toBe(200);
      expect([statut('complice@exemple.test'), statut('ami@exemple.test')]).toEqual(['revoked', 'pending']);
    });

    it('un membre qui part ou qu’on retire laisse sans effet ses invitations en attente', async () => {
      await alice.client.patch(`/api/groupes/${g.groupId}/membres/${membreDe(g, bob)}`, { role: 'admin' });
      await bob.client.post(`/api/groupes/${g.groupId}/invitations`, { email: 'ami@exemple.test' });
      expect(d.sql.prepare("SELECT status FROM invitations WHERE email = 'ami@exemple.test'").pluck().get()).toBe('pending');
      await alice.client.delete(`/api/groupes/${g.groupId}/membres/${membreDe(g, bob)}`);
      expect(d.sql.prepare("SELECT status FROM invitations WHERE email = 'ami@exemple.test'").pluck().get()).toBe('revoked');
    });
  });
});
