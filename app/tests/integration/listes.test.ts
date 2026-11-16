import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { courses, type Courses } from '../fixtures/courses.js';

// Listes de courses (lot 6) : les routes, leurs invariants et leurs conflits. Le cloisonnement route par route est dans
// tests/cloisonnement (suite générique) ; la concurrence réelle dans listes-concurrence.test.ts ; le flux dans temps-reel.test.ts.
describe('listes de courses', () => {
  let c: Courses;
  beforeEach(async () => {
    c = await courses('li');
  });
  afterEach(() => c.d.nettoyer());

  const articles = async (listeId: string): Promise<Array<Record<string, unknown>>> => {
    const r = await c.alice.client.get(c.chemin(`/listes/${listeId}`));
    expect(r.statut).toBe(200);
    return r.corps['articles'] as Array<Record<string, unknown>>;
  };
  const ordre = async (listeId: string): Promise<string[]> => (await articles(listeId)).map((a) => a['label'] as string);
  const ligneArticle = (id: string): Record<string, unknown> => c.d.sql.prepare('SELECT * FROM shopping_items WHERE id = ?').get(id) as Record<string, unknown>;

  describe('listes', () => {
    it('crée, lit, renomme : tout membre, l’auteur vient de la session', async () => {
      const cree = await c.carole.client.post(c.chemin('/listes'), { title: '  Courses du samedi  ' });
      expect(cree.statut, JSON.stringify(cree.corps)).toBe(201);
      expect(cree.corps).toMatchObject({ title: 'Courses du samedi', event_id: null, articles: [], created_by_membership_id: c.membreA(c.carole) });
      const id = cree.corps['id'] as string;
      const renomme = await c.erin.client.patch(c.chemin(`/listes/${id}`), { title: 'Courses du dimanche' });
      expect(renomme.statut).toBe(200);
      expect(renomme.corps['title']).toBe('Courses du dimanche');
      expect((await c.alice.client.get(c.chemin(`/listes/${id}`))).corps['title']).toBe('Courses du dimanche');
    });

    it('la liste des listes porte les compteurs, et se filtre par événement', async () => {
      const soiree = await c.creerEvenement(c.alice, 'Soirée');
      const autreSoiree = await c.creerEvenement(c.alice, 'Autre soirée');
      const rattachee = await c.creerListe(c.alice, 'Pour la soirée', soiree);
      const libre = await c.creerListe(c.alice, 'Sans événement');
      const [pain, vin] = await c.ajouter(c.alice, rattachee, 'Pain', 'Vin');
      await c.ajouter(c.alice, libre, 'Sel');
      expect((await c.alice.client.put(c.chemin(`/listes/${rattachee}/articles/${pain ?? ''}/fait`), { fait: true })).statut).toBe(200);
      expect(vin).toBeDefined();

      const toutes = (await c.alice.client.get(c.chemin('/listes'))).corps['listes'] as Array<Record<string, unknown>>;
      expect(toutes.map((l) => l['title'])).toEqual(['Pour la soirée', 'Sans événement']);
      expect(toutes[0]).toMatchObject({ articles_total: 2, articles_faits: 1 });
      expect(toutes[1]).toMatchObject({ articles_total: 1, articles_faits: 0 });

      const filtrees = (await c.alice.client.get(c.chemin(`/listes?event_id=${soiree}`))).corps['listes'] as Array<Record<string, unknown>>;
      expect(filtrees.map((l) => l['id'])).toEqual([rattachee]);
      const vide = (await c.alice.client.get(c.chemin(`/listes?event_id=${autreSoiree}`))).corps['listes'] as unknown[];
      expect(vide).toEqual([]);
    });

    it('un événement d’un autre groupe est introuvable (filtre comme rattachement), pas ignoré', async () => {
      const chezBob = (await c.bob.client.post(`/api/groupes/${c.b.groupId}/evenements`, { title: 'Chez Bob', starts_at: '2027-03-20T18:00:00Z', time_zone: 'Europe/Paris' })).corps['id'] as string;
      for (const r of [
        await c.alice.client.get(c.chemin(`/listes?event_id=${chezBob}`)),
        await c.alice.client.post(c.chemin('/listes'), { title: 'Pirate', event_id: chezBob }),
      ]) {
        expect(r.statut).toBe(404);
        expect(r.corps).toEqual({ error: 'evenement.introuvable' });
      }
      expect(c.d.sql.prepare("SELECT count(*) FROM shopping_lists WHERE title = 'Pirate'").pluck().get()).toBe(0);
    });

    it('titre vide, trop long, champ inconnu : 400 en nommant le champ, jamais une erreur SQLite', async () => {
      for (const corps of [{ title: '' }, { title: '   ' }, { title: 'x'.repeat(121) }, { title: 'ok', category: 'fruits' }, { title: 'ok', created_by_membership_id: 'x' }, {}]) {
        const r = await c.alice.client.post(c.chemin('/listes'), corps);
        expect(r.statut, JSON.stringify(corps)).toBe(400);
        expect(r.corps['error']).toBe('requete.invalide');
      }
    });

    it('supprimer une liste : suppression logique, et ses articles disparaissent avec elle (cascade logique)', async () => {
      const liste = await c.creerListe(c.alice);
      const [pain, vin] = await c.ajouter(c.alice, liste, 'Pain', 'Vin');
      const hors = await c.creerListe(c.alice, 'Une autre');
      const [sel] = await c.ajouter(c.alice, hors, 'Sel');

      const r = await c.erin.client.delete(c.chemin(`/listes/${liste}`));
      expect(r.statut).toBe(200);

      // La ligne existe encore (suppression logique), ainsi que celles de ses articles.
      expect(c.d.sql.prepare('SELECT deleted_at FROM shopping_lists WHERE id = ?').pluck().get(liste)).not.toBeNull();
      for (const id of [pain, vin]) expect(ligneArticle(id ?? '')['deleted_at']).not.toBeNull();
      // Invisible partout : détail, liste des listes, compteurs, et chaque route d'article.
      expect((await c.alice.client.get(c.chemin(`/listes/${liste}`))).statut).toBe(404);
      const restantes = (await c.alice.client.get(c.chemin('/listes'))).corps['listes'] as Array<Record<string, unknown>>;
      expect(restantes.map((l) => l['id'])).toEqual([hors]);
      expect(restantes[0]).toMatchObject({ articles_total: 1 });
      for (const r2 of [
        await c.alice.client.put(c.chemin(`/listes/${liste}/articles/${pain ?? ''}/fait`), { fait: true }),
        await c.alice.client.put(c.chemin(`/listes/${liste}/articles/${pain ?? ''}/preneur`), { prend: true }),
        await c.alice.client.patch(c.chemin(`/listes/${liste}/articles/${pain ?? ''}`), { label: 'x' }),
        await c.alice.client.delete(c.chemin(`/listes/${liste}/articles/${pain ?? ''}`)),
        await c.alice.client.post(c.chemin(`/listes/${liste}/articles`), { label: 'x' }),
        await c.alice.client.delete(c.chemin(`/listes/${liste}`)),
      ]) {
        expect(r2.statut).toBe(404);
      }
      // La liste voisine n'a pas bougé.
      expect(await ordre(hors)).toEqual(['Sel']);
      expect(sel).toBeDefined();
    });
  });

  describe('articles', () => {
    it('ajoute en fin de liste, avec la quantité ; rien de réservé n’est exposé', async () => {
      const liste = await c.creerListe(c.alice);
      const premier = await c.carole.client.post(c.chemin(`/listes/${liste}/articles`), { label: '  Pain  ', quantity: '2 baguettes' });
      expect(premier.statut, JSON.stringify(premier.corps)).toBe(201);
      expect(premier.corps).toMatchObject({
        label: 'Pain',
        quantity: '2 baguettes',
        is_done: false,
        done_at: null,
        claimed_by_membership_id: null,
        claimed_by_name: null,
        claimed_at: null,
        shopping_list_id: liste,
        created_by_membership_id: c.membreA(c.carole),
      });
      expect(premier.corps).not.toHaveProperty('category');
      expect(premier.corps).not.toHaveProperty('deleted_at');
      await c.ajouter(c.alice, liste, 'Vin', 'Sel');
      expect(await ordre(liste)).toEqual(['Pain', 'Vin', 'Sel']);
    });

    it('une liste est plafonnée à 500 articles : 409 `liste.pleine`, rien d’écrit ; en retirer un libère une place', async () => {
      const liste = await c.creerListe(c.alice);
      const insertion = c.d.sql.prepare(
        'INSERT INTO shopping_items (id, shopping_list_id, group_id, label, position, created_by_membership_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (let i = 0; i < 500; i++) insertion.run(`art-${String(i)}`, liste, c.a.groupId, `A${String(i)}`, i, c.membreA(c.alice), '2026-11-15T12:00:00Z', '2026-11-15T12:00:00Z');
      const plein = await c.alice.client.post(c.chemin(`/listes/${liste}/articles`), { label: 'De trop' });
      expect(plein.statut).toBe(409);
      expect(plein.corps).toEqual({ error: 'liste.pleine' });
      expect(c.d.sql.prepare('SELECT count(*) FROM shopping_items WHERE shopping_list_id = ?').pluck().get(liste)).toBe(500);
      expect((await c.alice.client.delete(c.chemin(`/listes/${liste}/articles/art-0`))).statut).toBe(200);
      expect((await c.alice.client.post(c.chemin(`/listes/${liste}/articles`), { label: 'Ça passe' })).statut).toBe(201);
    });

    it('`category` est réservé V2 : refusé en entrée, jamais lu en sortie même si la base en contient une', async () => {
      const liste = await c.creerListe(c.alice);
      const [pain] = await c.ajouter(c.alice, liste, 'Pain');
      expect((await c.alice.client.post(c.chemin(`/listes/${liste}/articles`), { label: 'x', category: 'boulangerie' })).statut).toBe(400);
      expect((await c.alice.client.patch(c.chemin(`/listes/${liste}/articles/${pain ?? ''}`), { category: 'boulangerie' })).statut).toBe(400);
      c.d.sql.prepare("UPDATE shopping_items SET category = 'boulangerie' WHERE id = ?").run(pain);
      expect(JSON.stringify((await c.alice.client.get(c.chemin(`/listes/${liste}`))).corps)).not.toContain('boulangerie');
    });

    it('modifie le libellé et la quantité (null efface la quantité)', async () => {
      const liste = await c.creerListe(c.alice);
      const [pain] = await c.ajouter(c.alice, liste, 'Pain');
      const chemin = c.chemin(`/listes/${liste}/articles/${pain ?? ''}`);
      expect((await c.erin.client.patch(chemin, { label: 'Pain complet', quantity: '3' })).corps).toMatchObject({ label: 'Pain complet', quantity: '3' });
      expect((await c.erin.client.patch(chemin, { quantity: null })).corps).toMatchObject({ label: 'Pain complet', quantity: null });
    });

    it('refuse en 400 : libellé vide ou trop long, corps vide, état forcé (fait, preneur, position, auteur)', async () => {
      const liste = await c.creerListe(c.alice);
      const [pain] = await c.ajouter(c.alice, liste, 'Pain');
      const chemin = c.chemin(`/listes/${liste}/articles/${pain ?? ''}`);
      for (const corps of [{ label: '' }, { label: 'x'.repeat(121) }, {}, { is_done: 1 }, { done_at: '2027-01-01T00:00:00Z' }, { claimed_by_membership_id: c.membreA(c.alice) }, { position: 1 }, { created_by_membership_id: 'x' }, { quantity: 'x'.repeat(41) }]) {
        const r = await c.alice.client.patch(chemin, corps);
        expect(r.statut, JSON.stringify(corps)).toBe(400);
      }
      expect((await c.alice.client.post(c.chemin(`/listes/${liste}/articles`), { label: '' })).statut).toBe(400);
      expect((await c.alice.client.post(c.chemin(`/listes/${liste}/articles`), { label: 'x', is_done: true })).statut).toBe(400);
      // Rien n'a bougé : l'article est tel qu'à la création.
      expect(ligneArticle(pain ?? '')).toMatchObject({ label: 'Pain', is_done: 0, done_at: null, claimed_by_membership_id: null });
    });

    it('retire un article (suppression logique) sans toucher aux autres', async () => {
      const liste = await c.creerListe(c.alice);
      const [pain] = await c.ajouter(c.alice, liste, 'Pain', 'Vin');
      expect((await c.erin.client.delete(c.chemin(`/listes/${liste}/articles/${pain ?? ''}`))).statut).toBe(200);
      expect(await ordre(liste)).toEqual(['Vin']);
      expect(ligneArticle(pain ?? '')['deleted_at']).not.toBeNull();
    });

    it('l’article d’une autre liste du MÊME groupe est introuvable par cette liste (404 `article.introuvable`)', async () => {
      const l1 = await c.creerListe(c.alice, 'L1');
      const l2 = await c.creerListe(c.alice, 'L2');
      const [dansL1] = await c.ajouter(c.alice, l1, 'Pain');
      await c.ajouter(c.alice, l2, 'Vin');
      for (const r of [
        await c.alice.client.patch(c.chemin(`/listes/${l2}/articles/${dansL1 ?? ''}`), { label: 'x' }),
        await c.alice.client.delete(c.chemin(`/listes/${l2}/articles/${dansL1 ?? ''}`)),
        await c.alice.client.put(c.chemin(`/listes/${l2}/articles/${dansL1 ?? ''}/fait`), { fait: true }),
        await c.alice.client.put(c.chemin(`/listes/${l2}/articles/${dansL1 ?? ''}/preneur`), { prend: true }),
      ]) {
        expect(r.statut).toBe(404);
        expect(r.corps).toEqual({ error: 'article.introuvable' });
      }
      expect(ligneArticle(dansL1 ?? '')).toMatchObject({ label: 'Pain', is_done: 0, claimed_by_membership_id: null, deleted_at: null });
    });
  });

  describe('preneur', () => {
    it('« je le prends » pose MON appartenance et le nom ; « finalement non » la retire (les deux colonnes ensemble)', async () => {
      const liste = await c.creerListe(c.alice);
      const [pain] = await c.ajouter(c.alice, liste, 'Pain');
      const chemin = c.chemin(`/listes/${liste}/articles/${pain ?? ''}/preneur`);
      const pris = await c.carole.client.put(chemin, { prend: true });
      expect(pris.statut, JSON.stringify(pris.corps)).toBe(200);
      expect(pris.corps).toMatchObject({ claimed_by_membership_id: c.membreA(c.carole), claimed_by_name: c.nom(c.carole) });
      expect(pris.corps['claimed_at']).toEqual(expect.any(String));
      const libere = await c.carole.client.put(chemin, { prend: false });
      expect(libere.corps).toMatchObject({ claimed_by_membership_id: null, claimed_by_name: null, claimed_at: null });
      expect(ligneArticle(pain ?? '')).toMatchObject({ claimed_by_membership_id: null, claimed_at: null });
    });

    it('le second preneur reçoit un 409 qui NOMME le premier ; l’article reste au premier', async () => {
      const liste = await c.creerListe(c.alice);
      const [pain] = await c.ajouter(c.alice, liste, 'Pain');
      const chemin = c.chemin(`/listes/${liste}/articles/${pain ?? ''}/preneur`);
      expect((await c.carole.client.put(chemin, { prend: true })).statut).toBe(200);
      const second = await c.erin.client.put(chemin, { prend: true });
      expect(second.statut).toBe(409);
      expect(second.corps).toEqual({ error: 'article.deja_pris', pris_par: { membership_id: c.membreA(c.carole), display_name: c.nom(c.carole) } });
      expect(ligneArticle(pain ?? '')['claimed_by_membership_id']).toBe(c.membreA(c.carole));
    });

    it('on ne retire que son PROPRE marquage : 409 sinon, y compris pour une administratrice', async () => {
      const liste = await c.creerListe(c.alice);
      const [pain] = await c.ajouter(c.alice, liste, 'Pain');
      const chemin = c.chemin(`/listes/${liste}/articles/${pain ?? ''}/preneur`);
      await c.carole.client.put(chemin, { prend: true });
      for (const intrus of [c.erin, c.alice]) {
        const r = await intrus.client.put(chemin, { prend: false });
        expect(r.statut).toBe(409);
        expect(r.corps).toMatchObject({ error: 'article.pas_le_votre', pris_par: { membership_id: c.membreA(c.carole) } });
      }
      expect(ligneArticle(pain ?? '')['claimed_by_membership_id']).toBe(c.membreA(c.carole));
    });

    it('refaire ce qui est fait est un succès sans changement (je le prends deux fois ; je le lâche alors qu’il est libre)', async () => {
      const liste = await c.creerListe(c.alice);
      const [pain] = await c.ajouter(c.alice, liste, 'Pain');
      const chemin = c.chemin(`/listes/${liste}/articles/${pain ?? ''}/preneur`);
      expect((await c.carole.client.put(chemin, { prend: false })).statut).toBe(200);
      const premier = await c.carole.client.put(chemin, { prend: true });
      const date = premier.corps['claimed_at'];
      c.d.temps.avancer(60_000);
      const deuxieme = await c.carole.client.put(chemin, { prend: true });
      expect(deuxieme.statut).toBe(200);
      expect(deuxieme.corps['claimed_at'], 'la date de la prise ne bouge pas').toBe(date);
    });

    it('le corps ne désigne jamais quelqu’un d’autre : `prend` seul, champ inconnu refusé', async () => {
      const liste = await c.creerListe(c.alice);
      const [pain] = await c.ajouter(c.alice, liste, 'Pain');
      const chemin = c.chemin(`/listes/${liste}/articles/${pain ?? ''}/preneur`);
      for (const corps of [{}, { prend: 'oui' }, { prend: true, membership_id: c.membreA(c.erin) }, { prend: true, claimed_by_membership_id: c.membreA(c.erin) }]) {
        expect((await c.carole.client.put(chemin, corps)).statut, JSON.stringify(corps)).toBe(400);
      }
      expect(ligneArticle(pain ?? '')['claimed_by_membership_id']).toBeNull();
    });

    it('l’article pris par un membre RETIRÉ ou PARTI n’est pas bloqué : un autre membre peut le libérer ou le reprendre', async () => {
      const liste = await c.creerListe(c.alice);
      const [pain, vin] = await c.ajouter(c.alice, liste, 'Pain', 'Vin');
      const chemin = (id: string | undefined): string => c.chemin(`/listes/${liste}/articles/${id ?? ''}/preneur`);
      await c.erin.client.put(chemin(pain), { prend: true });
      await c.erin.client.put(chemin(vin), { prend: true });
      expect((await c.alice.client.delete(c.chemin(`/membres/${c.membreA(c.erin)}`))).statut).toBe(200);
      // Libérer : l'administratrice, puis reprendre : une simple membre.
      const libere = await c.alice.client.put(chemin(pain), { prend: false });
      expect(libere.statut, JSON.stringify(libere.corps)).toBe(200);
      expect(libere.corps).toMatchObject({ claimed_by_membership_id: null, claimed_at: null });
      const repris = await c.carole.client.put(chemin(vin), { prend: true });
      expect(repris.statut, JSON.stringify(repris.corps)).toBe(200);
      expect(repris.corps['claimed_by_membership_id']).toBe(c.membreA(c.carole));
      // Un preneur ACTIF, lui, reste protégé.
      expect((await c.alice.client.put(chemin(vin), { prend: true })).statut).toBe(409);
      expect((await c.alice.client.put(chemin(vin), { prend: false })).statut).toBe(409);
    });

    it('un preneur qui quitte le groupe garde son marquage dans l’historique, sans erreur de lecture', async () => {
      const liste = await c.creerListe(c.alice);
      const [pain] = await c.ajouter(c.alice, liste, 'Pain');
      await c.erin.client.put(c.chemin(`/listes/${liste}/articles/${pain ?? ''}/preneur`), { prend: true });
      expect((await c.erin.client.post(c.chemin('/depart'))).statut).toBe(200);
      const r = await c.alice.client.get(c.chemin(`/listes/${liste}`));
      expect(r.statut).toBe(200);
      expect((r.corps['articles'] as Array<Record<string, unknown>>)[0]).toMatchObject({ claimed_by_membership_id: c.membreA(c.erin), claimed_by_name: c.nom(c.erin) });
    });
  });

  describe('fait', () => {
    it('coche et décoche : `is_done` et `done_at` vont ensemble', async () => {
      const liste = await c.creerListe(c.alice);
      const [pain] = await c.ajouter(c.alice, liste, 'Pain');
      const chemin = c.chemin(`/listes/${liste}/articles/${pain ?? ''}/fait`);
      const coche = await c.erin.client.put(chemin, { fait: true });
      expect(coche.statut, JSON.stringify(coche.corps)).toBe(200);
      expect(coche.corps).toMatchObject({ is_done: true, done_at: '2026-11-15T12:00:00Z' });
      expect(ligneArticle(pain ?? '')).toMatchObject({ is_done: 1, done_at: '2026-11-15T12:00:00Z' });
      const decoche = await c.carole.client.put(chemin, { fait: false });
      expect(decoche.corps).toMatchObject({ is_done: false, done_at: null });
      expect(ligneArticle(pain ?? '')).toMatchObject({ is_done: 0, done_at: null });
    });

    it('cocher deux fois garde l’instant du premier ; décocher ce qui ne l’est pas ne change rien', async () => {
      const liste = await c.creerListe(c.alice);
      const [pain] = await c.ajouter(c.alice, liste, 'Pain');
      const chemin = c.chemin(`/listes/${liste}/articles/${pain ?? ''}/fait`);
      expect((await c.carole.client.put(chemin, { fait: false })).statut).toBe(200);
      await c.carole.client.put(chemin, { fait: true });
      c.d.temps.avancer(3_600_000);
      const encore = await c.erin.client.put(chemin, { fait: true });
      expect(encore.statut).toBe(200);
      expect(encore.corps['done_at']).toBe('2026-11-15T12:00:00Z');
    });

    it('refuse un corps qui ne dit pas clairement `fait` (booléen), ou qui force `done_at`', async () => {
      const liste = await c.creerListe(c.alice);
      const [pain] = await c.ajouter(c.alice, liste, 'Pain');
      const chemin = c.chemin(`/listes/${liste}/articles/${pain ?? ''}/fait`);
      for (const corps of [{}, { fait: 1 }, { fait: 'true' }, { fait: true, done_at: null }, { is_done: true }]) {
        expect((await c.alice.client.put(chemin, corps)).statut, JSON.stringify(corps)).toBe(400);
      }
    });
  });

  describe('réordonnancement', () => {
    it('place un article après un autre, ou en tête, en n’écrivant que sa ligne', async () => {
      const liste = await c.creerListe(c.alice);
      const [a, b, cc, dd] = await c.ajouter(c.alice, liste, 'A', 'B', 'C', 'D');
      const avant = (id: string | undefined): unknown => ligneArticle(id ?? '')['updated_at'];
      expect((await c.carole.client.patch(c.chemin(`/listes/${liste}/articles/${dd ?? ''}`), { after_item_id: a })).statut).toBe(200);
      expect(await ordre(liste)).toEqual(['A', 'D', 'B', 'C']);
      expect((await c.carole.client.patch(c.chemin(`/listes/${liste}/articles/${cc ?? ''}`), { after_item_id: null })).statut).toBe(200);
      expect(await ordre(liste)).toEqual(['C', 'A', 'D', 'B']);
      // Les articles qui n'ont pas bougé n'ont pas été réécrits.
      expect(ligneArticle(b ?? '')['position']).toBe(2048);
      expect(avant(b)).toBe(ligneArticle(b ?? '')['updated_at']);
    });

    it('le libellé et la place peuvent changer dans la même requête', async () => {
      const liste = await c.creerListe(c.alice);
      const [a, b] = await c.ajouter(c.alice, liste, 'A', 'B');
      const r = await c.alice.client.patch(c.chemin(`/listes/${liste}/articles/${a ?? ''}`), { label: 'A bis', after_item_id: b });
      expect(r.statut).toBe(200);
      expect(await ordre(liste)).toEqual(['B', 'A bis']);
    });

    it('la référence doit être un AUTRE article de la même liste : soi-même, une autre liste, un supprimé → 404, rien ne bouge', async () => {
      const liste = await c.creerListe(c.alice);
      const autre = await c.creerListe(c.alice, 'Autre');
      const [a, b, mort] = await c.ajouter(c.alice, liste, 'A', 'B', 'Mort');
      const [ailleurs] = await c.ajouter(c.alice, autre, 'Ailleurs');
      await c.alice.client.delete(c.chemin(`/listes/${liste}/articles/${mort ?? ''}`));
      for (const ref of [a, ailleurs, mort, 'inexistant']) {
        const r = await c.alice.client.patch(c.chemin(`/listes/${liste}/articles/${a ?? ''}`), { label: 'Modifié', after_item_id: ref });
        expect(r.statut, String(ref)).toBe(404);
        expect(r.corps).toEqual({ error: 'article.introuvable' });
      }
      expect(await ordre(liste)).toEqual(['A', 'B']); // et le libellé n'a pas été écrit non plus : la requête est atomique
      expect(b).toBeDefined();
    });

    it('à positions égales (collision), l’identifiant départage : ordre déterministe, aucun article perdu', async () => {
      const liste = await c.creerListe(c.alice);
      const ids = await c.ajouter(c.alice, liste, 'X', 'Y', 'Z', 'T');
      // Collision forcée : toutes les positions deviennent égales (deux personnes qui ajoutent « en même temps » dans une version naïve).
      c.d.sql.prepare('UPDATE shopping_items SET position = 500 WHERE shopping_list_id = ?').run(liste);
      const attendu = [...ids].sort(); // id croissant (UUID v7 : ordre de création, mais le critère est l'id)
      const lus = (await articles(liste)).map((a) => a['id']);
      expect(lus).toEqual(attendu);
      expect((await articles(liste)).length).toBe(4);
      // Même ordre à chaque lecture.
      expect((await articles(liste)).map((a) => a['id'])).toEqual(lus);

      // Déplacer dans cette liste en collision : l'écart est nul, la liste est renumérotée en conservant l'ordre, rien n'est perdu.
      const [premier, deuxieme, troisieme, quatrieme] = attendu;
      const r = await c.alice.client.patch(c.chemin(`/listes/${liste}/articles/${quatrieme ?? ''}`), { after_item_id: premier });
      expect(r.statut).toBe(200);
      expect((await articles(liste)).map((a) => a['id'])).toEqual([premier, quatrieme, deuxieme, troisieme]);
      const positions = (await articles(liste)).map((a) => a['position']);
      expect(new Set(positions).size, 'après renumérotation, plus aucune collision').toBe(4);
    });

    it('propriété : une longue suite de déplacements (dont les renumérotations) suit exactement un modèle en mémoire', async () => {
      const liste = await c.creerListe(c.alice);
      const ids = await c.ajouter(c.alice, liste, 'a', 'b', 'c', 'd', 'e', 'f');
      const modele = [...ids];
      // Suite pseudo-aléatoire déterministe (LCG) ; beaucoup de déplacements « juste après le premier » pour épuiser l'écart.
      let graine = 12345;
      const suivant = (n: number): number => {
        graine = (graine * 1103515245 + 12345) % 2147483648;
        return graine % n;
      };
      for (let i = 0; i < 40; i++) {
        const deplace = modele[suivant(modele.length)] as string;
        const autres = modele.filter((x) => x !== deplace);
        const apres = i % 3 === 0 ? null : (autres[i % 3 === 1 ? 0 : suivant(autres.length)] as string);
        const rang = apres === null ? 0 : autres.indexOf(apres) + 1;
        modele.splice(0, modele.length, ...autres.slice(0, rang), deplace, ...autres.slice(rang));
        const r = await c.alice.client.patch(c.chemin(`/listes/${liste}/articles/${deplace}`), { after_item_id: apres });
        expect(r.statut, `déplacement ${String(i)}`).toBe(200);
        expect((await articles(liste)).map((a) => a['id']), `après le déplacement ${String(i)}`).toEqual(modele);
      }
      expect((await articles(liste)).length).toBe(6);
    });

    it('un article ajouté après des déplacements arrive bien en fin de liste', async () => {
      const liste = await c.creerListe(c.alice);
      const [a, b] = await c.ajouter(c.alice, liste, 'A', 'B');
      await c.alice.client.patch(c.chemin(`/listes/${liste}/articles/${b ?? ''}`), { after_item_id: null });
      await c.alice.client.patch(c.chemin(`/listes/${liste}/articles/${a ?? ''}`), { after_item_id: null });
      await c.ajouter(c.alice, liste, 'Nouveau');
      expect(await ordre(liste)).toEqual(['A', 'B', 'Nouveau']);
    });
  });
});
