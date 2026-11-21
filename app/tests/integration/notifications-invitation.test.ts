import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Decor } from '../fixtures/comptes.js';
import { decor, groupe, personne, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';

// Le serveur écrit la notification `invitation_received` quand une invitation est envoyée à un compte existant, et la
// pastille de « Notifs » (`GET /api/moi` → `notifications_a_voir`) ne compte jamais deux fois la même invitation.
describe('notifications : invitation reçue et pastille', () => {
  let d: Decor;
  let alice: Personne;
  let bob: Personne;
  let carole: Personne;
  let g: GroupeAmorce;

  beforeEach(async () => {
    d = decor();
    alice = await personne(d, 'alice_i');
    bob = await personne(d, 'bob_i');
    carole = await personne(d, 'carole_i');
    g = await groupe(d, 'Famille', [{ personne: alice, role: 'admin' }]);
  });
  afterEach(() => d.nettoyer());

  interface LigneNotif {
    id: string;
    group_id: string | null;
    kind: string;
    subject_type: string | null;
    subject_id: string | null;
    read_at: string | null;
    email_queued_at: string | null;
    payload_json: string;
  }

  const notifsDe = (userId: string): LigneNotif[] =>
    d.sql
      .prepare('SELECT id, group_id, kind, subject_type, subject_id, read_at, email_queued_at, payload_json FROM notifications WHERE user_id = ? ORDER BY created_at, id')
      .all(userId) as unknown as LigneNotif[];

  const inviter = async (corps: Record<string, unknown>): Promise<void> => {
    const r = await alice.client.post(`/api/groupes/${g.groupId}/invitations`, corps);
    expect(r.statut).toBe(202);
  };

  const invitationsDe = (userId: string): Array<{ id: string; status: string }> =>
    d.sql.prepare('SELECT id, status FROM invitations WHERE group_id = ? AND target_user_id = ? ORDER BY created_at, id').all(g.groupId, userId) as unknown as Array<{
      id: string;
      status: string;
    }>;

  const pastille = async (p: Personne): Promise<unknown> => (await p.client.get('/api/moi')).corps['notifications_a_voir'];

  it('écrit une notification au destinataire, avec l’identifiant de l’invitation, et à lui seul', async () => {
    await inviter({ username: 'bob_i', role: 'member' });
    const [invitation] = invitationsDe(bob.userId);
    const notifs = notifsDe(bob.userId);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]).toMatchObject({
      group_id: null,
      kind: 'invitation_received',
      subject_type: 'invitation',
      subject_id: invitation?.id,
      read_at: null,
      // Aucun e-mail n'est mis en route par ce genre.
      email_queued_at: null,
    });
    expect(JSON.parse(notifs[0]?.payload_json ?? '{}')).toMatchObject({ group_name: 'Famille', role: 'member' });
    expect(notifsDe(carole.userId)).toEqual([]);
    expect(notifsDe(alice.userId)).toEqual([]);
    const api = await bob.client.get('/api/moi/notifications');
    expect(api.corps['notifications']).toMatchObject([{ kind: 'invitation_received', subject_id: invitation?.id, invitation_statut: 'pending' }]);
    expect((await carole.client.get('/api/moi/notifications')).corps['notifications']).toEqual([]);
  });

  it('garde la notification, avec l’issue, après le refus', async () => {
    await inviter({ username: 'bob_i' });
    const [invitation] = invitationsDe(bob.userId);
    expect((await bob.client.post(`/api/moi/invitations/${invitation?.id}/refus`, {})).statut).toBeLessThan(300);
    const liste = (await bob.client.get('/api/moi/notifications?filtre=toutes')).corps['notifications'];
    expect(liste).toMatchObject([{ kind: 'invitation_received', invitation_statut: 'declined' }]);
  });

  it('lit la notification quand l’invitation est acceptée', async () => {
    await inviter({ username: 'bob_i' });
    const [invitation] = invitationsDe(bob.userId);
    expect((await bob.client.post(`/api/moi/invitations/${invitation?.id}/acceptation`, {})).statut).toBeLessThan(300);
    expect(notifsDe(bob.userId)[0]?.read_at).not.toBeNull();
    expect(await pastille(bob)).toBe(0);
  });

  it('une invitation devenue sans objet (déjà membre par un autre chemin) est close : 409 une fois, puis plus rien en attente', async () => {
    await inviter({ username: 'bob_i' });
    const [invitation] = invitationsDe(bob.userId);
    d.sql
      .prepare("INSERT INTO memberships (id, group_id, user_id, role, status, joined_at, created_at, updated_at) VALUES ('m-bob', ?, ?, 'member', 'active', '2026-11-15T12:00:00Z', '2026-11-15T12:00:00Z', '2026-11-15T12:00:00Z')")
      .run(g.groupId, bob.userId);
    const r = await bob.client.post(`/api/moi/invitations/${invitation?.id}/acceptation`, {});
    expect(r.statut).toBe(409);
    expect(invitationsDe(bob.userId)[0]?.status).toBe('accepted');
    expect(notifsDe(bob.userId)[0]?.read_at).not.toBeNull();
    expect(await pastille(bob)).toBe(0);
  });

  it('une réinvitation après un refus crée une seconde invitation et une seconde notification', async () => {
    await inviter({ username: 'bob_i' });
    const [premiere] = invitationsDe(bob.userId);
    await bob.client.post(`/api/moi/invitations/${premiere?.id}/refus`, {});
    await inviter({ username: 'bob_i' });
    const toutes = invitationsDe(bob.userId);
    expect(toutes.map((i) => i.status)).toEqual(['declined', 'pending']);
    const notifs = notifsDe(bob.userId);
    expect(notifs.map((n) => n.subject_id)).toEqual(toutes.map((i) => i.id));
    const statuts = ((await bob.client.get('/api/moi/notifications')).corps['notifications'] as Array<{ invitation_statut: string }>).map((n) => n.invitation_statut);
    expect(statuts.sort()).toEqual(['declined', 'pending']);
  });

  it('n’écrit rien pour une invitation par e-mail (pas de compte à notifier) ni pour un nom inconnu', async () => {
    await inviter({ email: 'inconnu@exemple.test' });
    await inviter({ username: 'personne_ici' });
    const total = (d.sql.prepare('SELECT count(*) AS n FROM notifications').get() as { n: number }).n;
    expect(total).toBe(0);
  });

  it('respecte un genre coupé globalement : aucune notification, mais l’invitation reste comptée par la pastille', async () => {
    const coupe = await bob.client.put('/api/moi/preferences-notifications', { group_id: '*', muted_kinds: ['invitation_received'] });
    expect(coupe.statut).toBe(200);
    await inviter({ username: 'bob_i' });
    expect(notifsDe(bob.userId)).toEqual([]);
    expect(await pastille(bob)).toBe(1);
  });

  describe('pastille de « Notifs »', () => {
    it('une invitation en attente ET sa notification non lue donnent 1, pas 2', async () => {
      await inviter({ username: 'bob_i' });
      const moi = (await bob.client.get('/api/moi')).corps;
      expect(moi['invitations_en_attente']).toBe(1);
      expect((await bob.client.get('/api/moi/notifications')).corps['non_lues']).toBe(1);
      expect(moi['notifications_a_voir']).toBe(1);
    });

    it('s’éteint une fois l’invitation répondue et le reste lu, et ajoute les autres notifications', async () => {
      await inviter({ username: 'bob_i' });
      d.sql
        .prepare("INSERT INTO notifications (id, user_id, group_id, kind, payload_json, created_at) VALUES ('autre', ?, ?, 'event_created', '{}', '2026-11-15T12:00:00Z')")
        .run(bob.userId, g.groupId);
      expect(await pastille(bob)).toBe(2);
      const [invitation] = invitationsDe(bob.userId);
      // Répondre lit la notification de l'invitation : il ne reste que l'autre.
      await bob.client.post(`/api/moi/invitations/${invitation?.id}/refus`, {});
      expect(notifsDe(bob.userId).find((n) => n.kind === 'invitation_received')?.read_at).not.toBeNull();
      expect(await pastille(bob)).toBe(1);
      await bob.client.post('/api/moi/notifications/lecture', { tout: true });
      expect(await pastille(bob)).toBe(0);
    });

    it('une invitation en attente compte 1 même quand sa notification est lue (« tout marquer lu » ne la fait pas disparaître)', async () => {
      await inviter({ username: 'bob_i' });
      await bob.client.post('/api/moi/notifications/lecture', { tout: true });
      expect(notifsDe(bob.userId)[0]?.read_at).not.toBeNull();
      expect(await pastille(bob)).toBe(1);
    });

    it('compte une invitation en attente qu’aucune notification ne porte (notification absente)', async () => {
      await inviter({ username: 'bob_i' });
      d.sql.prepare('DELETE FROM notifications WHERE user_id = ?').run(bob.userId);
      expect(await pastille(bob)).toBe(1);
    });

    it('ne compte jamais l’invitation ni la notification d’un autre compte', async () => {
      await inviter({ username: 'bob_i' });
      expect(await pastille(carole)).toBe(0);
      expect(await pastille(alice)).toBe(0);
    });
  });
});
