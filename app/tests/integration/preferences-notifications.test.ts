import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Decor } from '../fixtures/comptes.js';
import { decor, groupe, personne, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';

// Préférences de notification : /api/moi/preferences-notifications. `muted_kinds` se lit et s'écrit. La ligne d'un groupe est une
// SURCHARGE PARTIELLE : un champ non posé vaut NULL (`null` dans l'API) et hérite de la ligne globale `'*'` à chaque lecture, champ par
// champ. Il n'y a pas de copie : sinon couper un genre globalement après avoir réglé l'e-mail d'un groupe ne l'atteindrait plus.
describe('préférences de notification : genres coupés (intégration HTTP)', () => {
  let d: Decor;
  let alice: Personne;
  let carole: Personne;
  let bob: Personne;
  let gA: GroupeAmorce;
  let gB: GroupeAmorce;

  const PREFS = '/api/moi/preferences-notifications';
  type Pref = { group_id: string; email_mode: string | null; muted_kinds: string[] | null };
  const prefs = async (p: Personne): Promise<Pref[]> => (await p.client.get(PREFS)).corps['preferences'] as Pref[];
  const prefDe = async (p: Personne, groupId: string): Promise<Pref | undefined> => (await prefs(p)).find((x) => x.group_id === groupId);
  const genresRecus = async (p: Personne): Promise<string[]> =>
    ((await p.client.get('/api/moi/notifications')).corps['notifications'] as Array<{ kind: string }>).map((n) => n.kind);

  const creerFilEtPoster = async (): Promise<void> => {
    const fil = await alice.client.post(`/api/groupes/${gA.groupId}/fils`, { title: 'Idées' });
    expect(fil.statut).toBe(201);
    const msg = await alice.client.post(`/api/groupes/${gA.groupId}/fils/${fil.corps['id'] as string}/messages`, { body: 'Salut' });
    expect(msg.statut).toBe(201);
  };
  const creerEvenement = async (): Promise<void> => {
    const r = await alice.client.post(`/api/groupes/${gA.groupId}/evenements`, { title: 'Soirée', starts_at: '2027-05-01T18:00:00Z', time_zone: 'Europe/Paris' });
    expect(r.statut, JSON.stringify(r.corps)).toBe(201);
  };

  beforeEach(async () => {
    d = decor();
    alice = await personne(d, 'alice_pn');
    carole = await personne(d, 'carole_pn');
    bob = await personne(d, 'bob_pn');
    gA = await groupe(d, 'Groupe A', [
      { personne: alice, role: 'admin' },
      { personne: carole, role: 'member' },
    ]);
    gB = await groupe(d, 'Groupe B', [{ personne: bob, role: 'admin' }]);
  });
  afterEach(() => d.nettoyer());

  it('écrit et relit les genres coupés ; dédoublonne ; un tableau vide les rétablit', async () => {
    const r = await carole.client.put(PREFS, { group_id: '*', muted_kinds: ['message_posted', 'event_created'] });
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    expect(await prefDe(carole, '*')).toMatchObject({ email_mode: 'immediate', muted_kinds: ['message_posted', 'event_created'] });
    expect((await carole.client.put(PREFS, { group_id: '*', muted_kinds: [] })).statut).toBe(200);
    expect((await prefDe(carole, '*'))?.muted_kinds).toEqual([]);
  });

  it('validation stricte : genre inconnu, chaîne libre, doublon, corps vide ou champ en trop sont refusés (400)', async () => {
    for (const corps of [
      { group_id: '*', muted_kinds: ['inconnu'] },
      { group_id: '*', muted_kinds: 'message_posted' },
      { group_id: '*', muted_kinds: ['message_posted', 'message_posted'] },
      { group_id: '*', muted_kinds: [42] },
      { group_id: '*', muted_kinds: null },
      { group_id: '*' },
      { group_id: '*', email_mode: 'off', autre: 1 },
    ]) {
      expect((await carole.client.put(PREFS, corps)).statut, JSON.stringify(corps)).toBe(400);
    }
    expect(await prefs(carole)).toEqual([]);
  });

  it('un champ absent n’est pas modifié : couper un genre garde le mode e-mail, et inversement', async () => {
    await carole.client.put(PREFS, { group_id: gA.groupId, email_mode: 'daily' });
    await carole.client.put(PREFS, { group_id: gA.groupId, muted_kinds: ['message_posted'] });
    expect(await prefDe(carole, gA.groupId)).toMatchObject({ email_mode: 'daily', muted_kinds: ['message_posted'] });
    await carole.client.put(PREFS, { group_id: gA.groupId, email_mode: 'off' });
    expect(await prefDe(carole, gA.groupId)).toMatchObject({ email_mode: 'off', muted_kinds: ['message_posted'] });
  });

  it('la ligne d’un groupe ne pose que les champs fournis : les autres restent `null` (hérités), jamais copiés de « * »', async () => {
    await carole.client.put(PREFS, { group_id: '*', email_mode: 'daily', muted_kinds: ['message_posted'] });
    await carole.client.put(PREFS, { group_id: gA.groupId, email_mode: 'immediate' });
    expect(await prefDe(carole, gA.groupId)).toMatchObject({ email_mode: 'immediate', muted_kinds: null });

    // Et dans l'autre sens : couper un genre seul, dans un nouveau groupe, ne pose pas le mode e-mail.
    const autre = await groupe(d, 'Groupe C', [{ personne: carole, role: 'admin' }]);
    await carole.client.put(PREFS, { group_id: autre.groupId, muted_kinds: ['event_created'] });
    expect(await prefDe(carole, autre.groupId)).toMatchObject({ email_mode: null, muted_kinds: ['event_created'] });
    // La ligne globale, elle, n'est jamais nulle.
    expect(await prefDe(carole, '*')).toMatchObject({ email_mode: 'daily', muted_kinds: ['message_posted'] });
  });

  it('la ligne globale n’hérite de rien : créée par un seul champ, elle prend le défaut pour l’autre', async () => {
    await carole.client.put(PREFS, { group_id: '*', muted_kinds: ['message_posted'] });
    expect(await prefDe(carole, '*')).toMatchObject({ email_mode: 'immediate', muted_kinds: ['message_posted'] });
  });

  it('un choix explicite pour le groupe prime sur la ligne globale (il peut rétablir un genre coupé globalement)', async () => {
    await carole.client.put(PREFS, { group_id: '*', muted_kinds: ['message_posted'] });
    await carole.client.put(PREFS, { group_id: gA.groupId, muted_kinds: [] });
    expect((await prefDe(carole, gA.groupId))?.muted_kinds).toEqual([]);
    await creerFilEtPoster();
    expect(await genresRecus(carole)).toContain('message_posted');
  });

  it('un genre coupé n’est pas notifié, les autres le sont ; couper globalement puis régler un groupe ne le réactive pas', async () => {
    await carole.client.put(PREFS, { group_id: '*', muted_kinds: ['message_posted'] });
    await carole.client.put(PREFS, { group_id: gA.groupId, email_mode: 'off' }); // le réglage qui réactivait en silence
    await creerFilEtPoster();
    await creerEvenement();
    const recus = await genresRecus(carole);
    expect(recus).not.toContain('message_posted');
    expect(recus).toContain('event_created');
  });

  it('couper un genre globalement APRÈS avoir réglé l’e-mail d’un groupe l’atteint quand même (ordre inverse du défaut corrigé)', async () => {
    await carole.client.put(PREFS, { group_id: gA.groupId, email_mode: 'off' }); // la ligne de A existe, sans genres propres
    await carole.client.put(PREFS, { group_id: '*', muted_kinds: ['message_posted'] });
    await creerFilEtPoster();
    await creerEvenement();
    const recus = await genresRecus(carole);
    expect(recus).not.toContain('message_posted');
    expect(recus).toContain('event_created');
  });

  it('le mode e-mail se résout aussi champ par champ : le groupe qui ne coupe que des genres suit le mode global, et l’inverse', async () => {
    d.sql.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run('2026-11-01T00:00:00Z', carole.userId);
    const miseEnFile = (): number =>
      d.sql.prepare('SELECT count(*) FROM notifications WHERE user_id = ? AND email_queued_at IS NOT NULL').pluck().get(carole.userId) as number;

    await carole.client.put(PREFS, { group_id: '*', email_mode: 'off' });
    await carole.client.put(PREFS, { group_id: gA.groupId, muted_kinds: ['event_cancelled'] }); // ne pose pas le mode e-mail
    await creerEvenement();
    expect(await genresRecus(carole)).toContain('event_created');
    expect(miseEnFile(), 'le mode global « désactivé » s’applique au groupe').toBe(0);

    await carole.client.put(PREFS, { group_id: gA.groupId, email_mode: 'immediate' });
    await creerEvenement();
    expect(miseEnFile(), 'le mode posé par le groupe prime sur le global').toBe(1);
  });

  it('« reprendre le réglage global » supprime la ligne du groupe : il suit de nouveau le global (DELETE), sans toucher aux autres', async () => {
    const autre = await groupe(d, 'Groupe C', [{ personne: carole, role: 'admin' }]);
    await carole.client.put(PREFS, { group_id: '*', muted_kinds: ['message_posted'] });
    await carole.client.put(PREFS, { group_id: gA.groupId, email_mode: 'off', muted_kinds: [] });
    await carole.client.put(PREFS, { group_id: autre.groupId, email_mode: 'daily' });

    const r = await carole.client.delete(`${PREFS}/${gA.groupId}`);
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    expect(await prefDe(carole, gA.groupId)).toBeUndefined();
    expect(await prefDe(carole, autre.groupId)).toMatchObject({ email_mode: 'daily' });
    expect(await prefDe(carole, '*')).toMatchObject({ muted_kinds: ['message_posted'] });

    await creerFilEtPoster();
    expect(await genresRecus(carole), 'le genre coupé globalement ne revient plus par la ligne du groupe').not.toContain('message_posted');
    // Idempotent : sans ligne propre, la suppression réussit sans effet.
    expect((await carole.client.delete(`${PREFS}/${gA.groupId}`)).statut).toBe(200);
  });

  it('DELETE : un groupe dont on n’est pas membre ou la ligne globale ne se « reprennent » pas (404) et rien ne bouge', async () => {
    await bob.client.put(PREFS, { group_id: gB.groupId, email_mode: 'off' });
    await carole.client.put(PREFS, { group_id: '*', email_mode: 'daily' });
    for (const cible of [gB.groupId, '*', 'inconnu']) {
      const r = await carole.client.delete(`${PREFS}/${encodeURIComponent(cible)}`);
      expect(r.statut, cible).toBe(404);
      expect(r.corps['error']).toBe('groupe.introuvable');
    }
    expect(await prefDe(bob, gB.groupId)).toMatchObject({ email_mode: 'off' });
    expect(await prefDe(carole, '*')).toMatchObject({ email_mode: 'daily' });
  });

  it('cloisonnement : on ne règle pas les genres d’un groupe dont on n’est pas membre (404), ni en forgeant son identifiant', async () => {
    const r = await carole.client.put(PREFS, { group_id: gB.groupId, muted_kinds: ['message_posted'] });
    expect(r.statut).toBe(404);
    expect(r.corps['error']).toBe('groupe.introuvable');
    expect(await prefs(carole)).toEqual([]);
    expect(await prefs(bob)).toEqual([]);
  });

  it('chacun ne lit et n’écrit que ses propres préférences', async () => {
    await carole.client.put(PREFS, { group_id: '*', muted_kinds: ['message_posted'] });
    expect(await prefs(alice)).toEqual([]);
  });
});
