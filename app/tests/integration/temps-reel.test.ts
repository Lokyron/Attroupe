import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiffuseurTempsReel } from '../../server/services/temps-reel.js';
import { monde, type Monde } from '../cloisonnement/monde.js';
import { courses, type Courses } from '../fixtures/courses.js';
import { serveurFlux, type FluxOuvert, type ServeurFlux } from '../fixtures/flux-sse.js';
import type { Personne } from '../fixtures/groupes.js';

// Le flux temps réel (lot 6, critère de réussite n° 3). Un vrai serveur HTTP, de vrais flux SSE lus au fil de l'eau.
// Les trois risques propres au flux, chacun prouvé ici :
//  1. une connexion qui reste ouverte ne revérifie rien d'elle-même : QUI est retiré du groupe ne reçoit plus rien, et son flux se ferme ;
//  2. la diffusion est en mémoire, indexée par groupe : rien de A n'arrive jamais dans le flux de B ;
//  3. des cases cochées en rafale par plusieurs personnes : personne ne rate rien.

const attendreFermeture = async (flux: FluxOuvert, delaiMs = 2000): Promise<void> => {
  await Promise.race([flux.ferme, new Promise<void>((_ok, ko) => setTimeout(() => ko(new Error(`Le flux ne s'est pas fermé en ${String(delaiMs)} ms.`)), delaiMs))]);
};
const pause = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));
const types = (flux: FluxOuvert): string[] => flux.evenements.map((e) => e.type);

describe('flux temps réel : contrat', () => {
  let c: Courses;
  let sse: ServeurFlux;
  beforeEach(async () => {
    c = await courses('tr');
    sse = await serveurFlux(c.d.app);
  });
  afterEach(async () => {
    await sse.arreter();
    c.d.nettoyer();
  });

  it('un membre ouvre le flux : 200, text/event-stream, pas de cache, pas de tampon pour le proxy, premier octet immédiat', async () => {
    const flux = await sse.ouvrir(c.erin.client, c.a.groupId);
    expect(flux.statut).toBe(200);
    expect(flux.entetes['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(flux.entetes['cache-control']).toBe('no-cache, no-transform');
    expect(flux.entetes['x-accel-buffering']).toBe('no');
    expect(flux.entetes['connection']).toBe('keep-alive');
    expect(flux.brut()).toBe('retry: 5000\n: ouvert\n\n');
  });

  it('sans session : 401 JSON, jamais un flux ; un étranger : 404 JSON AVANT l’ouverture, sans en-têtes de flux', async () => {
    const anonyme = await sse.ouvrir(c.d.client(), c.a.groupId);
    expect(anonyme.statut).toBe(401);
    expect(JSON.parse(anonyme.brut())).toEqual({ error: 'session.requise' });
    expect(anonyme.entetes['content-type']).toMatch(/^application\/json/);

    const etranger = await sse.ouvrir(c.bob.client, c.a.groupId);
    expect(etranger.statut).toBe(404);
    expect(JSON.parse(etranger.brut())).toEqual({ error: 'groupe.introuvable' });
    expect(etranger.entetes['content-type']).toMatch(/^application\/json/);
    expect(etranger.entetes['x-accel-buffering']).toBeUndefined();
  });

  it('chaque changement de ce lot est poussé, dans l’ordre, en message MINIMAL (type, ressource, id, parent, auteur, instant)', async () => {
    const flux = await sse.ouvrir(c.erin.client, c.a.groupId);
    const soiree = await c.creerEvenement(c.alice);
    const liste = await c.creerListe(c.alice, 'Secret de la liste', soiree);
    const post = (chemin: string, corps?: unknown): ReturnType<typeof c.alice.client.post> => c.alice.client.post(c.chemin(chemin), corps);
    const article = (await post(`/listes/${liste}/articles`, { label: 'Libellé confidentiel' })).corps['id'] as string;
    const sur = (suffixe: string): string => c.chemin(`/listes/${liste}/articles/${article}${suffixe}`);
    await c.alice.client.patch(sur(''), { label: 'Autre libellé confidentiel' });
    await c.alice.client.put(sur('/preneur'), { prend: true });
    await c.alice.client.put(sur('/preneur'), { prend: false });
    await c.alice.client.put(sur('/fait'), { fait: true });
    await c.alice.client.put(sur('/fait'), { fait: false });
    await c.alice.client.delete(sur(''));
    await c.alice.client.patch(c.chemin(`/listes/${liste}`), { title: 'Renommée' });
    await c.alice.client.delete(c.chemin(`/listes/${liste}`));
    const tache = (await post('/taches', { title: 'Tâche confidentielle', event_id: soiree })).corps['id'] as string;
    await c.alice.client.patch(c.chemin(`/taches/${tache}`), { status: 'doing' });
    await c.alice.client.put(c.chemin(`/taches/${tache}/assignation`), { assignee_membership_id: c.membreA(c.alice) });
    await c.alice.client.delete(c.chemin(`/taches/${tache}`));

    await flux.attendre((e) => e.type === 'tache.supprimee');
    expect(types(flux)).toEqual([
      'liste.creee',
      'article.ajoute',
      'article.modifie',
      'article.pris',
      'article.libere',
      'article.coche',
      'article.decoche',
      'article.supprime',
      'liste.renommee',
      'liste.supprimee',
      'tache.creee',
      'tache.modifiee',
      'tache.assignee',
      'tache.supprimee',
    ]);
    const [creee, ajoute, , pris] = flux.evenements;
    expect(creee).toEqual({ type: 'liste.creee', ressource: 'liste', id: liste, parent_id: soiree, par: c.membreA(c.alice), at: '2026-11-15T12:00:00Z' });
    expect(ajoute).toMatchObject({ ressource: 'article', id: article, parent_id: liste });
    expect(pris).toMatchObject({ ressource: 'article', id: article, parent_id: liste, par: c.membreA(c.alice) });
    expect(flux.evenements.at(-1)).toMatchObject({ ressource: 'tache', id: tache, parent_id: soiree });
    // Minimal : exactement ces six clés, et aucun contenu métier (libellé, titre) ne traverse le flux.
    for (const e of flux.evenements) expect(Object.keys(e).sort()).toEqual(['at', 'id', 'par', 'parent_id', 'ressource', 'type']);
    for (const secret of ['confidentiel', 'Secret de la liste', 'Renommée', 'Tâche']) expect(flux.brut(), `« ${secret} » a fuité dans le flux`).not.toContain(secret);
  });

  it('un changement sans effet (déjà pris par moi, déjà coché) et un conflit (409) ne poussent rien', async () => {
    const liste = await c.creerListe(c.alice);
    const [pain] = await c.ajouter(c.alice, liste, 'Pain');
    const flux = await sse.ouvrir(c.erin.client, c.a.groupId);
    const sur = (suffixe: string): string => c.chemin(`/listes/${liste}/articles/${pain ?? ''}${suffixe}`);
    await c.carole.client.put(sur('/preneur'), { prend: true });
    await c.carole.client.put(sur('/preneur'), { prend: true }); // déjà à moi : sans effet
    expect((await c.alice.client.put(sur('/preneur'), { prend: true })).statut).toBe(409); // perdu : sans effet
    expect((await c.alice.client.put(sur('/preneur'), { prend: false })).statut).toBe(409);
    await c.carole.client.put(sur('/fait'), { fait: true });
    await c.alice.client.put(sur('/fait'), { fait: true }); // déjà coché : sans effet
    await c.alice.client.put(sur('/fait'), { fait: false });
    await flux.attendre((e) => e.type === 'article.decoche');
    expect(types(flux)).toEqual(['article.pris', 'article.coche', 'article.decoche']);
  });

  it('une requête refusée (400, 404) ne pousse rien non plus', async () => {
    const liste = await c.creerListe(c.alice);
    const flux = await sse.ouvrir(c.erin.client, c.a.groupId);
    await c.alice.client.post(c.chemin(`/listes/${liste}/articles`), { label: '' });
    await c.alice.client.put(c.chemin(`/listes/${liste}/articles/inconnu/fait`), { fait: true });
    await c.alice.client.post(c.chemin('/listes/inconnue/articles'), { label: 'x' });
    await c.alice.client.put(c.chemin('/taches/inconnue/assignation'), { assignee_membership_id: null });
    await pause(100);
    expect(flux.evenements).toEqual([]);
  });

  it('chacun reçoit aussi les changements de l’autre : plusieurs flux d’un même groupe', async () => {
    const liste = await c.creerListe(c.alice);
    const [pain] = await c.ajouter(c.alice, liste, 'Pain');
    const fluxCarole = await sse.ouvrir(c.carole.client, c.a.groupId);
    const fluxErin = await sse.ouvrir(c.erin.client, c.a.groupId);
    await c.alice.client.put(c.chemin(`/listes/${liste}/articles/${pain ?? ''}/fait`), { fait: true });
    for (const flux of [fluxCarole, fluxErin]) {
      const e = await flux.attendre((x) => x.type === 'article.coche');
      expect(e).toMatchObject({ id: pain, par: c.membreA(c.alice) });
    }
  });
});

describe('flux temps réel : battement, plafond et nettoyage', () => {
  let c: Courses;
  let sse: ServeurFlux;
  let diffuseur: DiffuseurTempsReel;
  beforeEach(async () => {
    diffuseur = new DiffuseurTempsReel({ intervalleBattementMs: 40, plafondParCompte: 3 });
    c = await courses('tb', { diffuseur });
    sse = await serveurFlux(c.d.app);
  });
  afterEach(async () => {
    await sse.arreter();
    diffuseur.fermerTout();
    c.d.nettoyer();
  });

  const attendreNombre = async (attendu: number): Promise<void> => {
    for (let i = 0; i < 100 && diffuseur.nombre !== attendu; i++) await pause(10);
    expect(diffuseur.nombre).toBe(attendu);
  };

  it('un battement de cœur périodique est écrit (commentaire SSE : un proxy qui coupe à 60 s sans octet ne coupe pas)', async () => {
    const flux = await sse.ouvrir(c.erin.client, c.a.groupId);
    for (let i = 0; i < 100 && (flux.brut().match(/: battement/g) ?? []).length < 3; i++) await pause(10);
    expect((flux.brut().match(/: battement\n\n/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(flux.evenements, 'le battement n’est pas un événement').toEqual([]);
  });

  it('plafond de connexions par compte : la suivante reçoit un 429 JSON avant tout flux ; fermer une libère une place ; les autres comptes ne sont pas touchés', async () => {
    const ouverts = [await sse.ouvrir(c.erin.client, c.a.groupId), await sse.ouvrir(c.erin.client, c.a.groupId), await sse.ouvrir(c.erin.client, c.a.groupId)];
    const refuse = await sse.ouvrir(c.erin.client, c.a.groupId);
    expect(refuse.statut).toBe(429);
    expect(JSON.parse(refuse.brut())).toEqual({ error: 'flux.trop_de_connexions' });
    expect(refuse.entetes['retry-after']).toBe('30');
    expect(refuse.entetes['content-type']).toMatch(/^application\/json/);
    expect(diffuseur.nombre).toBe(3);

    expect((await sse.ouvrir(c.carole.client, c.a.groupId)).statut, 'le plafond est PAR compte').toBe(200);

    ouverts[0]?.fermer();
    await attendreNombre(3); // Erin 2 + Carole 1
    expect((await sse.ouvrir(c.erin.client, c.a.groupId)).statut).toBe(200);
  });

  it('le registre est nettoyé à la fermeture par le client, et à la coupure brutale du socket', async () => {
    const un = await sse.ouvrir(c.erin.client, c.a.groupId);
    const deux = await sse.ouvrir(c.carole.client, c.a.groupId);
    await attendreNombre(2);
    un.fermer();
    await attendreNombre(1);
    deux.fermer();
    await attendreNombre(0);
    // Le plafond ne « fuit » pas : trois ouvertures-fermetures successives, puis encore trois ouvertes.
    for (let i = 0; i < 5; i++) (await sse.ouvrir(c.erin.client, c.a.groupId)).fermer();
    await attendreNombre(0);
    expect((await sse.ouvrir(c.erin.client, c.a.groupId)).statut).toBe(200);
  });

  it('un flux ne survit pas à sa session : la déconnexion ferme ses flux au prochain envoi', async () => {
    const flux = await sse.ouvrir(c.erin.client, c.a.groupId);
    expect((await c.erin.client.post('/api/auth/deconnexion')).statut).toBe(200);
    await attendreFermeture(flux); // le battement revérifie : la session est révoquée
    expect(flux.estFerme()).toBe(true);
    await attendreNombre(0);
  });
});

describe('flux temps réel : plafond global et arrêt', () => {
  it('au-delà du plafond GLOBAL, même un autre compte reçoit un 429 ; fermer un flux libère une place', async () => {
    const diffuseur = new DiffuseurTempsReel({ plafondGlobal: 2, intervalleBattementMs: 3_600_000 });
    const c = await courses('pg', { diffuseur });
    const sse = await serveurFlux(c.d.app);
    try {
      const un = await sse.ouvrir(c.erin.client, c.a.groupId);
      await sse.ouvrir(c.carole.client, c.a.groupId);
      const refuse = await sse.ouvrir(c.alice.client, c.a.groupId);
      expect(refuse.statut).toBe(429);
      expect(JSON.parse(refuse.brut())).toEqual({ error: 'flux.trop_de_connexions' });
      un.fermer();
      for (let i = 0; i < 100 && diffuseur.nombre > 1; i++) await pause(10);
      expect((await sse.ouvrir(c.alice.client, c.a.groupId)).statut).toBe(200);
    } finally {
      await sse.arreter();
      diffuseur.fermerTout();
      c.d.nettoyer();
    }
  });

  it('après `fermerTout` (arrêt du processus), plus aucune ouverture : le serveur ne peut pas attendre un flux né pendant l’arrêt', async () => {
    const diffuseur = new DiffuseurTempsReel({ intervalleBattementMs: 3_600_000 });
    const c = await courses('ar', { diffuseur });
    const sse = await serveurFlux(c.d.app);
    try {
      const ouvert = await sse.ouvrir(c.erin.client, c.a.groupId);
      diffuseur.fermerTout();
      await attendreFermeture(ouvert);
      expect(diffuseur.nombre).toBe(0);
      expect((await sse.ouvrir(c.erin.client, c.a.groupId)).statut).toBe(429);
      expect(diffuseur.nombre).toBe(0);
    } finally {
      await sse.arreter();
      c.d.nettoyer();
    }
  });
});

describe('flux temps réel : membre retiré pendant que son flux est ouvert', () => {
  let c: Courses;
  let sse: ServeurFlux;
  let diffuseur: DiffuseurTempsReel;
  beforeEach(async () => {
    // Battement très long : seule la revérification AVANT ENVOI d'un événement peut fermer le flux, pas le battement.
    diffuseur = new DiffuseurTempsReel({ intervalleBattementMs: 3_600_000 });
    c = await courses('rv', { diffuseur });
    sse = await serveurFlux(c.d.app);
  });
  afterEach(async () => {
    await sse.arreter();
    diffuseur.fermerTout();
    c.d.nettoyer();
  });

  const retirerEnBase = (p: Personne, statut: 'removed' | 'left' = 'removed'): void => {
    c.d.sql.prepare('UPDATE memberships SET status = ?, ended_at = ? WHERE group_id = ? AND user_id = ?').run(statut, '2026-11-16T00:00:00Z', c.a.groupId, p.userId);
  };

  it('retirée EN BASE (aucune route ne s’en mêle) : une modification a lieu, elle ne reçoit RIEN et son flux se ferme — celle qui reste reçoit', async () => {
    const liste = await c.creerListe(c.alice, 'Liste du groupe');
    const fluxErin = await sse.ouvrir(c.erin.client, c.a.groupId);
    const fluxCarole = await sse.ouvrir(c.carole.client, c.a.groupId);
    expect(fluxErin.estFerme()).toBe(false);

    retirerEnBase(c.erin);
    expect((await c.alice.client.post(c.chemin(`/listes/${liste}/articles`), { label: 'Après le retrait' })).statut).toBe(201);

    // Le témoin : Carole, toujours membre, reçoit l'événement (sinon le test ne prouverait rien).
    await fluxCarole.attendre((e) => e.type === 'article.ajoute');
    // D'abord ce qu'il a REÇU (la fuite), ensuite que le flux s'est FERMÉ.
    expect(fluxErin.evenements, 'un membre retiré a reçu un événement du groupe après son retrait').toEqual([]);
    expect(fluxErin.brut(), 'un membre retiré a reçu des octets du groupe après son retrait').toBe('retry: 5000\n: ouvert\n\n');
    await attendreFermeture(fluxErin).catch((erreur: unknown) => {
      throw new Error(`Un membre retiré garde son flux ouvert : ${erreur instanceof Error ? erreur.message : String(erreur)}`);
    });
    expect(diffuseur.nombre).toBe(1);
    // Et il ne peut pas rouvrir le flux : 404, comme pour toute route du groupe.
    expect((await sse.ouvrir(c.erin.client, c.a.groupId)).statut).toBe(404);
  });

  it.each([['suspendu', 'disabled_at'], ['anonymisé', 'anonymized_at']] as const)(
    'compte %s pendant que son flux est ouvert : il ne reçoit RIEN et son flux se ferme (l’état du compte est relu, pas seulement la session)',
    async (_nom, colonne) => {
      const liste = await c.creerListe(c.alice);
      const fluxErin = await sse.ouvrir(c.erin.client, c.a.groupId);
      const fluxCarole = await sse.ouvrir(c.carole.client, c.a.groupId);
      // La suspension s'écrit sur `users` ; la session et l'appartenance restent intactes.
      c.d.sql.prepare(`UPDATE users SET ${colonne} = ? WHERE id = ?`).run('2026-11-16T00:00:00Z', c.erin.userId);
      expect((await c.erin.client.get(c.chemin(`/listes/${liste}`))).statut, 'ailleurs, le compte est bien refusé').toBe(401);
      await c.alice.client.post(c.chemin(`/listes/${liste}/articles`), { label: 'Après la suspension' });
      await fluxCarole.attendre((e) => e.type === 'article.ajoute');
      expect(fluxErin.evenements, `un compte ${colonne} a reçu un événement du groupe`).toEqual([]);
      await attendreFermeture(fluxErin).catch((erreur: unknown) => {
        throw new Error(`Un compte ${colonne} garde son flux ouvert : ${erreur instanceof Error ? erreur.message : String(erreur)}`);
      });
    },
  );

  it('même chose pour un départ volontaire (`left`) écrit en base', async () => {
    const liste = await c.creerListe(c.alice);
    const fluxErin = await sse.ouvrir(c.erin.client, c.a.groupId);
    retirerEnBase(c.erin, 'left');
    await c.alice.client.post(c.chemin(`/listes/${liste}/articles`), { label: 'Après le départ' });
    await attendreFermeture(fluxErin);
    expect(fluxErin.evenements).toEqual([]);
  });

  it('un membre retiré de A garde son flux de B : la fermeture ne touche que le groupe concerné', async () => {
    // Manon est membre de A et de B (monde de cloisonnement) ; on la retire de A en base.
    const m: Monde = await monde();
    const serveur = await serveurFlux(m.d.app);
    try {
      const fluxA = await serveur.ouvrir(m.manon.client, m.a.groupId);
      const fluxB = await serveur.ouvrir(m.manon.client, m.b.groupId);
      m.d.sql.prepare("UPDATE memberships SET status = 'removed', ended_at = ? WHERE group_id = ? AND user_id = ?").run('2026-11-16T00:00:00Z', m.a.groupId, m.manon.userId);
      const liste = (await m.alice.client.post(`/api/groupes/${m.a.groupId}/listes`, { title: 'Après le retrait de Manon' })).corps['id'] as string;
      await m.bob.client.post(`/api/groupes/${m.b.groupId}/listes`, { title: 'Dans B' });
      await attendreFermeture(fluxA);
      await fluxB.attendre((e) => e.type === 'liste.creee');
      expect(fluxA.evenements).toEqual([]);
      expect(fluxA.brut()).not.toContain(liste);
      expect(fluxB.estFerme()).toBe(false);
    } finally {
      await serveur.arreter();
      m.d.nettoyer();
    }
  });

  it('retirée PAR L’API : le flux se ferme tout de suite, sans attendre aucun événement (fermeture active)', async () => {
    const fluxErin = await sse.ouvrir(c.erin.client, c.a.groupId);
    const fluxCarole = await sse.ouvrir(c.carole.client, c.a.groupId);
    expect((await c.alice.client.delete(c.chemin(`/membres/${c.membreA(c.erin)}`))).statut).toBe(200);
    await attendreFermeture(fluxErin);
    expect(fluxCarole.estFerme()).toBe(false);
    expect(diffuseur.nombre).toBe(1);
  });

  it('départ PAR L’API : son flux se ferme tout de suite', async () => {
    const fluxErin = await sse.ouvrir(c.erin.client, c.a.groupId);
    expect((await c.erin.client.post(c.chemin('/depart'))).statut).toBe(200);
    await attendreFermeture(fluxErin);
  });

  it('changement de rôle : le flux reste ouvert (le message ne dépend pas du rôle), le membre continue de recevoir', async () => {
    const fluxErin = await sse.ouvrir(c.erin.client, c.a.groupId);
    expect((await c.alice.client.patch(c.chemin(`/membres/${c.membreA(c.erin)}`), { role: 'admin' })).statut).toBe(200);
    await c.creerListe(c.alice);
    await fluxErin.attendre((e) => e.type === 'liste.creee');
    expect(fluxErin.estFerme()).toBe(false);
  });

  it('sans aucun événement, le battement suffit à fermer un flux révoqué', async () => {
    const court = new DiffuseurTempsReel({ intervalleBattementMs: 30 });
    const d2 = await courses('rb', { diffuseur: court });
    const serveur = await serveurFlux(d2.d.app);
    try {
      const fluxErin = await serveur.ouvrir(d2.erin.client, d2.a.groupId);
      d2.d.sql.prepare("UPDATE memberships SET status = 'removed', ended_at = ? WHERE group_id = ? AND user_id = ?").run('2026-11-16T00:00:00Z', d2.a.groupId, d2.erin.userId);
      await attendreFermeture(fluxErin);
      expect(court.nombre).toBe(0);
    } finally {
      await serveur.arreter();
      court.fermerTout();
      d2.d.nettoyer();
    }
  });
});

describe('flux temps réel : deux groupes, deux flux', () => {
  let m: Monde;
  let sse: ServeurFlux;
  beforeEach(async () => {
    m = await monde();
    sse = await serveurFlux(m.d.app);
  });
  afterEach(async () => {
    await sse.arreter();
    m.d.nettoyer();
  });

  it('une modification dans A n’apparaît JAMAIS dans le flux de B (et inversement), et le corps poussé ne contient aucune marque de B', async () => {
    const fluxA = await sse.ouvrir(m.alice.client, m.a.groupId);
    const fluxB = await sse.ouvrir(m.bob.client, m.b.groupId);
    // Dave (simple membre de B seul) : un second abonné de B, qui n'a aucun lien avec A.
    const fluxDave = await sse.ouvrir(m.dave.client, m.b.groupId);

    // Dans A : toute la gamme de changements, par plusieurs personnes.
    const sur = (g: string, suffixe: string): string => `/api/groupes/${g}${suffixe}`;
    const listeA = (await m.alice.client.post(sur(m.a.groupId, '/listes'), { title: 'Courses A, deuxième' })).corps['id'] as string;
    const articleA = (await m.carole.client.post(sur(m.a.groupId, `/listes/${listeA}/articles`), { label: 'Pâtes de A' })).corps['id'] as string;
    await m.erin.client.put(sur(m.a.groupId, `/listes/${listeA}/articles/${articleA}/preneur`), { prend: true });
    await m.carole.client.put(sur(m.a.groupId, `/listes/${listeA}/articles/${articleA}/fait`), { fait: true });
    await m.alice.client.put(sur(m.a.groupId, `/listes/${m.ressources.a.liste}/articles/${m.ressources.a.article}/fait`), { fait: true });
    const tacheA = (await m.alice.client.post(sur(m.a.groupId, '/taches'), { title: 'Tâche de A' })).corps['id'] as string;
    await m.alice.client.put(sur(m.a.groupId, `/taches/${tacheA}/assignation`), { assignee_membership_id: m.ressources.a.membre });
    // Dans B, ensuite, par Bob et par Dave : un seul message, reconnaissable.
    const listeB = (await m.bob.client.post(sur(m.b.groupId, '/listes'), { title: 'Nouvelle liste de B' })).corps['id'] as string;
    await m.dave.client.put(sur(m.b.groupId, `/listes/${m.ressources.b.liste}/articles/${m.ressources.b.article}/fait`), { fait: true });

    await fluxA.attendre((e) => e.type === 'tache.assignee');
    await fluxB.attendre((e) => e.id === m.ressources.b.article);
    await fluxDave.attendre((e) => e.id === m.ressources.b.article);

    // Le flux de A ne contient QUE des événements de A : chaque identifiant poussé existe dans A, aucun dans B.
    const idsDeA = new Set([listeA, articleA, tacheA, m.ressources.a.article, m.ressources.a.liste]);
    expect(fluxA.evenements.length).toBeGreaterThanOrEqual(7);
    for (const e of fluxA.evenements) expect(idsDeA.has(e.id), `événement étranger dans le flux de A : ${JSON.stringify(e)}`).toBe(true);
    for (const marque of m.marquesDeB) expect(fluxA.brut(), `fuite de « ${marque} » dans le flux de A`).not.toContain(marque);
    expect(fluxA.brut()).not.toContain(listeB);

    // Le flux de B ne contient QUE des événements de B, aucune marque de A.
    const idsDeB = new Set([listeB, m.ressources.b.article]);
    expect(types(fluxB)).toEqual(['liste.creee', 'article.coche']);
    for (const flux of [fluxB, fluxDave]) {
      for (const e of flux.evenements) expect(idsDeB.has(e.id), `événement étranger dans le flux de B : ${JSON.stringify(e)}`).toBe(true);
      for (const marque of [m.a.groupId, ...Object.values(m.ressources.a), listeA, articleA, tacheA, 'Groupe A', 'Pâtes de A', 'Tâche de A', m.alice.userId, m.carole.userId]) {
        expect(flux.brut(), `fuite de « ${marque} » dans le flux de B`).not.toContain(marque);
      }
    }
  });

  it('Manon, membre des DEUX groupes, ouvre deux flux : chacun ne reçoit que son groupe', async () => {
    const fluxManonA = await sse.ouvrir(m.manon.client, m.a.groupId);
    const fluxManonB = await sse.ouvrir(m.manon.client, m.b.groupId);
    const listeA = (await m.alice.client.post(`/api/groupes/${m.a.groupId}/listes`, { title: 'Pour A' })).corps['id'] as string;
    const listeB = (await m.bob.client.post(`/api/groupes/${m.b.groupId}/listes`, { title: 'Pour B' })).corps['id'] as string;
    await fluxManonA.attendre((e) => e.id === listeA);
    await fluxManonB.attendre((e) => e.id === listeB);
    expect(fluxManonA.evenements.map((e) => e.id)).toEqual([listeA]);
    expect(fluxManonB.evenements.map((e) => e.id)).toEqual([listeB]);
  });
});

describe('flux temps réel : trois comptes cochent en même temps', () => {
  let c: Courses;
  let sse: ServeurFlux;
  beforeEach(async () => {
    c = await courses('tc');
    sse = await serveurFlux(c.d.app);
  });
  afterEach(async () => {
    await sse.arreter();
    c.d.nettoyer();
  });

  it('trois comptes, trois flux, une rafale de cases : aucune perte, état final cohérent, chacun voit les changements des deux autres', async () => {
    const liste = await c.creerListe(c.alice, 'Courses du magasin');
    const parPersonne = 6;
    const personnes = [c.alice, c.carole, c.erin];
    const labels = personnes.flatMap((_p, i) => Array.from({ length: parPersonne }, (_v, k) => `Article ${String(i)}-${String(k)}`));
    const ids = await c.ajouter(c.alice, liste, ...labels);
    const flux = await Promise.all(personnes.map((p) => sse.ouvrir(p.client, c.a.groupId)));

    // Chacune coche SES six articles, plus prend l'un des siens, toutes en même temps (dix-huit cases, dix-huit prises).
    const requetes = personnes.flatMap((p, i) =>
      ids.slice(i * parPersonne, (i + 1) * parPersonne).flatMap((id) => [
        p.client.put(c.chemin(`/listes/${liste}/articles/${id}/fait`), { fait: true }),
        p.client.put(c.chemin(`/listes/${liste}/articles/${id}/preneur`), { prend: true }),
      ]),
    );
    const reponses = await Promise.all(requetes);
    expect(reponses.map((r) => r.statut), JSON.stringify(reponses.filter((r) => r.statut !== 200).map((r) => r.corps))).toEqual(Array(requetes.length).fill(200));

    // État final : tout est coché et pris par la bonne personne, rien de perdu, la liste a toujours ses dix-huit articles.
    const etat = (await c.alice.client.get(c.chemin(`/listes/${liste}`))).corps['articles'] as Array<Record<string, unknown>>;
    expect(etat).toHaveLength(personnes.length * parPersonne);
    personnes.forEach((p, i) => {
      for (const id of ids.slice(i * parPersonne, (i + 1) * parPersonne)) {
        expect(etat.find((a) => a['id'] === id), `article ${id}`).toMatchObject({ is_done: true, claimed_by_membership_id: c.membreA(p) });
      }
    });

    // Chacun voit, SANS recharger, les cases cochées par les deux autres (et les siennes).
    for (const [i, f] of flux.entries()) {
      for (const [j, autre] of personnes.entries()) {
        for (const id of ids.slice(j * parPersonne, (j + 1) * parPersonne)) {
          await f.attendre((e) => e.type === 'article.coche' && e.id === id && e.par === c.membreA(autre));
        }
      }
      const coches = f.evenements.filter((e) => e.type === 'article.coche');
      expect(coches, `le flux ${String(i)} a ${String(coches.length)} cases cochées`).toHaveLength(personnes.length * parPersonne);
      expect(f.evenements.filter((e) => e.type === 'article.pris')).toHaveLength(personnes.length * parPersonne);
    }
  });
});
