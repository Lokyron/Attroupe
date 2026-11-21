import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Decor } from '../fixtures/comptes.js';
import { decor, groupe, membreDe, personne, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';

// Annulation d'un règlement : DELETE /api/groupes/:g/remboursements/:id. Droits (auteur ou administrateur), refus après confirmation,
// effet sur les soldes, et sort de la notification « un règlement attend votre confirmation » déjà envoyée au destinataire.
describe('suppression d’un remboursement (intégration HTTP)', () => {
  let d: Decor;
  let alice: Personne; // administratrice
  let bob: Personne;
  let carole: Personne;
  let g: GroupeAmorce;

  const chemin = (suffixe = ''): string => `/api/groupes/${g.groupId}/remboursements${suffixe}`;

  /** Bob a payé 3000 pour Alice et lui : Alice lui doit 1500. */
  const depenseDeBob = async (): Promise<void> => {
    const r = await bob.client.post(`/api/groupes/${g.groupId}/depenses`, {
      event_id: null,
      label: 'Courses',
      spent_on: '2027-05-01',
      payer_membership_id: membreDe(g, bob),
      amount_minor: 3000,
      currency_code: 'EUR',
      split_mode: 'equal',
      shares: [{ membership_id: membreDe(g, alice) }, { membership_id: membreDe(g, bob) }],
    });
    expect(r.statut, JSON.stringify(r.corps)).toBe(201);
  };

  /** Alice rembourse Bob de 1500, saisi par `auteur`. */
  const rembourser = async (auteur: Personne = alice): Promise<string> => {
    const r = await auteur.client.post(chemin(), {
      event_id: null,
      from_membership_id: membreDe(g, alice),
      to_membership_id: membreDe(g, bob),
      amount_minor: 1500,
      currency_code: 'EUR',
      settled_on: '2027-05-02',
    });
    expect(r.statut, JSON.stringify(r.corps)).toBe(201);
    return r.corps['id'] as string;
  };

  const transferts = async (): Promise<Array<{ currency_code: string; from_membership_id: string; to_membership_id: string; amount_minor: number }>> => {
    const r = await carole.client.get(`/api/groupes/${g.groupId}/soldes`);
    expect(r.statut).toBe(200);
    const ardoises = r.corps['ardoises'] as Array<{ currency_code: string; transferts: Array<{ from_membership_id: string; to_membership_id: string; amount_minor: number }> }>;
    return ardoises.flatMap((a) => a.transferts.map((t) => ({ currency_code: a.currency_code, ...t })));
  };

  const notificationsDe = async (p: Personne): Promise<Array<{ kind: string; subject_id: string | null }>> =>
    (await p.client.get('/api/moi/notifications')).corps['notifications'] as Array<{ kind: string; subject_id: string | null }>;

  beforeEach(async () => {
    d = decor();
    alice = await personne(d, 'alice_rs');
    bob = await personne(d, 'bob_rs');
    carole = await personne(d, 'carole_rs');
    g = await groupe(d, 'Coloc', [
      { personne: alice, role: 'admin' },
      { personne: bob, role: 'member' },
      { personne: carole, role: 'member' },
    ]);
  });
  afterEach(() => d.nettoyer());

  it('l’auteur supprime son règlement : 200, il disparaît de la liste et répond ensuite 404', async () => {
    const id = await rembourser(alice);
    const r = await alice.client.delete(chemin(`/${id}`));
    expect(r.statut).toBe(200);
    const liste = (await alice.client.get(chemin())).corps['remboursements'] as Array<{ id: string }>;
    expect(liste.map((x) => x.id)).not.toContain(id);
    expect((await alice.client.delete(chemin(`/${id}`))).corps['error']).toBe('remboursement.introuvable');
  });

  it('un administrateur supprime le règlement d’un autre membre ; un simple membre étranger au règlement ne le peut pas (403)', async () => {
    const id = await rembourser(bob); // saisi par Bob
    const refus = await carole.client.delete(chemin(`/${id}`));
    expect(refus.statut).toBe(403);
    expect(refus.corps['error']).toBe('droit.auteur_requis');
    expect((await alice.client.get(chemin())).corps['remboursements']).toHaveLength(1);

    expect((await alice.client.delete(chemin(`/${id}`))).statut).toBe(200); // Alice est administratrice
    expect((await alice.client.get(chemin())).corps['remboursements']).toHaveLength(0);
  });

  it('après confirmation par le bénéficiaire : 409 remboursement.deja_confirme pour l’auteur ; le droit se vérifie avant l’état (403 pour Bob)', async () => {
    const id = await rembourser(alice);
    expect((await bob.client.post(chemin(`/${id}/confirmation`))).statut).toBe(200);
    const auteur = await alice.client.delete(chemin(`/${id}`));
    expect(auteur.statut).toBe(409);
    expect(auteur.corps['error']).toBe('remboursement.deja_confirme');
    expect((await bob.client.delete(chemin(`/${id}`))).statut).toBe(403);
    expect((await alice.client.get(chemin())).corps['remboursements']).toHaveLength(1);
  });

  it('le règlement supprimé n’entre plus dans le calcul des soldes : la dette réapparaît en entier', async () => {
    await depenseDeBob();
    expect(await transferts()).toEqual([{ currency_code: 'EUR', from_membership_id: membreDe(g, alice), to_membership_id: membreDe(g, bob), amount_minor: 1500 }]);

    const id = await rembourser(alice);
    expect(await transferts(), 'le règlement solde la dette').toEqual([]);

    expect((await alice.client.delete(chemin(`/${id}`))).statut).toBe(200);
    expect(await transferts()).toEqual([{ currency_code: 'EUR', from_membership_id: membreDe(g, alice), to_membership_id: membreDe(g, bob), amount_minor: 1500 }]);
  });

  it('la notification « règlement à confirmer » du bénéficiaire disparaît avec le règlement ; ses autres notifications restent', async () => {
    await depenseDeBob(); // notifie Alice (expense_added)
    const id = await rembourser(alice); // notifie Bob (settlement_created)
    expect((await notificationsDe(bob)).map((n) => n.kind)).toContain('settlement_created');

    expect((await alice.client.delete(chemin(`/${id}`))).statut).toBe(200);

    expect((await notificationsDe(bob)).filter((n) => n.subject_id === id)).toEqual([]);
    expect((await bob.client.get('/api/moi/notifications')).corps['non_lues']).toBe(0);
    expect((await notificationsDe(alice)).map((n) => n.kind)).toEqual(['expense_added']);
    // Carole n'a jamais été concernée (hors la notification de son invitation au groupe, qui reste dans son historique).
    expect((await notificationsDe(carole)).map((n) => n.kind)).toEqual(['invitation_received']);
  });

  it('une suppression refusée (409) laisse la notification en place', async () => {
    const id = await rembourser(alice);
    await bob.client.post(chemin(`/${id}/confirmation`));
    expect((await alice.client.delete(chemin(`/${id}`))).statut).toBe(409);
    expect((await notificationsDe(bob)).map((n) => n.kind)).toContain('settlement_created');
  });

  it('cloisonnement : un DELETE par la route du groupe A avec l’identifiant forgé d’un règlement de B laisse intactes les notifications de B', async () => {
    const dave = await personne(d, 'dave_rs');
    const erin = await personne(d, 'erin_rs');
    const gB = await groupe(d, 'Autre coloc', [
      { personne: dave, role: 'admin' },
      { personne: erin, role: 'member' },
    ]);
    const creation = await dave.client.post(`/api/groupes/${gB.groupId}/remboursements`, {
      event_id: null,
      from_membership_id: membreDe(gB, dave),
      to_membership_id: membreDe(gB, erin),
      amount_minor: 800,
      currency_code: 'EUR',
      settled_on: '2027-05-02',
    });
    expect(creation.statut, JSON.stringify(creation.corps)).toBe(201);
    const idB = creation.corps['id'] as string;
    // La preuve n'a de sens que si la notification existe avant l'attaque.
    expect((await notificationsDe(erin)).filter((n) => n.kind === 'settlement_created' && n.subject_id === idB)).toHaveLength(1);

    // Alice, administratrice de A, passe par la route de SON groupe avec l'identifiant du règlement de B.
    const attaque = await alice.client.delete(chemin(`/${idB}`));
    expect(attaque.statut).toBe(404);
    expect(attaque.corps['error']).toBe('remboursement.introuvable');

    expect((await notificationsDe(erin)).filter((n) => n.kind === 'settlement_created' && n.subject_id === idB)).toHaveLength(1);
    expect((await dave.client.get(`/api/groupes/${gB.groupId}/remboursements`)).corps['remboursements']).toHaveLength(1);
    // Et la voie légitime, elle, retire bien la notification de B (la suppression n'est pas inopérante partout).
    expect((await dave.client.delete(`/api/groupes/${gB.groupId}/remboursements/${idB}`)).statut).toBe(200);
    expect((await notificationsDe(erin)).filter((n) => n.subject_id === idB)).toEqual([]);
  });
});
