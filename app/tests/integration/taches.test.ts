import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { courses, type Courses } from '../fixtures/courses.js';

// Tâches d'événement (lot 6) : le « qui apporte quoi ». Le cloisonnement route par route est dans tests/cloisonnement (suite
// générique) ; ici, les règles propres aux tâches : statut et `done_at`, rattachement, assignation et son droit (403 contre 404).
describe('tâches d’événement', () => {
  let c: Courses;
  beforeEach(async () => {
    c = await courses('ta');
  });
  afterEach(() => c.d.nettoyer());

  const creer = async (auteur = c.alice, corps: Record<string, unknown> = {}): Promise<string> => {
    const r = await auteur.client.post(c.chemin('/taches'), { title: 'Apporter la glace', ...corps });
    expect(r.statut, JSON.stringify(r.corps)).toBe(201);
    return r.corps['id'] as string;
  };
  const ligne = (id: string): Record<string, unknown> => c.d.sql.prepare('SELECT * FROM event_tasks WHERE id = ?').get(id) as Record<string, unknown>;
  const assigner = (qui: typeof c.alice, tache: string, cible: string | null): ReturnType<typeof c.alice.client.put> =>
    qui.client.put(c.chemin(`/taches/${tache}/assignation`), { assignee_membership_id: cible });
  const membreDeB = (): string => c.d.sql.prepare('SELECT id FROM memberships WHERE group_id = ?').pluck().get(c.b.groupId) as string;

  describe('création et lecture', () => {
    it('crée une tâche libre, `todo`, auteur = la session ; la liste suit l’ordre de création', async () => {
      const r = await c.carole.client.post(c.chemin('/taches'), { title: '  Apporter la glace ', details: 'Deux sacs', due_at: '2027-03-20T16:00:00Z' });
      expect(r.statut, JSON.stringify(r.corps)).toBe(201);
      expect(r.corps).toMatchObject({
        title: 'Apporter la glace',
        details: 'Deux sacs',
        due_at: '2027-03-20T16:00:00Z',
        status: 'todo',
        done_at: null,
        event_id: null,
        assignee_membership_id: null,
        assignee_name: null,
        created_by_membership_id: c.membreA(c.carole),
      });
      await creer(c.alice, { title: 'Le pain' });
      const liste = (await c.erin.client.get(c.chemin('/taches'))).corps['taches'] as Array<Record<string, unknown>>;
      expect(liste.map((t) => t['title'])).toEqual(['Apporter la glace', 'Le pain']);
    });

    it('rattache la tâche à un événement ; le filtre `event_id` ne rend que celles-là', async () => {
      const soiree = await c.creerEvenement(c.alice, 'Soirée');
      const autre = await c.creerEvenement(c.alice, 'Autre');
      const t1 = await creer(c.alice, { title: 'Pour la soirée', event_id: soiree });
      await creer(c.alice, { title: 'Pour l’autre', event_id: autre });
      await creer(c.alice, { title: 'Sans événement' });
      const filtrees = (await c.carole.client.get(c.chemin(`/taches?event_id=${soiree}`))).corps['taches'] as Array<Record<string, unknown>>;
      expect(filtrees.map((t) => t['id'])).toEqual([t1]);
      expect((await c.carole.client.get(c.chemin('/taches'))).corps['taches']).toHaveLength(3);
    });

    it('un événement d’un autre groupe est introuvable (création, modification, filtre) : 404, rien n’est écrit', async () => {
      const chezBob = (await c.bob.client.post(`/api/groupes/${c.b.groupId}/evenements`, { title: 'Chez Bob', starts_at: '2027-03-20T18:00:00Z', time_zone: 'Europe/Paris' })).corps['id'] as string;
      const mienne = await creer();
      for (const r of [
        await c.alice.client.post(c.chemin('/taches'), { title: 'Pirate', event_id: chezBob }),
        await c.alice.client.patch(c.chemin(`/taches/${mienne}`), { event_id: chezBob }),
        await c.alice.client.get(c.chemin(`/taches?event_id=${chezBob}`)),
      ]) {
        expect(r.statut).toBe(404);
        expect(r.corps).toEqual({ error: 'evenement.introuvable' });
      }
      expect(ligne(mienne)['event_id']).toBeNull();
      expect(c.d.sql.prepare("SELECT count(*) FROM event_tasks WHERE title = 'Pirate'").pluck().get()).toBe(0);
    });

    it('400 : titre, échéance impossible, statut inconnu, `done_at` forcé, champ inconnu — jamais une erreur SQLite', async () => {
      const id = await creer();
      for (const corps of [{ title: '' }, { title: 'x'.repeat(141) }, { title: 'ok', due_at: '2027-02-31T10:00:00Z' }, { title: 'ok', due_at: 'demain' }, { title: 'ok', status: 'done' }, { title: 'ok', assignee_membership_id: c.membreA(c.carole) }, { title: 'ok', done_at: '2027-01-01T00:00:00Z' }]) {
        expect((await c.alice.client.post(c.chemin('/taches'), corps)).statut, JSON.stringify(corps)).toBe(400);
      }
      for (const corps of [{}, { status: 'fini' }, { done_at: '2027-01-01T00:00:00Z' }, { position: 3 }, { created_by_membership_id: 'x' }, { assignee_membership_id: c.membreA(c.carole) }]) {
        expect((await c.alice.client.patch(c.chemin(`/taches/${id}`), corps)).statut, JSON.stringify(corps)).toBe(400);
      }
    });
  });

  describe('statut', () => {
    it('`done_at` suit `status` : posé en passant à `done`, conservé si on y reste, effacé en le quittant', async () => {
      const id = await creer();
      const chemin = c.chemin(`/taches/${id}`);
      expect((await c.carole.client.patch(chemin, { status: 'doing' })).corps).toMatchObject({ status: 'doing', done_at: null });
      const fait = await c.carole.client.patch(chemin, { status: 'done' });
      expect(fait.corps).toMatchObject({ status: 'done', done_at: '2026-11-15T12:00:00Z' });
      c.d.temps.avancer(3_600_000);
      expect((await c.erin.client.patch(chemin, { status: 'done', title: 'Renommée' })).corps).toMatchObject({ status: 'done', done_at: '2026-11-15T12:00:00Z', title: 'Renommée' });
      expect((await c.erin.client.patch(chemin, { status: 'dropped' })).corps).toMatchObject({ status: 'dropped', done_at: null });
      expect(ligne(id)).toMatchObject({ status: 'dropped', done_at: null });
    });

    it('modifier sans toucher au statut ne touche pas `done_at`', async () => {
      const id = await creer();
      await c.alice.client.patch(c.chemin(`/taches/${id}`), { status: 'done' });
      const r = await c.alice.client.patch(c.chemin(`/taches/${id}`), { details: 'Précision' });
      expect(r.corps).toMatchObject({ status: 'done', done_at: '2026-11-15T12:00:00Z', details: 'Précision' });
    });

    it('supprime (suppression logique) : la tâche disparaît des listes et des routes', async () => {
      const id = await creer();
      expect((await c.erin.client.delete(c.chemin(`/taches/${id}`))).statut).toBe(200);
      expect(ligne(id)['deleted_at']).not.toBeNull();
      expect((await c.alice.client.get(c.chemin('/taches'))).corps['taches']).toEqual([]);
      for (const r of [await c.alice.client.patch(c.chemin(`/taches/${id}`), { title: 'x' }), await c.alice.client.delete(c.chemin(`/taches/${id}`)), await assigner(c.alice, id, null)]) {
        expect(r.statut).toBe(404);
        expect(r.corps).toEqual({ error: 'tache.introuvable' });
      }
    });
  });

  describe('assignation', () => {
    it('« je m’en occupe » : tout membre prend une tâche libre, et son nom s’affiche', async () => {
      const id = await creer();
      const r = await assigner(c.carole, id, c.membreA(c.carole));
      expect(r.statut, JSON.stringify(r.corps)).toBe(200);
      expect(r.corps).toMatchObject({ assignee_membership_id: c.membreA(c.carole), assignee_name: c.nom(c.carole) });
    });

    it('« désigner quelqu’un » : sur une tâche libre, n’importe quel membre désigne n’importe quel membre actif', async () => {
      const id = await creer();
      const r = await assigner(c.erin, id, c.membreA(c.carole));
      expect(r.statut).toBe(200);
      expect(r.corps['assignee_membership_id']).toBe(c.membreA(c.carole));
    });

    it('libérer : `null` (par l’auteur de la tâche)', async () => {
      const id = await creer(c.carole);
      await assigner(c.carole, id, c.membreA(c.erin));
      const r = await assigner(c.carole, id, null);
      expect(r.statut).toBe(200);
      expect(r.corps).toMatchObject({ assignee_membership_id: null, assignee_name: null });
    });

    it('la tâche de quelqu’un d’autre ne se prend pas : 403 `droit.assignation_requise` pour un simple membre (ni assigné ni auteur)', async () => {
      const id = await creer(c.alice); // auteure : Alice
      await assigner(c.alice, id, c.membreA(c.carole)); // assignée : Carole
      // Erin : ni l'assignée ni l'auteure, simple membre. Ni se l'attribuer, ni la désigner à un autre, ni la libérer.
      for (const cible of [c.membreA(c.erin), c.membreA(c.alice), null]) {
        const r = await assigner(c.erin, id, cible);
        expect(r.statut, String(cible)).toBe(403);
        expect(r.corps).toEqual({ error: 'droit.assignation_requise' });
      }
      expect(ligne(id)['assignee_membership_id']).toBe(c.membreA(c.carole));
    });

    it('en revanche l’assigné passe la main, l’auteur et l’administratrice réassignent', async () => {
      const id = await creer(c.carole); // auteure : Carole (simple membre)
      await assigner(c.carole, id, c.membreA(c.erin));
      // L'assigné (Erin) passe la main à Carole.
      expect((await assigner(c.erin, id, c.membreA(c.carole))).statut).toBe(200);
      // Carole est assignée ET auteure ; Alice (administratrice, ni l'une ni l'autre) reprend la main.
      expect((await assigner(c.alice, id, c.membreA(c.erin))).statut).toBe(200);
      // L'auteure (Carole), qui n'est plus assignée, réassigne.
      expect((await assigner(c.carole, id, c.membreA(c.alice))).statut).toBe(200);
      expect(ligne(id)['assignee_membership_id']).toBe(c.membreA(c.alice));
    });

    it('le droit se juge APRÈS le 404 de la tâche et AVANT la cible', async () => {
      const id = await creer(c.alice);
      await assigner(c.alice, id, c.membreA(c.carole));
      // Tâche inexistante : 404, même pour quelqu'un qui n'aurait pas le droit.
      expect((await assigner(c.erin, 'inexistante', c.membreA(c.erin))).corps).toEqual({ error: 'tache.introuvable' });
      // Tâche d'autrui + cible d'un autre groupe : le droit est jugé d'abord (403), la cible n'est jamais consultée.
      expect((await assigner(c.erin, id, membreDeB())).corps).toEqual({ error: 'droit.assignation_requise' });
    });

    it('un membre d’un AUTRE groupe ne s’assigne pas : 404 `membre.introuvable`, jamais une erreur SQLite, rien d’écrit', async () => {
      const id = await creer();
      for (const qui of [c.alice, c.erin]) {
        const r = await assigner(qui, id, membreDeB());
        expect(r.statut).toBe(404);
        expect(r.corps).toEqual({ error: 'membre.introuvable' });
      }
      expect(ligne(id)['assignee_membership_id']).toBeNull();
      // La clé étrangère composite refuserait de toute façon (verrou n° 4) : constaté directement, hors API.
      expect(() => c.d.sql.prepare('UPDATE event_tasks SET assignee_membership_id = ? WHERE id = ?').run(membreDeB(), id)).toThrow(/FOREIGN KEY/);
    });

    it('un ancien membre ne s’assigne pas (409), un membre inconnu non plus (404)', async () => {
      const id = await creer();
      expect((await c.erin.client.post(c.chemin('/depart'))).statut).toBe(200);
      const parti = await assigner(c.alice, id, c.membreA(c.erin));
      expect(parti.statut).toBe(409);
      expect(parti.corps).toEqual({ error: 'membre.inactif' });
      expect((await assigner(c.alice, id, 'inconnu')).corps).toEqual({ error: 'membre.introuvable' });
      expect(ligne(id)['assignee_membership_id']).toBeNull();
    });

    it('réassigner à la personne déjà assignée est un succès sans changement', async () => {
      const id = await creer();
      await assigner(c.carole, id, c.membreA(c.carole));
      const encore = await assigner(c.erin, id, c.membreA(c.carole)); // même cible : rien à écrire, donc rien à refuser
      expect(encore.statut).toBe(200);
    });

    it('seul `assignee_membership_id` est lu dans le corps (null admis) : le reste est refusé', async () => {
      const id = await creer();
      for (const corps of [{}, { assignee_membership_id: 12 }, { assignee_membership_id: c.membreA(c.carole), status: 'done' }, { membership_id: c.membreA(c.carole) }]) {
        expect((await c.alice.client.put(c.chemin(`/taches/${id}/assignation`), corps)).statut, JSON.stringify(corps)).toBe(400);
      }
    });
  });
});
