import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Decor } from '../fixtures/comptes.js';
import { decor, groupe, personne, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';

// Historique des notifications : filtre « non lues » / « toutes », page bornée, et état de l'invitation visée par une
// notification `invitation_received` (pour que la page puisse proposer Accepter / Refuser ou afficher l'issue).
describe('notifications : historique, filtre, pagination, état des invitations', () => {
  let d: Decor;
  let alice: Personne;
  let bob: Personne;
  let carole: Personne;
  let g: GroupeAmorce;

  beforeEach(async () => {
    d = decor();
    alice = await personne(d, 'alice_h');
    bob = await personne(d, 'bob_h');
    carole = await personne(d, 'carole_h');
    g = await groupe(d, 'Famille', [{ personne: alice, role: 'admin' }]);
  });
  afterEach(() => d.nettoyer());

  const poser = (
    id: string,
    userId: string,
    options: { lue?: boolean; kind?: string; sujet?: string; creeLe?: string } = {},
  ): void => {
    const invitation = options.kind === 'invitation_received';
    d.sql
      .prepare(
        'INSERT INTO notifications (id, user_id, group_id, kind, subject_type, subject_id, payload_json, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        userId,
        invitation ? null : g.groupId,
        options.kind ?? 'event_created',
        invitation ? 'invitation' : null,
        options.sujet ?? null,
        '{}',
        options.creeLe ?? '2026-11-15T12:00:00Z',
        options.lue === true ? '2026-11-16T08:00:00Z' : null,
      );
  };

  const ids = (corps: Record<string, unknown>): string[] => (corps['notifications'] as Array<{ id: string }>).map((n) => n.id);

  it('rend l’historique complet par défaut, puis filtre sur les non lues, et compte les non lues tous filtres confondus', async () => {
    poser('n1', alice.userId, { creeLe: '2026-11-15T10:00:00Z', lue: true });
    poser('n2', alice.userId, { creeLe: '2026-11-15T11:00:00Z' });
    poser('n3', alice.userId, { creeLe: '2026-11-15T12:00:00Z' });

    const toutes = await alice.client.get('/api/moi/notifications');
    expect(toutes.statut).toBe(200);
    expect(ids(toutes.corps)).toEqual(['n3', 'n2', 'n1']);
    expect(toutes.corps['non_lues']).toBe(2);
    expect(toutes.corps['a_suite']).toBe(false);

    const nonLues = await alice.client.get('/api/moi/notifications?filtre=non_lues');
    expect(ids(nonLues.corps)).toEqual(['n3', 'n2']);
    expect(nonLues.corps['non_lues']).toBe(2);
  });

  it('borne la page par `limite` et dit s’il y a une suite', async () => {
    for (let i = 1; i <= 5; i += 1) poser(`p${i}`, alice.userId, { creeLe: `2026-11-15T1${i}:00:00Z` });
    const page = await alice.client.get('/api/moi/notifications?limite=2');
    expect(ids(page.corps)).toEqual(['p5', 'p4']);
    expect(page.corps['a_suite']).toBe(true);
    const tout = await alice.client.get('/api/moi/notifications?limite=5');
    expect(ids(tout.corps)).toHaveLength(5);
    expect(tout.corps['a_suite']).toBe(false);
  });

  it('refuse un filtre ou une limite hors bornes (400 requete.invalide)', async () => {
    for (const requete of ['filtre=lues', 'limite=0', 'limite=201', 'limite=abc', 'autre=1']) {
      const r = await alice.client.get(`/api/moi/notifications?${requete}`);
      expect(r.statut, requete).toBe(400);
      expect(r.corps['error']).toBe('requete.invalide');
    }
  });

  it('ne montre jamais les notifications d’un autre compte', async () => {
    poser('a1', alice.userId);
    const r = await bob.client.get('/api/moi/notifications');
    expect(ids(r.corps)).toEqual([]);
    expect(r.corps['non_lues']).toBe(0);
  });

  describe('pagination par curseur', () => {
    const page = async (p: Personne, requete: string): Promise<Record<string, unknown>> => {
      const r = await p.client.get(`/api/moi/notifications?${requete}`);
      expect(r.statut, requete).toBe(200);
      return r.corps;
    };
    const suivant = (corps: Record<string, unknown>): string => `avant=${encodeURIComponent(String(corps['curseur_suivant']))}`;

    it('parcourt trois pages sans sauter ni répéter, même avec des dates identiques', async () => {
      // 7 notifications : trois à la même seconde, pour que seul l'identifiant les départage.
      poser('a1', alice.userId, { creeLe: '2026-11-15T10:00:00Z' });
      poser('a2', alice.userId, { creeLe: '2026-11-15T11:00:00Z' });
      poser('a3', alice.userId, { creeLe: '2026-11-15T11:00:00Z' });
      poser('a4', alice.userId, { creeLe: '2026-11-15T11:00:00Z' });
      poser('a5', alice.userId, { creeLe: '2026-11-15T12:00:00Z' });
      poser('a6', alice.userId, { creeLe: '2026-11-15T13:00:00Z' });
      poser('a7', alice.userId, { creeLe: '2026-11-15T13:00:00Z' });
      const p1 = await page(alice, 'limite=3');
      expect(ids(p1)).toEqual(['a7', 'a6', 'a5']);
      expect(p1['a_suite']).toBe(true);
      const p2 = await page(alice, `limite=3&${suivant(p1)}`);
      expect(ids(p2)).toEqual(['a4', 'a3', 'a2']);
      expect(p2['a_suite']).toBe(true);
      const p3 = await page(alice, `limite=3&${suivant(p2)}`);
      expect(ids(p3)).toEqual(['a1']);
      expect(p3['a_suite']).toBe(false);
      expect(p3['curseur_suivant']).toBeNull();
    });

    it('coupe la page au milieu d’un lot de dates identiques sans perdre de ligne', async () => {
      for (const id of ['b1', 'b2', 'b3', 'b4']) poser(id, alice.userId, { creeLe: '2026-11-15T10:00:00Z' });
      const p1 = await page(alice, 'limite=2');
      const p2 = await page(alice, `limite=2&${suivant(p1)}`);
      expect([...ids(p1), ...ids(p2)]).toEqual(['b4', 'b3', 'b2', 'b1']);
      expect(p2['a_suite']).toBe(false);
    });

    it('rend l’historique complet au-delà de 200 notifications, page de 20 après page de 20', async () => {
      d.sql.exec('BEGIN');
      for (let i = 0; i < 230; i += 1) {
        poser(`m${String(i).padStart(3, '0')}`, alice.userId, { creeLe: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00Z` });
      }
      d.sql.exec('COMMIT');
      const vus: string[] = [];
      let requete = 'limite=20';
      for (let tour = 0; tour < 20; tour += 1) {
        const corps = await page(alice, requete);
        vus.push(...ids(corps));
        if (corps['a_suite'] !== true) break;
        requete = `limite=20&${suivant(corps)}`;
      }
      expect(vus).toHaveLength(230);
      expect(new Set(vus).size).toBe(230);
    });

    it('applique le curseur au filtre « non lues »', async () => {
      poser('c1', alice.userId, { creeLe: '2026-11-15T10:00:00Z' });
      poser('c2', alice.userId, { creeLe: '2026-11-15T11:00:00Z', lue: true });
      poser('c3', alice.userId, { creeLe: '2026-11-15T12:00:00Z' });
      const p1 = await page(alice, 'filtre=non_lues&limite=1');
      expect(ids(p1)).toEqual(['c3']);
      expect(ids(await page(alice, `filtre=non_lues&limite=1&${suivant(p1)}`))).toEqual(['c1']);
    });

    it('refuse un curseur malformé (400 requete.invalide)', async () => {
      for (const brut of ['abc', '2026-11-15T10:00:00Z', '2026-11-15T10:00:00Z|', '|x', 'hier|x', "2026-11-15T10:00:00Z|x' OR 1=1", '2026-11-15T10:00:00Z|a|b']) {
        const r = await alice.client.get(`/api/moi/notifications?avant=${encodeURIComponent(brut)}`);
        expect(r.statut, brut).toBe(400);
        expect(r.corps['error']).toBe('requete.invalide');
      }
    });

    it('un curseur forgé avec l’identifiant d’un autre compte ne révèle rien', async () => {
      poser('d1', alice.userId, { creeLe: '2026-11-15T10:00:00Z' });
      poser('d2', bob.userId, { creeLe: '2026-11-15T11:00:00Z' });
      const r = await page(bob, 'avant=' + encodeURIComponent('2026-11-16T00:00:00Z|d1'));
      expect(ids(r)).toEqual(['d2']);
    });
  });

  describe('notification d’invitation', () => {
    let invitationId: string;
    beforeEach(async () => {
      const envoi = await alice.client.post(`/api/groupes/${g.groupId}/invitations`, { username: 'bob_h', role: 'member' });
      expect(envoi.statut).toBeLessThan(300);
      invitationId = (d.sql.prepare("SELECT id FROM invitations WHERE group_id = ? AND target_user_id = ?").get(g.groupId, bob.userId) as { id: string }).id;
      // L'invitation a écrit elle-même la notification du destinataire (rien à amorcer).
    });

    const statut = async (p: Personne): Promise<unknown> =>
      ((await p.client.get('/api/moi/notifications')).corps['notifications'] as Array<{ invitation_statut: unknown }>)[0]?.invitation_statut;

    it('porte l’identifiant de l’invitation et son état : en attente, puis l’issue', async () => {
      const lue = (await bob.client.get('/api/moi/notifications')).corps['notifications'] as Array<Record<string, unknown>>;
      expect(lue[0]).toMatchObject({ kind: 'invitation_received', subject_type: 'invitation', subject_id: invitationId, invitation_statut: 'pending' });

      const refus = await bob.client.post(`/api/moi/invitations/${invitationId}/refus`, {});
      expect(refus.statut).toBeLessThan(300);
      expect(await statut(bob)).toBe('declined');
    });

    it('voit une invitation en attente dont l’échéance est passée comme expirée', async () => {
      d.sql.prepare("UPDATE invitations SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(invitationId);
      expect(await statut(bob)).toBe('expired');
    });

    it('ne révèle pas l’état d’une invitation adressée à un autre compte (identifiant forgé)', async () => {
      poser('i2', carole.userId, { kind: 'invitation_received', sujet: invitationId });
      expect(await statut(carole)).toBeNull();
    });
  });
});
