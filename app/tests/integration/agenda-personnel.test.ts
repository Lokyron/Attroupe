import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Decor } from '../fixtures/comptes.js';
import { decor, groupe, membreDe, personne, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';

// Agenda personnel et disponibilités de groupe (lot 8) : les 7 routes HTTP, le cloisonnement (404 agenda.introuvable
// et 404 groupe.introuvable) et la confidentialité 'busy' vs 'details'.
describe('agenda personnel et disponibilités (API)', () => {
  let d: Decor;
  let alice: Personne;
  let bob: Personne;
  let erik: Personne; // hors du groupe principal
  let g: GroupeAmorce;
  let autre: GroupeAmorce; // groupe étranger à Alice

  beforeEach(async () => {
    d = decor();
    alice = await personne(d, 'alice_ap');
    bob = await personne(d, 'bob_ap');
    erik = await personne(d, 'erik_ap');
    g = await groupe(d, 'Famille', [
      { personne: alice, role: 'admin' },
      { personne: bob, role: 'member' },
    ]);
    autre = await groupe(d, 'Voisins', [{ personne: erik, role: 'admin' }]);
  });

  afterEach(() => d.nettoyer());

  const NOUVEAU = {
    title: 'Kiné',
    description: 'Séance dos',
    location_name: 'Cabinet Pasteur',
    starts_at: '2027-04-10T10:00:00Z',
    ends_at: '2027-04-10T11:00:00Z',
    time_zone: 'Europe/Paris',
  } as const;

  it('POST et GET /api/moi/agenda créent, listent et filtrent par fenêtre', async () => {
    const cree1 = await alice.client.post('/api/moi/agenda', NOUVEAU);
    expect(cree1.statut).toBe(201);
    expect(cree1.corps).toMatchObject({
      title: 'Kiné',
      description: 'Séance dos',
      location_name: 'Cabinet Pasteur',
      all_day: false,
      starts_at: '2027-04-10T10:00:00Z',
      ends_at: '2027-04-10T11:00:00Z',
      time_zone: 'Europe/Paris',
      partages: [{ group_id: g.groupId, group_name: 'Famille', visibility: 'busy' }],
    });

    const cree2 = await alice.client.post('/api/moi/agenda', {
      title: 'Vacances',
      all_day: true,
      starts_at: '2027-05-01',
      ends_at: '2027-05-03',
      time_zone: 'Europe/Paris',
    });
    expect(cree2.statut).toBe(201);

    const tout = await alice.client.get('/api/moi/agenda');
    expect(tout.statut).toBe(200);
    expect((tout.corps['creneaux'] as unknown[]).length).toBe(2);

    const fenetre = await alice.client.get('/api/moi/agenda?du=2027-04-01&au=2027-04-30');
    expect(fenetre.statut).toBe(200);
    expect((fenetre.corps['creneaux'] as Array<{ title: string }>).map((c) => c.title)).toEqual(['Kiné']);

    // Bob ne voit pas les créneaux d'Alice dans son propre agenda personnel.
    const agendaBob = await bob.client.get('/api/moi/agenda');
    expect(agendaBob.statut).toBe(200);
    expect(agendaBob.corps['creneaux']).toEqual([]);
  });

  it('POST /api/moi/agenda refuse les entrées invalides en 400', async () => {
    const finAvantDebut = await alice.client.post('/api/moi/agenda', {
      ...NOUVEAU,
      ends_at: '2027-04-10T09:00:00Z',
    });
    expect(finAvantDebut.statut).toBe(400);
    expect(finAvantDebut.corps['error']).toBe('requete.invalide');

    const champInconnu = await alice.client.post('/api/moi/agenda', {
      ...NOUVEAU,
      recurrence_rule: 'FREQ=WEEKLY',
    });
    expect(champInconnu.statut).toBe(400);
    expect(champInconnu.corps['error']).toBe('requete.invalide');
  });

  it('PATCH et DELETE /api/moi/agenda/:id modifient et suppriment, et renvoient 404 agenda.introuvable pour un autre compte', async () => {
    const cree = await alice.client.post('/api/moi/agenda', NOUVEAU);
    const id = cree.corps['id'] as string;

    const maj = await alice.client.patch(`/api/moi/agenda/${id}`, {
      title: 'Ostéopathe',
      location_name: 'Clinique Sud',
    });
    expect(maj.statut).toBe(200);
    expect(maj.corps).toMatchObject({ id, title: 'Ostéopathe', location_name: 'Clinique Sud' });

    // Refus 400 si la nouvelle fin est antérieure au début existant.
    const majInvalide = await alice.client.patch(`/api/moi/agenda/${id}`, {
      ends_at: '2027-04-10T08:00:00Z',
    });
    expect(majInvalide.statut).toBe(400);

    // Bob (pourtant dans le même groupe) reçoit 404 agenda.introuvable sur PATCH et DELETE.
    const patchBob = await bob.client.patch(`/api/moi/agenda/${id}`, { title: 'Piraté' });
    expect(patchBob.statut).toBe(404);
    expect(patchBob.corps['error']).toBe('agenda.introuvable');

    const delBob = await bob.client.delete(`/api/moi/agenda/${id}`);
    expect(delBob.statut).toBe(404);
    expect(delBob.corps['error']).toBe('agenda.introuvable');

    // Alice peut supprimer son créneau, puis il devient introuvable.
    const delAlice = await alice.client.delete(`/api/moi/agenda/${id}`);
    expect(delAlice.statut).toBe(200);
    expect(delAlice.corps).toEqual({ ok: true });

    const listeApres = await alice.client.get('/api/moi/agenda');
    expect(listeApres.corps['creneaux']).toEqual([]);

    const patchApres = await alice.client.patch(`/api/moi/agenda/${id}`, { title: 'Trop tard' });
    expect(patchApres.statut).toBe(404);
    expect(patchApres.corps['error']).toBe('agenda.introuvable');
  });

  it('PUT /api/moi/agenda/:id/partages met à jour les partages et renvoie 404 sur créneau ou groupe étranger', async () => {
    const cree = await alice.client.post('/api/moi/agenda', NOUVEAU);
    const id = cree.corps['id'] as string;

    // Mise à jour en 'details' sur le groupe d'Alice.
    const majDetails = await alice.client.put(`/api/moi/agenda/${id}/partages`, {
      group_id: g.groupId,
      visibility: 'details',
    });
    expect(majDetails.statut).toBe(200);
    expect(majDetails.corps['partages']).toEqual([
      { group_id: g.groupId, group_name: 'Famille', visibility: 'details' },
    ]);

    // 404 agenda.introuvable sur un créneau d'un autre compte (Bob tente de partager le créneau d'Alice).
    const partageBob = await bob.client.put(`/api/moi/agenda/${id}/partages`, {
      group_id: g.groupId,
      visibility: 'none',
    });
    expect(partageBob.statut).toBe(404);
    expect(partageBob.corps['error']).toBe('agenda.introuvable');

    // 404 groupe.introuvable sur un partage vers un groupe étranger, sans modifier les partages existants.
    const partageEtranger = await alice.client.put(`/api/moi/agenda/${id}/partages`, {
      partages: [
        { group_id: g.groupId, visibility: 'none' },
        { group_id: autre.groupId, visibility: 'busy' },
      ],
    });
    expect(partageEtranger.statut).toBe(404);
    expect(partageEtranger.corps['error']).toBe('groupe.introuvable');

    // Le partage existant sur Famille est resté intact ('details').
    const verif = await alice.client.get('/api/moi/agenda');
    expect((verif.corps['creneaux'] as Array<{ partages: unknown[] }>)[0]?.partages).toEqual([
      { group_id: g.groupId, group_name: 'Famille', visibility: 'details' },
    ]);
  });

  it('PUT /api/groupes/:groupId/ma-visibilite et GET /api/groupes/:groupId/disponibilites appliquent la visibilité', async () => {
    // Alice passe sa visibilité par défaut à 'none', crée un créneau caché, puis passe à 'details' et crée un créneau visible.
    const visNone = await alice.client.put(`/api/groupes/${g.groupId}/ma-visibilite`, { visibility: 'none' });
    expect(visNone.statut).toBe(200);
    expect(visNone.corps).toEqual({ default_personal_visibility: 'none' });

    await alice.client.post('/api/moi/agenda', {
      ...NOUVEAU,
      title: 'Secret total',
      starts_at: '2027-04-12T08:00:00Z',
      ends_at: '2027-04-12T09:00:00Z',
    });

    // Créneau en 'busy' explicite.
    const creeBusy = await alice.client.post('/api/moi/agenda', {
      title: 'Consultation médicale secrète',
      description: 'Détail confidentiel',
      location_name: 'Cabinet',
      starts_at: '2027-04-12T10:00:00Z',
      ends_at: '2027-04-12T11:00:00Z',
      time_zone: 'Europe/Paris',
    });
    await alice.client.put(`/api/moi/agenda/${creeBusy.corps['id'] as string}/partages`, {
      group_id: g.groupId,
      visibility: 'busy',
    });

    const visDetails = await alice.client.put(`/api/groupes/${g.groupId}/ma-visibilite`, { visibility: 'details' });
    expect(visDetails.statut).toBe(200);
    expect(visDetails.corps).toEqual({ default_personal_visibility: 'details' });

    const creeDetails = await alice.client.post('/api/moi/agenda', {
      title: 'Café au soleil',
      description: 'Terrasse ouverte',
      location_name: 'Place Bellecour',
      starts_at: '2027-04-12T15:00:00Z',
      ends_at: '2027-04-12T16:00:00Z',
      time_zone: 'Europe/Paris',
    });
    expect(creeDetails.statut).toBe(201);

    // Bob consulte les disponibilités du groupe.
    const dispos = await bob.client.get(`/api/groupes/${g.groupId}/disponibilites?du=2027-04-12&au=2027-04-13`);
    expect(dispos.statut).toBe(200);
    const liste = dispos.corps['disponibilites'] as Array<Record<string, unknown>>;
    expect(liste).toHaveLength(2);
    expect(liste[0]).toMatchObject({
      id: creeBusy.corps['id'],
      membership_id: membreDe(g, alice),
      visibility: 'busy',
      title: null,
      description: null,
      location_name: null,
    });
    expect(liste[1]).toMatchObject({
      id: creeDetails.corps['id'],
      membership_id: membreDe(g, alice),
      visibility: 'details',
      title: 'Café au soleil',
      description: 'Terrasse ouverte',
      location_name: 'Place Bellecour',
    });

    const serialise = JSON.stringify(dispos.corps);
    expect(serialise).not.toContain('Secret total');
    expect(serialise).not.toContain('Consultation médicale secrète');
    expect(serialise).not.toContain('Détail confidentiel');
    expect(serialise).not.toContain('Cabinet');
  });
});
