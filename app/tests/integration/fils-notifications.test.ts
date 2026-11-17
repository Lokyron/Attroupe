import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Decor } from '../fixtures/comptes.js';
import { decor, groupe, personne, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';

describe('fils de discussion libres et notifications (intégration HTTP)', () => {
  let d: Decor;
  let alice: Personne;
  let bob: Personne;
  let carole: Personne;
  let gA: GroupeAmorce;
  let gB: GroupeAmorce;

  beforeEach(async () => {
    d = decor();
    alice = await personne(d, 'alice_fn');
    bob = await personne(d, 'bob_fn');
    carole = await personne(d, 'carole_fn');
    gA = await groupe(d, 'Groupe Alpha', [
      { personne: alice, role: 'admin' },
      { personne: carole, role: 'member' },
    ]);
    gB = await groupe(d, 'Groupe Beta', [{ personne: bob, role: 'admin' }]);
  });
  afterEach(() => d.nettoyer());

  it('cycle complet : fil libre, messages, droits 403, notifications et préférences', async () => {
    // 1. Création et liste de fils libres
    const creation = await alice.client.post(`/api/groupes/${gA.groupId}/fils`, { title: 'Idées de vacances' });
    expect(creation.statut).toBe(201);
    const filId = creation.corps['id'] as string;

    const listeFils = await carole.client.get(`/api/groupes/${gA.groupId}/fils`);
    expect(listeFils.statut).toBe(200);
    expect((listeFils.corps['fils'] as Array<{ id: string }>).some((f) => f.id === filId)).toBe(true);

    // 2. Préférences de notification : Carole passe en mode 'daily' pour Groupe Alpha, et 404 pour Groupe Beta
    const prefInterdite = await carole.client.put('/api/moi/preferences-notifications', {
      group_id: gB.groupId,
      email_mode: 'off',
    });
    expect(prefInterdite.statut).toBe(404);
    expect(prefInterdite.corps['error']).toBe('groupe.introuvable');

    const prefOk = await carole.client.put('/api/moi/preferences-notifications', {
      group_id: gA.groupId,
      email_mode: 'daily',
    });
    expect(prefOk.statut).toBe(200);

    const prefs = await carole.client.get('/api/moi/preferences-notifications');
    expect(prefs.statut).toBe(200);
    expect(prefs.corps['preferences']).toEqual([
      expect.objectContaining({ group_id: gA.groupId, group_name: 'Groupe Alpha', email_mode: 'daily' }),
    ]);

    // 3. Alice poste un message : Carole reçoit une notification, Alice non, Bob non
    const msgRes = await alice.client.post(`/api/groupes/${gA.groupId}/fils/${filId}/messages`, {
      body: 'On part à la montagne ?',
    });
    expect(msgRes.statut).toBe(201);
    const msgId = msgRes.corps['id'] as string;

    const notifsAlice = await alice.client.get('/api/moi/notifications');
    expect(notifsAlice.corps['non_lues']).toBe(0);
    const notifsBob = await bob.client.get('/api/moi/notifications');
    expect(notifsBob.corps['non_lues']).toBe(0);

    const notifsCarole = await carole.client.get('/api/moi/notifications');
    expect(notifsCarole.statut).toBe(200);
    expect(notifsCarole.corps['non_lues']).toBe(1);
    const notifId = (notifsCarole.corps['notifications'] as Array<{ id: string }>)[0]?.id;
    expect(notifId).toBeDefined();

    // Marquage lu par id
    const lecture = await carole.client.post('/api/moi/notifications/lecture', { ids: [notifId ?? ''] });
    expect(lecture.statut).toBe(200);
    expect(lecture.corps['lues']).toBe(1);
    expect((await carole.client.get('/api/moi/notifications')).corps['non_lues']).toBe(0);

    // 4. Droits sur les messages : Carole ne peut pas modifier/supprimer le message d'Alice (403)
    const editInterdite = await carole.client.patch(`/api/groupes/${gA.groupId}/fils/${filId}/messages/${msgId}`, {
      body: 'Piraté',
    });
    expect(editInterdite.statut).toBe(403);
    expect(editInterdite.corps['error']).toBe('droit.message_requis');

    const supprInterdite = await carole.client.delete(`/api/groupes/${gA.groupId}/fils/${filId}/messages/${msgId}`);
    expect(supprInterdite.statut).toBe(403);
    expect(supprInterdite.corps['error']).toBe('droit.message_requis');

    // Alice (auteure) modifie son message, puis le supprime
    const editOk = await alice.client.patch(`/api/groupes/${gA.groupId}/fils/${filId}/messages/${msgId}`, {
      body: 'Ou à la mer ?',
    });
    expect(editOk.statut).toBe(200);
    expect(editOk.corps['body']).toBe('Ou à la mer ?');
    expect(editOk.corps['edited_at']).not.toBeNull();

    const supprOk = await alice.client.delete(`/api/groupes/${gA.groupId}/fils/${filId}/messages/${msgId}`);
    expect(supprOk.statut).toBe(200);

    const msgsApres = await carole.client.get(`/api/groupes/${gA.groupId}/fils/${filId}/messages`);
    expect(msgsApres.statut).toBe(200);
    expect(msgsApres.corps['messages']).toEqual([]);
  });
});
