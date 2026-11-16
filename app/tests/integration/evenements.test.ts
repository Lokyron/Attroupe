import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { creerScope } from '../../server/db/scope.js';
import { peutModifierEvenement, lireEvenement } from '../../server/db/queries/evenements.js';
import type { Decor } from '../fixtures/comptes.js';
import { decor, groupe, membreDe, personne, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';

// L'agenda du groupe (lot 4) : les sept routes, l'autorisation fine (403 contre 404), les règles de date refusées en 400
// avant la base, les compteurs de présence. Le cloisonnement route par route est dans tests/cloisonnement (suite générique).
describe('agenda du groupe', () => {
  let d: Decor;
  let alice: Personne; // administratrice
  let bob: Personne; // membre
  let carole: Personne; // membre
  let dave: Personne; // membre
  let g: GroupeAmorce;
  let autre: GroupeAmorce; // groupe étranger : Erik y est administrateur
  let erik: Personne;

  beforeEach(async () => {
    d = decor();
    alice = await personne(d, 'alice_e');
    bob = await personne(d, 'bob_e');
    carole = await personne(d, 'carole_e');
    dave = await personne(d, 'dave_e');
    erik = await personne(d, 'erik_e');
    g = await groupe(d, 'Les potes', [
      { personne: alice, role: 'admin' },
      { personne: bob, role: 'member' },
      { personne: carole, role: 'member' },
      { personne: dave, role: 'member' },
    ]);
    autre = await groupe(d, 'Les voisins', [{ personne: erik, role: 'admin' }]);
  });
  afterEach(() => d.nettoyer());

  const base = (): string => `/api/groupes/${g.groupId}/evenements`;
  const NOUVEAU = { title: 'Barbecue', starts_at: '2027-03-20T18:00:00Z', time_zone: 'Europe/Paris' } as const;

  /** Crée un événement par l'API et renvoie son identifiant. */
  async function creer(auteur: Personne, corps: Record<string, unknown> = {}, groupeVise: GroupeAmorce = g): Promise<string> {
    const r = await auteur.client.post(`/api/groupes/${groupeVise.groupId}/evenements`, { ...NOUVEAU, ...corps });
    expect(r.statut, JSON.stringify(r.corps)).toBe(201);
    return r.corps['id'] as string;
  }

  const ligneEvenement = (id: string): Record<string, unknown> => d.sql.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown>;

  describe('création', () => {
    it('crée l’événement ET son fil de discussion, l’auteur vient de la session', async () => {
      const r = await bob.client.post(base(), { ...NOUVEAU, description: 'Apportez à boire', location_name: 'Chez Bob', capacity: 12, currency_code: 'EUR' });
      expect(r.statut).toBe(201);
      expect(r.corps).toMatchObject({
        title: 'Barbecue',
        status: 'published',
        all_day: false,
        starts_at: '2027-03-20T18:00:00Z',
        ends_at: null,
        time_zone: 'Europe/Paris',
        description: 'Apportez à boire',
        capacity: 12,
        created_by_membership_id: membreDe(g, bob),
        peut_modifier: true,
        ma_presence: null,
        organisateurs: [],
      });
      const id = r.corps['id'] as string;
      const fils = d.sql.prepare('SELECT id, kind, group_id, created_by_membership_id FROM threads WHERE event_id = ?').all(id);
      expect(fils).toEqual([{ id: r.corps['thread_id'], kind: 'event', group_id: g.groupId, created_by_membership_id: membreDe(g, bob) }]);
      expect(ligneEvenement(id)['group_id']).toBe(g.groupId);
    });

    it('n’écrit ni n’expose les colonnes réservées V2 ni le sondage d’origine', async () => {
      const id = await creer(alice);
      const ligne = ligneEvenement(id);
      expect([ligne['recurrence_rule'], ligne['recurrence_parent_id'], ligne['occurrence_date'], ligne['source_date_poll_id']]).toEqual([null, null, null, null]);
      const detail = await alice.client.get(`${base()}/${id}`);
      for (const cle of ['recurrence_rule', 'recurrence_parent_id', 'occurrence_date', 'deleted_at', 'group_id']) expect(detail.corps).not.toHaveProperty(cle);
    });

    it.each([
      ['recurrence_rule', { recurrence_rule: 'FREQ=WEEKLY' }],
      ['occurrence_date', { occurrence_date: '2027-03-20' }],
      ['source_date_poll_id', { source_date_poll_id: 'x' }],
      ['status', { status: 'cancelled' }],
      ['created_by_membership_id', { created_by_membership_id: 'x' }],
      ['group_id', { group_id: 'x' }],
    ])('refuse le champ %s (400, rien n’est écrit)', async (_nom, extra) => {
      const avant = d.sql.prepare('SELECT count(*) FROM events').pluck().get();
      const r = await alice.client.post(base(), { ...NOUVEAU, ...extra });
      expect(r.statut).toBe(400);
      expect(r.corps['error']).toBe('requete.invalide');
      expect(d.sql.prepare('SELECT count(*) FROM events').pluck().get()).toBe(avant);
    });

    it.each([
      ['une date pour un événement horaire', { starts_at: '2027-03-20' }, 'starts_at'],
      ['un instant pour une journée entière', { all_day: true, starts_at: '2027-03-20T18:00:00Z' }, 'starts_at'],
      ['un instant sans Z', { starts_at: '2027-03-20T18:00:00' }, 'starts_at'],
      ['le 30 février', { starts_at: '2027-02-30T10:00:00Z' }, 'starts_at'],
      ['une fin avant le début', { ends_at: '2027-03-20T17:00:00Z' }, 'ends_at'],
      ['une fin de format différent', { ends_at: '2027-03-21' }, 'ends_at'],
      ['une fin de journée entière trop courte', { all_day: true, starts_at: '2027-03-20', ends_at: '2027-03-21T10:00:00Z' }, 'ends_at'],
      ['un fuseau bidon', { time_zone: 'Mars/Olympus_Mons' }, 'time_zone'],
      ['un titre vide', { title: '   ' }, 'title'],
      ['un titre de 141 caractères', { title: 'x'.repeat(141) }, 'title'],
      ['une capacité nulle', { capacity: 0 }, 'capacity'],
    ])('refuse %s en 400 (pas en 500), en nommant le champ', async (_nom, extra, champ) => {
      const r = await alice.client.post(base(), { ...NOUVEAU, ...extra });
      expect(r.statut).toBe(400);
      expect(r.corps).toEqual({ error: 'requete.invalide', champs: [champ] });
    });

    it('exige un fuseau', async () => {
      const r = await alice.client.post(base(), { title: 'Sans fuseau', starts_at: NOUVEAU.starts_at });
      expect(r.statut).toBe(400);
      expect(r.corps['champs']).toEqual(['time_zone']);
    });

    it('accepte une journée entière sur plusieurs jours', async () => {
      const r = await alice.client.post(base(), { ...NOUVEAU, title: 'Week-end', all_day: true, starts_at: '2027-05-08', ends_at: '2027-05-09' });
      expect(r.statut).toBe(201);
      expect(r.corps).toMatchObject({ all_day: true, starts_at: '2027-05-08', ends_at: '2027-05-09' });
    });

    it('refuse une devise inconnue (400) et un hôte d’un autre groupe (404), sans rien écrire', async () => {
      const devise = await alice.client.post(base(), { ...NOUVEAU, currency_code: 'ZZZ' });
      expect(devise.statut).toBe(400);
      expect(devise.corps).toEqual({ error: 'evenement.devise_inconnue' });
      const hoteEtranger = await alice.client.post(base(), { ...NOUVEAU, host_membership_id: membreDe(autre, erik) });
      expect(hoteEtranger.statut).toBe(404);
      expect(hoteEtranger.corps).toEqual({ error: 'membre.introuvable' });
      expect(d.sql.prepare('SELECT count(*) FROM events').pluck().get()).toBe(0);
      const hote = await alice.client.post(base(), { ...NOUVEAU, host_membership_id: membreDe(g, carole) });
      expect(hote.statut).toBe(201);
      expect(hote.corps['host_membership_id']).toBe(membreDe(g, carole));
    });

    it('refuse un hôte qui a quitté le groupe (409)', async () => {
      d.sql.prepare("UPDATE memberships SET status = 'left', ended_at = ? WHERE id = ?").run('2026-11-16T00:00:00Z', membreDe(g, carole));
      const r = await alice.client.post(base(), { ...NOUVEAU, host_membership_id: membreDe(g, carole) });
      expect(r.statut).toBe(409);
      expect(r.corps).toEqual({ error: 'membre.inactif' });
    });
  });

  describe('lecture', () => {
    it('le détail rend l’événement, le fil, les organisateurs et mon droit', async () => {
      const id = await creer(alice);
      await alice.client.post(`${base()}/${id}/organisateurs/${membreDe(g, carole)}`);
      const r = await bob.client.get(`${base()}/${id}`);
      expect(r.statut).toBe(200);
      expect(r.corps).toMatchObject({ id, title: 'Barbecue', peut_modifier: false });
      expect(r.corps['organisateurs']).toEqual([{ membership_id: membreDe(g, carole), display_name: expect.any(String) }]);
      expect(r.corps['auteur']).toEqual({ membership_id: membreDe(g, alice), display_name: expect.any(String) });
      expect(typeof r.corps['thread_id']).toBe('string');
    });

    it('un événement inexistant est un 404 evenement.introuvable', async () => {
      const r = await alice.client.get(`${base()}/00000000-0000-7000-8000-000000000000`);
      expect(r.statut).toBe(404);
      expect(r.corps).toEqual({ error: 'evenement.introuvable' });
    });

    describe('fenêtre d’agenda', () => {
      beforeEach(async () => {
        await creer(alice, { title: 'Avant', starts_at: '2027-02-27T10:00:00Z' });
        await creer(alice, { title: 'Début de mois', starts_at: '2027-03-01T08:00:00Z' });
        await creer(alice, { title: 'Dernier jour', starts_at: '2027-03-31T22:30:00Z' });
        await creer(alice, { title: 'Chevauche le début', starts_at: '2027-02-28T20:00:00Z', ends_at: '2027-03-01T03:00:00Z' });
        await creer(alice, { title: 'Journée du 15', all_day: true, starts_at: '2027-03-15' });
        await creer(alice, { title: 'Week-end à cheval', all_day: true, starts_at: '2027-02-27', ends_at: '2027-03-02' });
        await creer(alice, { title: 'Après', starts_at: '2027-04-01T00:00:00Z' });
      });
      const titres = async (requete: string): Promise<string[]> => {
        const r = await bob.client.get(`${base()}${requete}`);
        expect(r.statut).toBe(200);
        return (r.corps['evenements'] as Array<{ title: string }>).map((e) => e.title);
      };

      it('mars : ceux qui commencent dedans et ceux qui y entrent, triés', async () => {
        expect(await titres('?du=2027-03-01&au=2027-03-31')).toEqual(['Week-end à cheval', 'Chevauche le début', 'Début de mois', 'Journée du 15', 'Dernier jour']);
      });

      it('un seul jour', async () => {
        expect(await titres('?du=2027-03-15&au=2027-03-15')).toEqual(['Journée du 15']);
      });

      it('du seul : à partir de ce jour, sans limite de fin', async () => {
        expect(await titres('?du=2000-01-01')).toHaveLength(7);
        expect(await titres('?du=2027-03-31')).toEqual(['Dernier jour', 'Après']);
      });

      it('`du` est obligatoire : sans lui, 400 en nommant le champ (pas de limite muette)', async () => {
        for (const requete of ['', '?au=2027-02-27']) {
          const r = await bob.client.get(`${base()}${requete}`);
          expect(r.statut).toBe(400);
          expect(r.corps).toEqual({ error: 'requete.invalide', champs: ['du'] });
        }
      });

      it('un événement annulé reste dans l’agenda, avec son statut', async () => {
        const r = await bob.client.get(`${base()}?du=2027-03-15&au=2027-03-15`);
        const id = (r.corps['evenements'] as Array<{ id: string }>)[0]?.id;
        expect((await alice.client.delete(`${base()}/${id ?? ''}`)).statut).toBe(200);
        const apres = await bob.client.get(`${base()}?du=2027-03-15&au=2027-03-15`);
        expect((apres.corps['evenements'] as Array<{ status: string }>).map((e) => e.status)).toEqual(['cancelled']);
      });

      it.each(['?du=demain', '?du=2027-02-30', '?du=2027-03-31&au=2027-03-01', '?du=2020-01-01&au=2027-01-01', '?x=1', '?du=2027-03-01&du=2027-03-02'])(
        'refuse la fenêtre %s (400)',
        async (requete) => {
          const r = await bob.client.get(`${base()}${requete}`);
          expect(r.statut).toBe(400);
          expect(r.corps['error']).toBe('requete.invalide');
        },
      );

      it('ne montre jamais les événements d’un autre groupe', async () => {
        await creer(erik, { title: 'Chez les voisins' }, autre);
        expect(await titres('?du=2000-01-01')).not.toContain('Chez les voisins');
        expect(await titres('?du=2000-01-01')).toHaveLength(7);
      });
    });
  });

  describe('modification et annulation : 403 contre 404', () => {
    it('l’auteur, un co-organisateur et un administrateur modifient ; un simple membre reçoit 403', async () => {
      const id = await creer(bob);
      const url = `${base()}/${id}`;
      expect((await bob.client.patch(url, { title: 'Par l’auteur' })).statut).toBe(200);
      expect((await alice.client.patch(url, { title: 'Par l’administratrice' })).statut).toBe(200);
      const refus = await carole.client.patch(url, { title: 'Pirate' });
      expect(refus.statut).toBe(403);
      expect(refus.corps).toEqual({ error: 'droit.organisateur_requis' });
      expect(ligneEvenement(id)['title']).toBe('Par l’administratrice');

      expect((await bob.client.post(`${url}/organisateurs/${membreDe(g, carole)}`)).statut).toBe(200);
      const accepte = await carole.client.patch(url, { title: 'Par la co-organisatrice' });
      expect(accepte.statut).toBe(200);
      expect(accepte.corps).toMatchObject({ title: 'Par la co-organisatrice', peut_modifier: true });
    });

    it('un événement d’un autre groupe est un 404, même pour un administrateur de son propre groupe ; jamais 403', async () => {
      const chezEux = await creer(erik, { title: 'Chez les voisins' }, autre);
      for (const r of [
        await alice.client.get(`${base()}/${chezEux}`),
        await alice.client.patch(`${base()}/${chezEux}`, { title: 'Pirate' }),
        await alice.client.delete(`${base()}/${chezEux}`),
        await bob.client.patch(`${base()}/${chezEux}`, { title: 'Pirate' }),
      ]) {
        expect(r.statut).toBe(404);
        expect(r.corps).toEqual({ error: 'evenement.introuvable' });
      }
      expect(ligneEvenement(chezEux)['title']).toBe('Chez les voisins');
      // Et les deux codes séparément : mon groupe, pas le droit → 403 ; pas mon groupe → 404 (ci-dessus).
      const miens = await creer(alice);
      const r = await bob.client.delete(`${base()}/${miens}`);
      expect(r.statut).toBe(403);
      expect(r.corps).toEqual({ error: 'droit.organisateur_requis' });
    });

    it('modifie des champs, ni plus ni moins, et rafraîchit updated_at', async () => {
      const id = await creer(alice, { description: 'Avant', location_name: 'Parc' });
      const avant = ligneEvenement(id);
      d.temps.avancer(60_000);
      const r = await alice.client.patch(`${base()}/${id}`, { description: null, capacity: 8, ends_at: '2027-03-20T22:00:00Z' });
      expect(r.statut).toBe(200);
      expect(r.corps).toMatchObject({ title: 'Barbecue', description: null, location_name: 'Parc', capacity: 8, ends_at: '2027-03-20T22:00:00Z' });
      expect(ligneEvenement(id)['created_at']).toBe(avant['created_at']);
    });

    it('juge l’horaire sur l’événement fusionné (400, pas 500)', async () => {
      const id = await creer(alice, { ends_at: '2027-03-20T20:00:00Z' });
      const url = `${base()}/${id}`;
      // Début après la fin existante.
      expect((await alice.client.patch(url, { starts_at: '2027-03-20T21:00:00Z' })).corps).toEqual({ error: 'requete.invalide', champs: ['ends_at'] });
      // Journée entière sans nouvelle date.
      expect((await alice.client.patch(url, { all_day: true })).corps).toEqual({ error: 'requete.invalide', champs: ['starts_at'] });
      // Journée entière avec ses dates : acceptée.
      expect((await alice.client.patch(url, { all_day: true, starts_at: '2027-03-20', ends_at: null })).statut).toBe(200);
      expect(ligneEvenement(id)).toMatchObject({ all_day: 1, starts_at: '2027-03-20', ends_at: null });
    });

    it.each([[{}], [{ status: 'published' }], [{ recurrence_rule: 'FREQ=DAILY' }], [{ time_zone: 'Nulle/Part' }], [{ title: '' }]])('refuse le corps %j (400)', async (corps) => {
      const id = await creer(alice);
      const r = await alice.client.patch(`${base()}/${id}`, corps);
      expect(r.statut).toBe(400);
    });

    it('DELETE annule : le statut change, la ligne reste, l’événement reste lisible, et c’est idempotent', async () => {
      const id = await creer(alice);
      const r = await alice.client.delete(`${base()}/${id}`);
      expect(r.statut).toBe(200);
      expect(r.corps).toMatchObject({ id, status: 'cancelled' });
      expect(ligneEvenement(id)).toMatchObject({ status: 'cancelled', deleted_at: null });
      expect((await bob.client.get(`${base()}/${id}`)).corps).toMatchObject({ status: 'cancelled', title: 'Barbecue' });
      expect((await alice.client.delete(`${base()}/${id}`)).statut).toBe(200);
      expect(d.sql.prepare('SELECT count(*) FROM events').pluck().get()).toBe(1);
    });

    it('un simple membre ne peut pas annuler (403) et l’événement reste publié', async () => {
      const id = await creer(alice);
      expect((await bob.client.delete(`${base()}/${id}`)).statut).toBe(403);
      expect(ligneEvenement(id)['status']).toBe('published');
    });
  });

  describe('ma présence', () => {
    it('pose, change et relit ma réponse ; la première réponse fixe responded_at', async () => {
      const id = await creer(alice);
      const url = `${base()}/${id}/ma-presence`;
      const un = await bob.client.put(url, { status: 'yes', guests_count: 2, comment: 'On apporte un dessert' });
      expect(un.statut).toBe(200);
      expect(un.corps['ma_presence']).toMatchObject({ status: 'yes', guests_count: 2, comment: 'On apporte un dessert' });
      const premiere = (un.corps['ma_presence'] as { responded_at: string }).responded_at;
      d.temps.avancer(3_600_000);
      const deux = await bob.client.put(url, { status: 'maybe' });
      expect(deux.corps['ma_presence']).toMatchObject({ status: 'maybe', guests_count: 0, comment: null, responded_at: premiere });
      expect(d.sql.prepare('SELECT count(*) FROM event_attendances WHERE event_id = ?').pluck().get(id)).toBe(1);
      expect((await bob.client.get(`${base()}/${id}`)).corps['ma_presence']).toMatchObject({ status: 'maybe' });
      expect((await alice.client.get(`${base()}/${id}`)).corps['ma_presence']).toBeNull();
    });

    it('on ne répond que pour soi : un identifiant de membre dans le corps est refusé', async () => {
      const id = await creer(alice);
      const r = await bob.client.put(`${base()}/${id}/ma-presence`, { status: 'yes', membership_id: membreDe(g, carole) });
      expect(r.statut).toBe(400);
      expect(d.sql.prepare('SELECT count(*) FROM event_attendances').pluck().get()).toBe(0);
    });

    it('un événement annulé refuse la réponse (409 evenement.annule) mais reste lisible', async () => {
      const id = await creer(alice);
      await alice.client.delete(`${base()}/${id}`);
      const r = await bob.client.put(`${base()}/${id}/ma-presence`, { status: 'yes' });
      expect(r.statut).toBe(409);
      expect(r.corps).toEqual({ error: 'evenement.annule' });
      expect(d.sql.prepare('SELECT count(*) FROM event_attendances').pluck().get()).toBe(0);
      expect((await bob.client.get(`${base()}/${id}`)).statut).toBe(200);
    });

    it.each([
      [{ status: 'peut-etre' }],
      [{ status: 'yes', guests_count: 21 }],
      [{ status: 'yes', guests_count: -1 }],
      [{ status: 'yes', guests_count: 1.5 }],
      [{ status: 'no', guests_count: 1 }],
      [{ status: 'yes', comment: 'x'.repeat(501) }],
      [{}],
    ])('refuse la réponse %j (400)', async (corps) => {
      const id = await creer(alice);
      expect((await bob.client.put(`${base()}/${id}/ma-presence`, corps)).statut).toBe(400);
    });

    it('la capacité est informative : un « oui » au-delà ne bloque pas', async () => {
      const id = await creer(alice, { capacity: 1 });
      expect((await bob.client.put(`${base()}/${id}/ma-presence`, { status: 'yes', guests_count: 3 })).statut).toBe(200);
      expect((await carole.client.put(`${base()}/${id}/ma-presence`, { status: 'yes' })).statut).toBe(200);
    });

    it('un événement d’un autre groupe : 404, aucune ligne de présence', async () => {
      const chezEux = await creer(erik, {}, autre);
      const r = await bob.client.put(`${base()}/${chezEux}/ma-presence`, { status: 'yes' });
      expect(r.statut).toBe(404);
      expect(r.corps).toEqual({ error: 'evenement.introuvable' });
      expect(d.sql.prepare('SELECT count(*) FROM event_attendances').pluck().get()).toBe(0);
    });
  });

  describe('réponses et compteurs', () => {
    it('trois comptes répondent : les compteurs sont justes (oui, peut-être, non, attendus, sans réponse)', async () => {
      const id = await creer(alice);
      const url = `${base()}/${id}`;
      expect((await bob.client.put(`${url}/ma-presence`, { status: 'yes', guests_count: 2 })).statut).toBe(200);
      expect((await carole.client.put(`${url}/ma-presence`, { status: 'maybe', guests_count: 4, comment: 'Selon le boulot' })).statut).toBe(200);
      expect((await dave.client.put(`${url}/ma-presence`, { status: 'no' })).statut).toBe(200);
      const r = await alice.client.get(`${url}/presences`);
      expect(r.statut).toBe(200);
      // Attendus : 1 « oui » + ses 2 invités = 3. Les invités d’un « peut-être » ne comptent pas.
      expect(r.corps['compteurs']).toEqual({ yes: 1, maybe: 1, no: 1, attendus: 3, sans_reponse: 1 });
      const reponses = r.corps['reponses'] as Array<{ membership_id: string; status: string; guests_count: number; comment: string | null }>;
      expect(reponses.map((x) => [x.membership_id, x.status, x.guests_count, x.comment])).toEqual(
        expect.arrayContaining([
          [membreDe(g, bob), 'yes', 2, null],
          [membreDe(g, carole), 'maybe', 4, 'Selon le boulot'],
          [membreDe(g, dave), 'no', 0, null],
        ]),
      );
      expect(reponses).toHaveLength(3);
      expect((r.corps['sans_reponse'] as Array<{ membership_id: string }>).map((x) => x.membership_id)).toEqual([membreDe(g, alice)]);
    });

    it('sans aucune réponse : tout à zéro, tous les membres sont à relancer', async () => {
      const id = await creer(alice);
      const r = await bob.client.get(`${base()}/${id}/presences`);
      expect(r.corps['compteurs']).toEqual({ yes: 0, maybe: 0, no: 0, attendus: 0, sans_reponse: 4 });
      expect(r.corps['reponses']).toEqual([]);
    });

    it('un changement de réponse déplace le compteur ; un membre retiré n’est plus attendu', async () => {
      const id = await creer(alice);
      const url = `${base()}/${id}`;
      await bob.client.put(`${url}/ma-presence`, { status: 'yes', guests_count: 1 });
      await carole.client.put(`${url}/ma-presence`, { status: 'yes' });
      expect((await alice.client.get(`${url}/presences`)).corps['compteurs']).toMatchObject({ yes: 2, attendus: 3 });
      await bob.client.put(`${url}/ma-presence`, { status: 'no' });
      expect((await alice.client.get(`${url}/presences`)).corps['compteurs']).toMatchObject({ yes: 1, no: 1, attendus: 1 });
      await carole.client.put(`${url}/ma-presence`, { status: 'yes', guests_count: 3 });
      d.sql.prepare("UPDATE memberships SET status = 'removed', ended_at = ? WHERE id = ?").run('2026-11-16T00:00:00Z', membreDe(g, carole));
      const r = await alice.client.get(`${url}/presences`);
      expect(r.corps['compteurs']).toEqual({ yes: 0, maybe: 0, no: 1, attendus: 0, sans_reponse: 2 });
    });

    it('les compteurs d’un événement ne comptent jamais les réponses d’un autre (même groupe ou autre groupe)', async () => {
      const un = await creer(alice, { title: 'Un' });
      const deux = await creer(alice, { title: 'Deux' });
      const chezEux = await creer(erik, {}, autre);
      await bob.client.put(`${base()}/${un}/ma-presence`, { status: 'yes', guests_count: 5 });
      await erik.client.put(`/api/groupes/${autre.groupId}/evenements/${chezEux}/ma-presence`, { status: 'yes', guests_count: 7 });
      expect((await alice.client.get(`${base()}/${deux}/presences`)).corps['compteurs']).toMatchObject({ yes: 0, attendus: 0 });
      expect((await alice.client.get(`${base()}/${un}/presences`)).corps['compteurs']).toMatchObject({ yes: 1, attendus: 6 });
      const etranger = await alice.client.get(`${base()}/${chezEux}/presences`);
      expect(etranger.statut).toBe(404);
    });
  });

  describe('co-organisateurs', () => {
    it('ajoute (idempotent) et retire ; un simple membre n’en désigne pas (403)', async () => {
      const id = await creer(bob);
      const url = `${base()}/${id}/organisateurs/${membreDe(g, carole)}`;
      expect((await carole.client.post(url)).statut).toBe(403);
      expect((await bob.client.post(url)).statut).toBe(200);
      expect((await bob.client.post(url)).statut).toBe(200);
      expect(d.sql.prepare('SELECT count(*) FROM event_organizers WHERE event_id = ?').pluck().get(id)).toBe(1);
      expect(((await bob.client.get(`${base()}/${id}`)).corps['organisateurs'] as unknown[]).length).toBe(1);
      expect((await bob.client.delete(url)).statut).toBe(200);
      expect((await bob.client.delete(url)).statut).toBe(200);
      expect(d.sql.prepare('SELECT count(*) FROM event_organizers WHERE event_id = ?').pluck().get(id)).toBe(0);
      expect((await carole.client.patch(`${base()}/${id}`, { title: 'Plus de droit' })).statut).toBe(403);
    });

    it('un membre d’un autre groupe ne devient pas organisateur : 404 membre.introuvable, aucune ligne', async () => {
      const id = await creer(alice);
      const etranger = membreDe(autre, erik);
      for (const r of [await alice.client.post(`${base()}/${id}/organisateurs/${etranger}`), await alice.client.delete(`${base()}/${id}/organisateurs/${etranger}`)]) {
        expect(r.statut).toBe(404);
        expect(r.corps).toEqual({ error: 'membre.introuvable' });
      }
      expect(d.sql.prepare('SELECT count(*) FROM event_organizers').pluck().get()).toBe(0);
    });

    it('et l’inverse : un membre de A sur un événement de B est un 404 de l’événement', async () => {
      const chezEux = await creer(erik, {}, autre);
      const r = await alice.client.post(`${base()}/${chezEux}/organisateurs/${membreDe(g, bob)}`);
      expect(r.statut).toBe(404);
      expect(r.corps).toEqual({ error: 'evenement.introuvable' });
      expect(d.sql.prepare('SELECT count(*) FROM event_organizers').pluck().get()).toBe(0);
    });

    it('la clé étrangère composite refuse elle aussi l’écriture croisée (verrou n° 4), même sans passer par l’API', async () => {
      const id = await creer(alice);
      const croise = (): void => {
        d.sql
          .prepare('INSERT INTO event_organizers (event_id, group_id, membership_id, added_at) VALUES (?, ?, ?, ?)')
          .run(id, g.groupId, membreDe(autre, erik), '2026-11-16T00:00:00Z');
      };
      expect(croise).toThrow(/FOREIGN KEY/);
      const autreGroupe = (): void => {
        d.sql
          .prepare('INSERT INTO event_organizers (event_id, group_id, membership_id, added_at) VALUES (?, ?, ?, ?)')
          .run(id, autre.groupId, membreDe(autre, erik), '2026-11-16T00:00:00Z');
      };
      expect(autreGroupe).toThrow(/FOREIGN KEY/);
    });

    it('un ancien membre ne peut pas être désigné (409)', async () => {
      const id = await creer(alice);
      d.sql.prepare("UPDATE memberships SET status = 'removed', ended_at = ? WHERE id = ?").run('2026-11-16T00:00:00Z', membreDe(g, dave));
      const r = await alice.client.post(`${base()}/${id}/organisateurs/${membreDe(g, dave)}`);
      expect(r.statut).toBe(409);
      expect(r.corps).toEqual({ error: 'membre.inactif' });
    });
  });

  describe('peutModifierEvenement', () => {
    it('vrai pour l’auteur, un co-organisateur, un administrateur ; faux pour un simple membre', async () => {
      const id = await creer(bob);
      await bob.client.post(`${base()}/${id}/organisateurs/${membreDe(g, carole)}`);
      const droit = (p: Personne): boolean => {
        const scope = creerScope(d.base, p.userId, g.groupId);
        const evenement = lireEvenement(scope, id);
        if (evenement === undefined) throw new Error('événement introuvable');
        return peutModifierEvenement(scope, evenement);
      };
      expect({ auteur: droit(bob), coOrganisatrice: droit(carole), admin: droit(alice), simpleMembre: droit(dave) }).toEqual({
        auteur: true,
        coOrganisatrice: true,
        admin: true,
        simpleMembre: false,
      });
    });

    it('le co-organisat­eur d’un événement n’a aucun droit sur un autre événement du même groupe', async () => {
      const un = await creer(alice, { title: 'Un' });
      const deux = await creer(alice, { title: 'Deux' });
      await alice.client.post(`${base()}/${un}/organisateurs/${membreDe(g, carole)}`);
      expect((await carole.client.patch(`${base()}/${un}`, { title: 'Un bis' })).statut).toBe(200);
      const r = await carole.client.patch(`${base()}/${deux}`, { title: 'Deux bis' });
      expect(r.statut).toBe(403);
    });
  });
});
