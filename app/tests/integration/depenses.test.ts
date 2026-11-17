import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Decor } from '../fixtures/comptes.js';
import { decor, groupe, membreDe, personne, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';

describe('dépenses partagées, soldes, remboursements et clôture (intégration HTTP)', () => {
  let d: Decor;
  let alice: Personne;
  let bob: Personne;
  let carole: Personne;
  let g: GroupeAmorce;

  beforeEach(async () => {
    d = decor();
    alice = await personne(d, 'alice_dep');
    bob = await personne(d, 'bob_dep');
    carole = await personne(d, 'carole_dep');
    g = await groupe(d, 'Coloc', [
      { personne: alice, role: 'admin' },
      { personne: bob, role: 'member' },
      { personne: carole, role: 'member' },
    ]);
  });

  afterEach(() => d.nettoyer());

  it('parcours complet : devises, dépense multi-devises, soldes, remboursement, confirmation et clôture', async () => {
    const devRes = await alice.client.get('/api/devises');
    expect(devRes.statut).toBe(200);
    const devises = devRes.corps['devises'] as Array<{ code: string; exponent: number }>;
    expect(devises.some((x) => x.code === 'EUR' && x.exponent === 2)).toBe(true);
    expect(devises.some((x) => x.code === 'JPY' && x.exponent === 0)).toBe(true);

    const evtRes = await alice.client.post(`/api/groupes/${g.groupId}/evenements`, {
      title: 'Voyage Japon',
      starts_at: '2027-05-01T10:00:00Z',
      time_zone: 'Europe/Paris',
      currency_code: 'EUR',
    });
    expect(evtRes.statut).toBe(201);
    const eventId = evtRes.corps['id'] as string;

    const depRes = await alice.client.post(`/api/groupes/${g.groupId}/depenses`, {
      event_id: eventId,
      label: 'Hôtel Kyoto',
      spent_on: '2027-05-01',
      payer_membership_id: membreDe(g, alice),
      amount_minor: 10000,
      currency_code: 'JPY',
      rate_ppm: 6000,
      split_mode: 'equal',
      shares: [{ membership_id: membreDe(g, alice) }, { membership_id: membreDe(g, bob) }],
    });
    expect(depRes.statut).toBe(201);
    expect(depRes.corps['amount_target_minor']).toBe(6000);

    const soldesRes = await bob.client.get(`/api/groupes/${g.groupId}/soldes?evenement=${eventId}`);
    expect(soldesRes.statut).toBe(200);
    const ardoises = soldesRes.corps['ardoises'] as Array<{ currency_code: string; transferts: Array<{ amount_minor: number }> }>;
    expect(ardoises[0]?.transferts[0]?.amount_minor).toBe(3000);

    const rembRes = await bob.client.post(`/api/groupes/${g.groupId}/remboursements`, {
      event_id: eventId,
      from_membership_id: membreDe(g, bob),
      to_membership_id: membreDe(g, alice),
      amount_minor: 3000,
      currency_code: 'EUR',
      settled_on: '2027-05-02',
    });
    expect(rembRes.statut).toBe(201);
    const rembId = rembRes.corps['id'] as string;

    // Carole (non bénéficiaire) ne peut pas confirmer
    const confCarole = await carole.client.post(`/api/groupes/${g.groupId}/remboursements/${rembId}/confirmation`);
    expect(confCarole.statut).toBe(403);

    // Alice (bénéficiaire) confirme
    const confAlice = await alice.client.post(`/api/groupes/${g.groupId}/remboursements/${rembId}/confirmation`);
    expect(confAlice.statut).toBe(200);
    expect(confAlice.corps['confirmed_by_membership_id']).toBe(membreDe(g, alice));

    // Clôture par l'organisatrice
    const clotureRes = await alice.client.post(`/api/groupes/${g.groupId}/evenements/${eventId}/cloture`);
    expect(clotureRes.statut).toBe(201);

    // Ajout bloqué (409)
    const bloque = await bob.client.post(`/api/groupes/${g.groupId}/depenses`, {
      event_id: eventId,
      label: 'Oubli',
      spent_on: '2027-05-02',
      payer_membership_id: membreDe(g, bob),
      amount_minor: 500,
      currency_code: 'EUR',
      split_mode: 'equal',
      shares: [{ membership_id: membreDe(g, bob) }],
    });
    expect(bloque.statut).toBe(409);
  });

  it('deux dépenses proches de MAX_SAFE_INTEGER : la clôture répond 422, pas 500, et l’événement reste ouvert', async () => {
    const evtRes = await alice.client.post(`/api/groupes/${g.groupId}/evenements`, {
      title: 'Montants extrêmes',
      starts_at: '2027-06-01T10:00:00Z',
      time_zone: 'Europe/Paris',
      currency_code: 'EUR',
    });
    expect(evtRes.statut).toBe(201);
    const eventId = evtRes.corps['id'] as string;
    for (const libelle of ['A', 'B']) {
      const r = await alice.client.post(`/api/groupes/${g.groupId}/depenses`, {
        event_id: eventId,
        label: `Énorme ${libelle}`,
        spent_on: '2027-06-01',
        payer_membership_id: membreDe(g, alice),
        amount_minor: Number.MAX_SAFE_INTEGER - 1,
        currency_code: 'EUR',
        split_mode: 'equal',
        shares: [{ membership_id: membreDe(g, alice) }, { membership_id: membreDe(g, bob) }],
      });
      expect(r.statut).toBe(201);
    }

    const cloture = await alice.client.post(`/api/groupes/${g.groupId}/evenements/${eventId}/cloture`);
    expect(cloture.statut).toBe(422);
    expect(cloture.corps).toEqual({ error: 'depense.montants_trop_grands' });
    // Seul le total additionné déborde : les soldes restent lisibles.
    expect((await bob.client.get(`/api/groupes/${g.groupId}/soldes?evenement=${eventId}`)).statut).toBe(200);
    // Aucune clôture n'a été écrite (la transaction est annulée).
    expect(d.sql.prepare('SELECT COUNT(*) FROM expense_closures').pluck().get()).toBe(0);
  });

  it('clôture un événement dont la devise a changé sans additionner deux devises (ADR-0004)', async () => {
    // Événement sans devise dans un groupe en EUR : la première dépense est cadrée en EUR.
    const evtRes = await alice.client.post(`/api/groupes/${g.groupId}/evenements`, {
      title: 'Week-end',
      starts_at: '2027-06-01T10:00:00Z',
      time_zone: 'Europe/Paris',
    });
    expect(evtRes.statut).toBe(201);
    const eventId = evtRes.corps['id'] as string;
    const participants = [{ membership_id: membreDe(g, alice) }, { membership_id: membreDe(g, bob) }];
    const depenser = (montant: number, devise: string): ReturnType<typeof alice.client.post> =>
      alice.client.post(`/api/groupes/${g.groupId}/depenses`, {
        event_id: eventId,
        label: `Dépense ${devise}`,
        spent_on: '2027-06-01',
        payer_membership_id: membreDe(g, alice),
        amount_minor: montant,
        currency_code: devise,
        split_mode: 'equal',
        shares: participants,
      });
    expect((await depenser(5000, 'EUR')).statut).toBe(201);

    // L'organisateur passe l'événement en USD, puis une dépense de 30 $ arrive.
    const patch = await alice.client.patch(`/api/groupes/${g.groupId}/evenements/${eventId}`, { currency_code: 'USD' });
    expect(patch.statut).toBe(200);
    expect((await depenser(3000, 'USD')).statut).toBe(201);

    const cloture = await alice.client.post(`/api/groupes/${g.groupId}/evenements/${eventId}/cloture`);
    expect(cloture.statut).toBe(201);
    const ligne = cloture.corps['cloture'] as { currency_code: string; total_minor: number };
    // 80,00 serait faux : seul le total dans la devise de la clôture est enregistré.
    expect(ligne.currency_code).toBe('USD');
    expect(ligne.total_minor).toBe(3000);
    // Chaque devise garde son ardoise, relue (et validée) depuis le snapshot.
    const relu = await bob.client.get(`/api/groupes/${g.groupId}/soldes?evenement=${eventId}`);
    expect(relu.statut).toBe(200);
    const ardoises = relu.corps['ardoises'] as Array<{ currency_code: string }>;
    expect(ardoises.map((a) => a.currency_code)).toEqual(['EUR', 'USD']);
  });

  it('refuse un taux déclaré « provider » (aucun fournisseur de taux) et une liste de parts démesurée', async () => {
    const base = {
      label: 'Courses',
      spent_on: '2027-06-01',
      payer_membership_id: membreDe(g, alice),
      amount_minor: 1000,
      currency_code: 'JPY',
      rate_ppm: 6000,
      split_mode: 'equal',
    };
    const provider = await alice.client.post(`/api/groupes/${g.groupId}/depenses`, {
      ...base,
      rate_source: 'provider',
      shares: [{ membership_id: membreDe(g, alice) }],
    });
    expect(provider.statut).toBe(400);
    const demesure = await alice.client.post(`/api/groupes/${g.groupId}/depenses`, {
      ...base,
      shares: Array.from({ length: 201 }, () => ({ membership_id: membreDe(g, alice) })),
    });
    expect(demesure.statut).toBe(400);
  });
});
