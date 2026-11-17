import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Decor } from '../fixtures/comptes.js';
import { decor, groupe, membreDe, personne, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';

// Sondages de dates (lot 7) : création, ajout/retrait d'options, votes de plusieurs membres, dépouillement pondéré,
// clôture automatique (`closes_at`) ou manuelle (`status = 'closed'`), conversion atomique en événement avec trace
// bidirectionnelle (`resulting_event_id` <-> `source_date_poll_id`) et création du fil de discussion.
describe('sondages de dates', () => {
  let d: Decor;
  let alice: Personne;
  let bob: Personne;
  let carole: Personne;
  let g: GroupeAmorce;

  beforeEach(async () => {
    d = decor();
    alice = await personne(d, 'alice_s');
    bob = await personne(d, 'bob_s');
    carole = await personne(d, 'carole_s');
    g = await groupe(d, 'Les amis', [
      { personne: alice, role: 'admin' },
      { personne: bob, role: 'member' },
      { personne: carole, role: 'member' },
    ]);
  });
  afterEach(() => d.nettoyer());

  const base = (): string => `/api/groupes/${g.groupId}/sondages`;
  const baseEvenements = (): string => `/api/groupes/${g.groupId}/evenements`;

  it('parcours complet : création, ajout/retrait d’option, votes de 3 membres, dépouillement et conversion en événement', async () => {
    // 1. Création d'un sondage avec deux créneaux initiaux
    const creation = await alice.client.post(base(), {
      title: 'Week-end à la mer',
      description: 'On choisit quel week-end partir',
      options: [
        { all_day: true, starts_at: '2027-05-08', ends_at: '2027-05-09' },
        { all_day: true, starts_at: '2027-05-15', ends_at: '2027-05-16' },
      ],
    });
    expect(creation.statut).toBe(201);
    const sondageId = creation.corps['id'] as string;
    expect(creation.corps).toMatchObject({
      id: sondageId,
      title: 'Week-end à la mer',
      description: 'On choisit quel week-end partir',
      status: 'open',
      closes_at: null,
      resulting_event_id: null,
      auteur: { membership_id: membreDe(g, alice), display_name: expect.any(String) },
    });
    const optionsInitiales = creation.corps['options'] as Array<{ id: string; position: number; all_day: boolean; starts_at: string }>;
    expect(optionsInitiales).toHaveLength(2);
    expect(optionsInitiales.map((o) => o.position)).toEqual([1, 2]);
    // Au départ (0 partout), la première option par position est en tête
    expect(creation.corps['option_gagnante_id']).toBe(optionsInitiales[0]?.id);

    // 2. Ajout d'une troisième option, puis d'une quatrième qu'on retire après un vote
    const ajout3 = await bob.client.post(`${base()}/${sondageId}/options`, {
      all_day: true,
      starts_at: '2027-05-22',
      ends_at: '2027-05-23',
    });
    expect(ajout3.statut).toBe(201);
    const ajout4 = await bob.client.post(`${base()}/${sondageId}/options`, {
      all_day: true,
      starts_at: '2027-05-29',
      ends_at: '2027-05-30',
    });
    expect(ajout4.statut).toBe(201);
    const toutes = ajout4.corps['options'] as Array<{ id: string; starts_at: string; position: number }>;
    expect(toutes).toHaveLength(4);
    const opt1 = toutes[0]?.id ?? '';
    const opt2 = toutes[1]?.id ?? '';
    const opt3 = toutes[2]?.id ?? '';
    const opt4 = toutes[3]?.id ?? '';

    // Vote sur opt4 puis retrait de opt4 (vérifie la suppression propre des votes liés)
    expect((await alice.client.put(`${base()}/${sondageId}/options/${opt4}/mon-vote`, { value: 'yes' })).statut).toBe(200);
    const retrait = await alice.client.delete(`${base()}/${sondageId}/options/${opt4}`);
    expect(retrait.statut).toBe(200);
    expect((retrait.corps['options'] as Array<{ id: string }>).map((o) => o.id)).toEqual([opt1, opt2, opt3]);

    // 3. Votes des 3 membres (Alice, Bob, Carole) :
    // - opt1 : Alice = maybe (1), Bob = maybe (1), Carole = yes (2) -> score = 4 (1 yes, 2 maybe)
    // - opt2 : Alice = yes (2), Bob = yes (2), Carole = no (0)      -> score = 4 (2 yes, 0 maybe, 1 no)
    // - opt3 : Alice = yes (2), Bob = no (0), Carole = maybe (1)    -> score = 3 (1 yes, 1 maybe, 1 no)
    // À score égal (4), opt2 doit gagner devant opt1 car elle a 2 « yes » contre 1 « yes » !
    await alice.client.put(`${base()}/${sondageId}/options/${opt1}/mon-vote`, { value: 'maybe' });
    await bob.client.put(`${base()}/${sondageId}/options/${opt1}/mon-vote`, { value: 'maybe' });
    await carole.client.put(`${base()}/${sondageId}/options/${opt1}/mon-vote`, { value: 'yes' });

    await alice.client.put(`${base()}/${sondageId}/options/${opt2}/mon-vote`, { value: 'yes' });
    await bob.client.put(`${base()}/${sondageId}/options/${opt2}/mon-vote`, { value: 'yes' });
    await carole.client.put(`${base()}/${sondageId}/options/${opt2}/mon-vote`, { value: 'no' });

    await alice.client.put(`${base()}/${sondageId}/options/${opt3}/mon-vote`, { value: 'yes' });
    await bob.client.put(`${base()}/${sondageId}/options/${opt3}/mon-vote`, { value: 'no' });
    const detailVote = await carole.client.put(`${base()}/${sondageId}/options/${opt3}/mon-vote`, { value: 'maybe' });
    expect(detailVote.statut).toBe(200);

    const optionsVotees = detailVote.corps['options'] as Array<{
      id: string;
      mon_vote: string | null;
      compteurs: { yes: number; maybe: number; no: number; score: number };
      votes: Array<{ membership_id: string; value: string }>;
    }>;
    expect(optionsVotees.find((o) => o.id === opt1)?.compteurs).toEqual({ yes: 1, maybe: 2, no: 0, score: 4 });
    expect(optionsVotees.find((o) => o.id === opt2)?.compteurs).toEqual({ yes: 2, maybe: 0, no: 1, score: 4 });
    expect(optionsVotees.find((o) => o.id === opt3)?.compteurs).toEqual({ yes: 1, maybe: 1, no: 1, score: 3 });
    expect(optionsVotees.find((o) => o.id === opt2)?.mon_vote).toBe('no'); // vu par Carole
    expect(detailVote.corps['option_gagnante_id']).toBe(opt2);

    // 4. Conversion du sondage en événement (sans option_id : prend l'option gagnante opt2)
    const conversion = await alice.client.post(`${base()}/${sondageId}/conversion`, {
      location_name: 'Saint-Malo',
    });
    expect(conversion.statut).toBe(201);
    const sondageConverti = conversion.corps['sondage'] as Record<string, unknown>;
    const evenementCree = conversion.corps['evenement'] as Record<string, unknown>;
    const evenementId = evenementCree['id'] as string;

    // Trace dans les deux sens : resulting_event_id sur le sondage, source_date_poll_id sur l'événement
    expect(sondageConverti).toMatchObject({
      id: sondageId,
      status: 'converted',
      resulting_event_id: evenementId,
    });
    expect(evenementCree).toMatchObject({
      id: evenementId,
      title: 'Week-end à la mer',
      description: 'On choisit quel week-end partir',
      location_name: 'Saint-Malo',
      all_day: true,
      starts_at: '2027-05-15',
      ends_at: '2027-05-16',
      status: 'published',
      source_date_poll_id: sondageId,
    });
    expect(typeof evenementCree['thread_id']).toBe('string');

    // Vérification via GET /evenements/:id et en base (fil de discussion créé)
    const lectureEvenement = await bob.client.get(`${baseEvenements()}/${evenementId}`);
    expect(lectureEvenement.statut).toBe(200);
    expect(lectureEvenement.corps['source_date_poll_id']).toBe(sondageId);
    const fils = d.sql.prepare('SELECT id, kind, group_id FROM threads WHERE event_id = ?').all(evenementId);
    expect(fils).toEqual([{ id: evenementCree['thread_id'], kind: 'event', group_id: g.groupId }]);

    // 5. Une fois converti, tout vote, modification, annulation ou seconde conversion est refusé en 409
    expect((await bob.client.put(`${base()}/${sondageId}/options/${opt1}/mon-vote`, { value: 'yes' })).corps).toEqual({
      error: 'sondage.ferme',
    });
    expect((await bob.client.post(`${base()}/${sondageId}/options`, { starts_at: '2027-06-01T18:00:00Z' })).corps).toEqual({
      error: 'sondage.ferme',
    });
    expect((await alice.client.delete(`${base()}/${sondageId}/options/${opt1}`)).corps).toEqual({
      error: 'sondage.ferme',
    });
    expect((await alice.client.patch(`${base()}/${sondageId}`, { title: 'Autre titre' })).corps).toEqual({
      error: 'sondage.deja_converti',
    });
    expect((await alice.client.delete(`${base()}/${sondageId}`)).corps).toEqual({
      error: 'sondage.deja_converti',
    });
    expect((await alice.client.post(`${base()}/${sondageId}/conversion`, {})).corps).toEqual({
      error: 'sondage.deja_converti',
    });
  });

  it('refuse les doublons d’options à la création et à l’ajout (409 sondage.option_dupliquee)', async () => {
    const doublonCreation = await alice.client.post(base(), {
      title: 'Dîner',
      options: [
        { starts_at: '2027-04-10T19:00:00Z' },
        { starts_at: '2027-04-10T19:00:00Z' },
      ],
    });
    expect(doublonCreation.statut).toBe(409);
    expect(doublonCreation.corps).toEqual({ error: 'sondage.option_dupliquee' });

    const cree = await alice.client.post(base(), {
      title: 'Dîner',
      options: [{ starts_at: '2027-04-10T19:00:00Z', ends_at: '2027-04-10T22:00:00Z' }],
    });
    expect(cree.statut).toBe(201);
    const sondageId = cree.corps['id'] as string;

    const doublonAjout = await bob.client.post(`${base()}/${sondageId}/options`, {
      starts_at: '2027-04-10T19:00:00Z',
      ends_at: '2027-04-10T22:00:00Z',
    });
    expect(doublonAjout.statut).toBe(409);
    expect(doublonAjout.corps).toEqual({ error: 'sondage.option_dupliquee' });
  });

  it('bloque les votes et l’ajout d’options lorsque closes_at est dépassé, mais permet la conversion', async () => {
    const dansUneHeure = new Date(d.temps.maintenant().getTime() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const cree = await alice.client.post(base(), {
      title: 'Soirée jeux',
      closes_at: dansUneHeure,
      options: [{ starts_at: '2027-06-10T19:00:00Z' }],
    });
    expect(cree.statut).toBe(201);
    const sondageId = cree.corps['id'] as string;
    const optionId = (cree.corps['options'] as Array<{ id: string }>)[0]?.id ?? '';

    // Avant l'échéance : le vote passe
    expect((await bob.client.put(`${base()}/${sondageId}/options/${optionId}/mon-vote`, { value: 'yes' })).statut).toBe(200);

    // À l'échéance : le sondage est clos pour les votes et l'ajout d'options
    d.temps.avancer(3_600_000);
    const voteTardif = await carole.client.put(`${base()}/${sondageId}/options/${optionId}/mon-vote`, { value: 'yes' });
    expect(voteTardif.statut).toBe(409);
    expect(voteTardif.corps).toEqual({ error: 'sondage.ferme' });

    const ajoutTardif = await carole.client.post(`${base()}/${sondageId}/options`, { starts_at: '2027-06-11T19:00:00Z' });
    expect(ajoutTardif.statut).toBe(409);
    expect(ajoutTardif.corps).toEqual({ error: 'sondage.ferme' });

    // La conversion en événement reste permise une fois la clôture atteinte
    const conversion = await alice.client.post(`${base()}/${sondageId}/conversion`, {});
    expect(conversion.statut).toBe(201);
  });

  it('gère l’annulation idempotente et refuse toute modification ou conversion après annulation', async () => {
    const cree = await alice.client.post(base(), {
      title: 'Cinéma',
      options: [
        { starts_at: '2027-06-10T20:00:00Z' },
        { starts_at: '2027-06-11T20:00:00Z' },
      ],
    });
    const sondageId = cree.corps['id'] as string;
    const optionId = (cree.corps['options'] as Array<{ id: string }>)[0]?.id ?? '';

    // Retrait de toutes les options sur un autre sondage -> 409 sondage.aucune_option à la conversion
    const vide = await alice.client.post(base(), {
      title: 'Sondage vidé',
      options: [{ starts_at: '2027-06-15T20:00:00Z' }],
    });
    const videId = vide.corps['id'] as string;
    const videOpt = (vide.corps['options'] as Array<{ id: string }>)[0]?.id ?? '';
    expect((await alice.client.delete(`${base()}/${videId}/options/${videOpt}`)).statut).toBe(200);
    expect((await alice.client.post(`${base()}/${videId}/conversion`, {})).corps).toEqual({
      error: 'sondage.aucune_option',
    });

    // Annulation du premier sondage
    const annulation = await alice.client.delete(`${base()}/${sondageId}`);
    expect(annulation.statut).toBe(200);
    expect(annulation.corps['status']).toBe('cancelled');
    // Idempotence
    expect((await alice.client.delete(`${base()}/${sondageId}`)).statut).toBe(200);

    // Refus de modifier, voter ou convertir un sondage annulé
    expect((await alice.client.patch(`${base()}/${sondageId}`, { title: 'Nouveau' })).corps).toEqual({
      error: 'sondage.annule',
    });
    expect((await bob.client.put(`${base()}/${sondageId}/options/${optionId}/mon-vote`, { value: 'yes' })).corps).toEqual({
      error: 'sondage.ferme',
    });
    expect((await alice.client.post(`${base()}/${sondageId}/conversion`, {})).corps).toEqual({
      error: 'sondage.annule',
    });

    // Liste des sondages du groupe
    const liste = await bob.client.get(base());
    expect(liste.statut).toBe(200);
    expect((liste.corps['sondages'] as Array<{ id: string }>).map((s) => s.id)).toEqual([videId, sondageId]);
  });

  it('réserve modification, annulation, conversion et retrait d’option à l’auteur et aux admins (tout membre vote)', async () => {
    const cree = await bob.client.post(base(), {
      title: 'Brunch de Bob',
      options: [{ starts_at: '2027-07-10T10:00:00Z' }, { starts_at: '2027-07-11T10:00:00Z' }],
    });
    expect(cree.statut).toBe(201);
    const sondageId = cree.corps['id'] as string;
    const options = cree.corps['options'] as Array<{ id: string }>;
    const optionId = options[0]?.id ?? '';

    // Carole, simple membre non auteur : 403 sur chaque écriture réservée.
    const refus = { error: 'droit.auteur_requis' };
    expect(await carole.client.patch(`${base()}/${sondageId}`, { title: 'Piraté' })).toMatchObject({ statut: 403, corps: refus });
    expect(await carole.client.delete(`${base()}/${sondageId}`)).toMatchObject({ statut: 403, corps: refus });
    expect(await carole.client.post(`${base()}/${sondageId}/conversion`, {})).toMatchObject({ statut: 403, corps: refus });
    expect(await carole.client.delete(`${base()}/${sondageId}/options/${optionId}`)).toMatchObject({ statut: 403, corps: refus });

    // 404 avant 403 : un sondage inexistant reste un 404 pour elle.
    const inconnu = '00000000-0000-7000-8000-000000000000';
    expect((await carole.client.patch(`${base()}/${inconnu}`, { title: 'X' })).statut).toBe(404);
    expect((await carole.client.delete(`${base()}/${inconnu}`)).statut).toBe(404);

    // Rien n'a bougé, et elle peut voter et proposer une date.
    expect((await alice.client.get(`${base()}/${sondageId}`)).corps['title']).toBe('Brunch de Bob');
    expect((await carole.client.put(`${base()}/${sondageId}/options/${optionId}/mon-vote`, { value: 'yes' })).statut).toBe(200);
    expect((await carole.client.post(`${base()}/${sondageId}/options`, { starts_at: '2027-07-12T10:00:00Z' })).statut).toBe(201);

    // L'auteur (simple membre) modifie ; l'admin aussi, annule et convertit un sondage qui n'est pas le sien.
    expect((await bob.client.patch(`${base()}/${sondageId}`, { title: 'Brunch' })).statut).toBe(200);
    expect((await alice.client.patch(`${base()}/${sondageId}`, { title: 'Brunch (admin)' })).statut).toBe(200);
    expect((await alice.client.post(`${base()}/${sondageId}/conversion`, {})).statut).toBe(201);

    const autre = await bob.client.post(base(), { title: 'À annuler', options: [{ starts_at: '2027-08-10T10:00:00Z' }] });
    const autreId = autre.corps['id'] as string;
    expect((await alice.client.delete(`${base()}/${autreId}`)).statut).toBe(200);
  });
});
