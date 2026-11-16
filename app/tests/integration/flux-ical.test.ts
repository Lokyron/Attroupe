import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Decor, Reponse } from '../fixtures/comptes.js';
import { decor, groupe, personne, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';

// Le compteur espionne la GÉNÉRATION (lecture des événements) : un 304 ne doit coûter que des agrégats. `vi.mock` est hissé en tête de fichier.
const generations = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../server/db/queries/flux.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../server/db/queries/flux.js')>();
  return {
    ...original,
    evenementsFlux: (...args: Parameters<typeof original.evenementsFlux>) => {
      generations.n++;
      return original.evenementsFlux(...args);
    },
  };
});

// Le flux iCal (lot 5) : contenu, fenêtre, présences, ETag et 304, cadence. Le cloisonnement (jeton inconnu / révoqué, membre retiré,
// jeton restreint) est dans tests/cloisonnement (exigence `jetonFlux`).
describe('flux iCal : GET /ical/:jeton.ics', () => {
  let d: Decor;
  let alice: Personne; // membre de A et de B
  let bob: Personne; // administrateur de A
  let ga: GroupeAmorce;
  let gb: GroupeAmorce;
  let jeton: string;
  let idFlux: string;

  beforeEach(async () => {
    generations.n = 0;
    d = decor();
    alice = await personne(d, 'alice_i');
    bob = await personne(d, 'bob_i');
    ga = await groupe(d, 'La bande', [{ personne: bob, role: 'admin' }, { personne: alice, role: 'member' }]);
    gb = await groupe(d, 'Les voisins', [{ personne: alice, role: 'admin' }]);
    const cree = await alice.client.post('/api/moi/flux-ical', {});
    jeton = cree.corps['token'] as string;
    idFlux = cree.corps['id'] as string;
  });
  afterEach(() => d.nettoyer());

  const anonyme = (): ReturnType<Decor['client']> => d.client('203.0.113.99');
  const lire = (j: string = jeton, entetes: Record<string, string> = {}): Promise<Reponse> => anonyme().get(`/ical/${j}.ics`, { entetes });

  async function creer(auteur: Personne, g: GroupeAmorce, corps: Record<string, unknown>): Promise<string> {
    const r = await auteur.client.post(`/api/groupes/${g.groupId}/evenements`, { title: 'Soirée', starts_at: '2027-03-20T18:00:00Z', time_zone: 'Europe/Paris', ...corps });
    expect(r.statut, JSON.stringify(r.corps)).toBe(201);
    return r.corps['id'] as string;
  }
  /** `updated_at` réel = maintenant : on le recule pour que « modifié depuis » ne rende pas la fenêtre invisible. */
  const vieillir = (id: string, instant = '2026-01-01T00:00:00Z'): void => {
    d.sql.prepare('UPDATE events SET updated_at = ? WHERE id = ?').run(instant, id);
  };
  const evenements = (r: Reponse): string[] => [...r.texte.matchAll(/\r\nUID:([^@\r]+)@attroupe/g)].map((m) => m[1] ?? '');

  describe('contenu', () => {
    it('sert un VCALENDAR valide, sans cookie, avec les en-têtes du protocole', async () => {
      const id = await creer(bob, ga, { title: 'Soirée raclette', location_name: 'Chez Bob', location_address: '12 rue A, Lyon', arrival_note: 'Sonner deux fois', description: 'Apportez du fromage' });
      const r = await lire();
      expect(r.statut).toBe(200);
      expect(r.entetes['content-type']).toBe('text/calendar; charset=utf-8');
      expect(r.entetes['cache-control']).toBe('private, max-age=300');
      expect(r.entetes['etag']).toMatch(/^"[0-9a-f]{32}"$/);
      expect(r.entetes['set-cookie']).toBeUndefined();
      expect(r.texte.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
      expect(r.texte).toContain(`\r\nUID:${id}@attroupe\r\n`);
      expect(r.texte).toContain('\r\nSUMMARY:[La bande] Soirée raclette\r\n');
      expect(r.texte).toContain('\r\nDTSTART:20270320T180000Z\r\n');
      expect(r.texte).toContain('\r\nLOCATION:Chez Bob\\, 12 rue A\\, Lyon\r\n');
      expect(r.texte).toContain('\r\nORGANIZER;CN="');
      const deplie = r.texte.replace(/\r\n /g, '');
      expect(deplie).toContain('Sonner deux fois');
      expect(deplie).toContain('Apportez du fromage');
      expect(deplie).toContain('Europe/Paris');
      expect(deplie).toContain(`https://attroupe.test/#/groupe/${ga.groupId}/evenement/${id}`);
    });

    it('ne met JAMAIS le jeton dans le contenu (ni description, ni lien, ni en-tête)', async () => {
      await creer(bob, ga, { title: 'Soirée', description: 'x' });
      const r = await lire();
      expect(r.texte).not.toContain(jeton);
      expect(JSON.stringify(r.entetes)).not.toContain(jeton);
    });

    it('agrège les groupes où l’appartenance est active, chacun préfixé de son nom', async () => {
      await creer(bob, ga, { title: 'Raclette' });
      await creer(alice, gb, { title: 'Barbecue' });
      const r = await lire();
      expect(r.texte).toContain('SUMMARY:[La bande] Raclette');
      expect(r.texte).toContain('SUMMARY:[Les voisins] Barbecue');
    });

    it('un jeton restreint à un groupe ne sert que ce groupe', async () => {
      await creer(bob, ga, { title: 'Raclette' });
      await creer(alice, gb, { title: 'Barbecue' });
      const restreint = (await alice.client.post('/api/moi/flux-ical', { group_id: gb.groupId })).corps['token'] as string;
      const r = await lire(restreint);
      expect(r.texte).toContain('SUMMARY:[Les voisins] Barbecue');
      expect(r.texte).not.toContain('Raclette');
      expect(r.texte).not.toContain('La bande');
    });

    it('un événement annulé reste dans le flux, en STATUS:CANCELLED ; un brouillon n’y est pas', async () => {
      const annule = await creer(bob, ga, { title: 'Annulée' });
      const brouillon = await creer(bob, ga, { title: 'Brouillon' });
      const publie = await creer(bob, ga, { title: 'Publiée' });
      expect((await bob.client.delete(`/api/groupes/${ga.groupId}/evenements/${annule}`)).statut).toBe(200);
      d.sql.prepare("UPDATE events SET status = 'draft' WHERE id = ?").run(brouillon);
      const r = await lire();
      expect(evenements(r).sort()).toEqual([annule, publie].sort());
      const vevent = r.texte.split('BEGIN:VEVENT').find((v) => v.includes(`UID:${annule}@attroupe`)) ?? '';
      expect(vevent).toContain('STATUS:CANCELLED');
      expect(r.texte).not.toContain('Brouillon');
    });

    it('une journée entière sort en DTSTART;VALUE=DATE, fin exclusive', async () => {
      await creer(bob, ga, { title: 'Week-end', all_day: true, starts_at: '2027-03-20', ends_at: '2027-03-21' });
      const r = await lire();
      expect(r.texte).toContain('\r\nDTSTART;VALUE=DATE:20270320\r\n');
      expect(r.texte).toContain('\r\nDTEND;VALUE=DATE:20270322\r\n');
    });

    it('une modification se propage (même UID, SEQUENCE qui croît) : le téléphone met à jour au lieu de dupliquer', async () => {
      const id = await creer(bob, ga, { title: 'Avant' });
      vieillir(id);
      const avant = await lire();
      const sequence = (r: Reponse): number => Number(/SEQUENCE:(\d+)/.exec(r.texte)?.[1]);
      await bob.client.patch(`/api/groupes/${ga.groupId}/evenements/${id}`, { title: 'Après' });
      const apres = await lire();
      expect(apres.texte).toContain('SUMMARY:[La bande] Après');
      expect(apres.texte).not.toContain('Avant');
      expect(evenements(apres)).toEqual([id]);
      expect(sequence(apres)).toBeGreaterThan(sequence(avant));
    });

    it('le nom du groupe, les caractères spéciaux et les accents d’un titre sont échappés ou pliés correctement', async () => {
      await creer(bob, ga, { title: `Dîner; chez Léa, ${'é'.repeat(100)}` });
      const r = await lire();
      for (const ligne of r.texte.split('\r\n')) expect(Buffer.byteLength(ligne, 'utf8')).toBeLessThanOrEqual(75);
      expect(r.texte.replace(/\r\n /g, '')).toContain(String.raw`SUMMARY:[La bande] Dîner\; chez Léa\, ` + 'é'.repeat(100));
    });

    it('un flux sans événement est un calendrier valide', async () => {
      const r = await lire();
      expect(r.statut).toBe(200);
      expect(evenements(r)).toEqual([]);
      expect(r.texte).toMatch(/^BEGIN:VCALENDAR\r\n[\s\S]*END:VCALENDAR\r\n$/);
    });
  });

  describe('fenêtre : 3 mois en arrière, 12 mois en avant, et tout ce qui a été modifié depuis', () => {
    // Horloge des tests : 2026-11-15 -> fenêtre du 2026-08-15 au 2027-11-15.
    it('inclut les bornes, exclut ce qui est hors fenêtre et non modifié', async () => {
      const dedans = await creer(bob, ga, { title: 'Dedans', starts_at: '2027-03-20T18:00:00Z' });
      const passeRecent = await creer(bob, ga, { title: 'Passé récent', starts_at: '2026-09-01T18:00:00Z' });
      const tropAncien = await creer(bob, ga, { title: 'Trop ancien', starts_at: '2026-05-01T18:00:00Z' });
      const tropLoin = await creer(bob, ga, { title: 'Trop loin', starts_at: '2028-01-20T18:00:00Z' });
      const jourEntierBorne = await creer(bob, ga, { title: 'Borne', all_day: true, starts_at: '2026-08-15' });
      for (const id of [dedans, passeRecent, tropAncien, tropLoin, jourEntierBorne]) vieillir(id);
      const r = await lire();
      expect(evenements(r).sort()).toEqual([dedans, passeRecent, jourEntierBorne].sort());
    });

    it('un événement DÉPLACÉ hors fenêtre reste servi (il doit pouvoir disparaître du téléphone)', async () => {
      const id = await creer(bob, ga, { title: 'Déplacée', starts_at: '2027-03-20T18:00:00Z' });
      vieillir(id);
      expect(evenements(await lire())).toEqual([id]);
      // Elle est repoussée à 2029 : hors fenêtre, mais modifiée MAINTENANT (updated_at réel, après le début de la fenêtre).
      await bob.client.patch(`/api/groupes/${ga.groupId}/evenements/${id}`, { starts_at: '2029-03-20T18:00:00Z' });
      const r = await lire();
      expect(evenements(r)).toEqual([id]);
      expect(r.texte).toContain('DTSTART:20290320T180000Z');
    });

    it('un événement ANNULÉ hors fenêtre reste servi tant qu’il a été modifié depuis', async () => {
      const id = await creer(bob, ga, { title: 'Ancienne', starts_at: '2026-01-10T18:00:00Z' });
      expect(evenements(await lire())).toEqual([id]); // modifié maintenant : servi
      vieillir(id);
      expect(evenements(await lire())).toEqual([]); // plus modifié depuis : hors fenêtre
      await bob.client.delete(`/api/groupes/${ga.groupId}/evenements/${id}`);
      expect(evenements(await lire())).toEqual([id]);
    });
  });

  describe('include_declined', () => {
    async function monde(): Promise<{ oui: string; non: string; peutEtre: string; sansReponse: string }> {
      const ids = { oui: await creer(bob, ga, { title: 'Oui' }), non: await creer(bob, ga, { title: 'Non' }), peutEtre: await creer(bob, ga, { title: 'Peut-être' }), sansReponse: await creer(bob, ga, { title: 'Sans réponse' }) };
      await alice.client.put(`/api/groupes/${ga.groupId}/evenements/${ids.oui}/ma-presence`, { status: 'yes' });
      await alice.client.put(`/api/groupes/${ga.groupId}/evenements/${ids.non}/ma-presence`, { status: 'no' });
      await alice.client.put(`/api/groupes/${ga.groupId}/evenements/${ids.peutEtre}/ma-presence`, { status: 'maybe' });
      // Bob a refusé l'événement « Sans réponse » : ce refus-là n'est pas celui d'Alice, il ne doit rien masquer pour elle.
      await bob.client.put(`/api/groupes/${ga.groupId}/evenements/${ids.sansReponse}/ma-presence`, { status: 'no' });
      return ids;
    }

    it('par défaut (include_declined = 1), tout est servi', async () => {
      const ids = await monde();
      expect(evenements(await lire()).sort()).toEqual(Object.values(ids).sort());
    });

    it('à 0, omet SEULEMENT ce que j’ai refusé : « oui », « peut-être » et « pas de réponse » restent', async () => {
      const ids = await monde();
      const sans = (await alice.client.post('/api/moi/flux-ical', { include_declined: false })).corps['token'] as string;
      expect(evenements(await lire(sans)).sort()).toEqual([ids.oui, ids.peutEtre, ids.sansReponse].sort());
    });

    it('le refus d’un autre membre ne masque rien pour moi, et le mien ne masque rien pour lui', async () => {
      const ids = await monde();
      const deBob = (await bob.client.post('/api/moi/flux-ical', { include_declined: false })).corps['token'] as string;
      expect(evenements(await lire(deBob)).sort()).toEqual([ids.oui, ids.non, ids.peutEtre].sort());
    });

    it('un refus ne masque que dans SON groupe (les événements de l’autre groupe restent)', async () => {
      const ids = await monde();
      const autre = await creer(alice, gb, { title: 'Ailleurs' });
      const sans = (await alice.client.post('/api/moi/flux-ical', { include_declined: false })).corps['token'] as string;
      const servis = evenements(await lire(sans));
      expect(servis).toContain(autre);
      expect(servis).not.toContain(ids.non);
    });
  });

  describe('ETag et 304', () => {
    it('deux requêtes identiques : la seconde, avec If-None-Match, est un 304 sans corps', async () => {
      await creer(bob, ga, { title: 'Soirée' });
      const premiere = await lire();
      const etag = premiere.entetes['etag'] as string;
      const seconde = await lire(jeton, { 'If-None-Match': etag });
      expect(seconde.statut).toBe(304);
      expect(seconde.texte).toBe('');
      expect(seconde.entetes['etag']).toBe(etag);
      expect(seconde.entetes['cache-control']).toBe('private, max-age=300');
    });

    it('un 304 ne génère rien : il coûte des agrégats, pas la lecture des événements', async () => {
      await creer(bob, ga, { title: 'Soirée' });
      const etag = (await lire()).entetes['etag'] as string;
      expect(generations.n).toBe(2); // une lecture par groupe (A et B), pour le 200
      const avant = generations.n;
      expect((await lire(jeton, { 'If-None-Match': etag })).statut).toBe(304);
      expect(generations.n).toBe(avant);
      expect((await lire(jeton, { 'If-None-Match': '"autre"' })).statut).toBe(200);
      expect(generations.n).toBeGreaterThan(avant);
    });

    it('accepte une liste d’empreintes et la forme faible', async () => {
      const etag = (await lire()).entetes['etag'] as string;
      expect((await lire(jeton, { 'If-None-Match': `"zzz", W/${etag}` })).statut).toBe(304);
    });

    it('une MODIFICATION d’événement change l’ETag', async () => {
      const id = await creer(bob, ga, { title: 'Avant' });
      vieillir(id);
      const etag = (await lire()).entetes['etag'];
      await bob.client.patch(`/api/groupes/${ga.groupId}/evenements/${id}`, { title: 'Après' });
      const apres = await lire(jeton, { 'If-None-Match': etag as string });
      expect(apres.statut).toBe(200);
      expect(apres.entetes['etag']).not.toBe(etag);
    });

    it('une ANNULATION change l’ETag', async () => {
      const id = await creer(bob, ga, { title: 'Soirée' });
      vieillir(id);
      const etag = (await lire()).entetes['etag'];
      await bob.client.delete(`/api/groupes/${ga.groupId}/evenements/${id}`);
      const apres = await lire(jeton, { 'If-None-Match': etag as string });
      expect(apres.statut).toBe(200);
      expect(apres.entetes['etag']).not.toBe(etag);
      expect(apres.texte).toContain('STATUS:CANCELLED');
    });

    it('une création, un retrait de membre et un refus (include_declined = 0) changent l’ETag', async () => {
      const etag0 = (await lire()).entetes['etag'];
      const id = await creer(bob, ga, { title: 'Nouvelle' });
      const etag1 = (await lire()).entetes['etag'];
      expect(etag1).not.toBe(etag0);

      const sans = (await alice.client.post('/api/moi/flux-ical', { include_declined: false })).corps['token'] as string;
      const e2 = (await lire(sans)).entetes['etag'];
      await alice.client.put(`/api/groupes/${ga.groupId}/evenements/${id}/ma-presence`, { status: 'no' });
      const e3 = (await lire(sans)).entetes['etag'];
      expect(e3).not.toBe(e2);

      d.sql.prepare("UPDATE memberships SET status = 'removed', ended_at = ? WHERE group_id = ? AND user_id = ?").run('2026-11-16T00:00:00Z', ga.groupId, alice.userId);
      const e4 = (await lire()).entetes['etag'];
      expect(e4).not.toBe(etag1);
    });

    it('un renommage de groupe change l’ETag (le nom est dans les titres)', async () => {
      await creer(bob, ga, { title: 'Soirée' });
      const etag = (await lire()).entetes['etag'];
      await bob.client.patch(`/api/groupes/${ga.groupId}`, { name: 'La grande bande' });
      const apres = await lire(jeton, { 'If-None-Match': etag as string });
      expect(apres.statut).toBe(200);
      expect(apres.texte).toContain('[La grande bande]');
    });

    it('deux réponses ÉCHANGÉES (refus de A, accord pour B) changent l’ETag, même nombre d’événements et même updated_at maximal', async () => {
      // Flux d'Alice avec include_declined = 0 : A est servi, B masqué (elle l'a refusé), C est le plus récemment modifié.
      const a = await creer(bob, ga, { title: 'A', starts_at: '2027-03-01T18:00:00Z' });
      const b = await creer(bob, ga, { title: 'B', starts_at: '2027-03-02T18:00:00Z' });
      const c = await creer(bob, ga, { title: 'C', starts_at: '2027-03-03T18:00:00Z' });
      vieillir(a, '2026-01-01T00:00:00Z');
      vieillir(b, '2026-01-02T00:00:00Z');
      vieillir(c, '2026-01-03T00:00:00Z');
      const sans = (await alice.client.post('/api/moi/flux-ical', { include_declined: false })).corps['token'] as string;
      await alice.client.put(`/api/groupes/${ga.groupId}/evenements/${b}/ma-presence`, { status: 'no' });
      const avant = await lire(sans);
      expect(evenements(avant).sort()).toEqual([a, c].sort());
      const maxAvant = d.sql.prepare('SELECT max(updated_at) FROM events').pluck().get();

      // Entre deux interrogations : « non » à A, « oui » à B. Le flux devient {B, C}.
      await alice.client.put(`/api/groupes/${ga.groupId}/evenements/${a}/ma-presence`, { status: 'no' });
      await alice.client.put(`/api/groupes/${ga.groupId}/evenements/${b}/ma-presence`, { status: 'yes' });
      // Les présences ne touchent pas `events.updated_at` : le maximum est inchangé, le nombre aussi (deux événements servis).
      expect(d.sql.prepare('SELECT max(updated_at) FROM events').pluck().get()).toBe(maxAvant);

      const apres = await lire(sans, { 'If-None-Match': avant.entetes['etag'] as string });
      expect(apres.statut, 'un 304 ferait garder A au téléphone et ne montrerait jamais B').toBe(200);
      expect(apres.entetes['etag']).not.toBe(avant.entetes['etag']);
      expect(evenements(apres).sort()).toEqual([b, c].sort());
    });

    it('un changement de nom de l’organisateur (compte renommé ou anonymisé) change l’ETag et se propage', async () => {
      const id = await creer(bob, ga, { title: 'Soirée' });
      vieillir(id);
      const avant = await lire();
      expect(avant.texte).toContain('ORGANIZER;CN="bob_i"');
      d.sql.prepare("UPDATE users SET display_name = 'Compte supprimé' WHERE id = ?").run(bob.userId);
      const apres = await lire(jeton, { 'If-None-Match': avant.entetes['etag'] as string });
      expect(apres.statut).toBe(200);
      expect(apres.texte).toContain('ORGANIZER;CN="Compte supprimé"');
      expect(apres.texte).not.toContain('bob_i');
    });

    it('l’ETag dépend du jeton : celui d’un autre abonnement ne vaut pas 304', async () => {
      const autre = (await alice.client.post('/api/moi/flux-ical', {})).corps['token'] as string;
      const etag = (await lire()).entetes['etag'] as string;
      expect((await lire(autre, { 'If-None-Match': etag })).statut).toBe(200);
    });

    it('l’ETag change avec le jour (la fenêtre glisse)', async () => {
      const etag = (await lire()).entetes['etag'];
      d.temps.avancer(24 * 3_600_000);
      expect((await lire()).entetes['etag']).not.toBe(etag);
    });
  });

  describe('usage et cadence', () => {
    it('renseigne last_used_at et last_user_agent', async () => {
      await lire();
      const [a] = (await alice.client.get('/api/moi/flux-ical')).corps['abonnements'] as Array<{ last_used_at: string | null; last_user_agent: string | null }>;
      expect(a?.last_used_at).toBe('2026-11-15T12:00:00Z');
      expect(a?.last_user_agent).toBe('Test/1.0 (Appareil A)');
    });

    it('trace aussi un 304', async () => {
      const etag = (await lire()).entetes['etag'] as string;
      d.temps.avancer(60_000);
      await lire(jeton, { 'If-None-Match': etag });
      const [a] = (await alice.client.get('/api/moi/flux-ical')).corps['abonnements'] as Array<{ last_used_at: string }>;
      expect(a?.last_used_at).toBe('2026-11-15T12:01:00Z');
    });

    it('ne trace rien pour un jeton inconnu', async () => {
      await lire('a'.repeat(52));
      expect(d.sql.prepare('SELECT count(*) FROM calendar_feed_tokens WHERE last_used_at IS NOT NULL').pluck().get()).toBe(0);
    });

    it('au-delà de 60 requêtes dans l’heure : 429 avec Retry-After, puis le service reprend', async () => {
      for (let i = 1; i <= 60; i++) {
        const r = await lire();
        expect(r.statut, `requête ${String(i)}`).toBe(200);
      }
      const trop = await lire();
      expect(trop.statut).toBe(429);
      expect(trop.corps).toEqual({ error: 'cadence.depassee' });
      expect(Number(trop.entetes['retry-after'])).toBeGreaterThan(0);
      // L'abonnement d'à côté n'est pas touché : la cadence est PAR JETON.
      const autre = (await alice.client.post('/api/moi/flux-ical', {})).corps['token'] as string;
      expect((await lire(autre)).statut).toBe(200);
      d.temps.avancer(2 * 3_600_000);
      expect((await lire()).statut).toBe(200);
    });

    it('un jeton révoqué n’épuise rien et répond 404 même après des centaines d’essais', async () => {
      await alice.client.delete(`/api/moi/flux-ical/${idFlux}`);
      for (let i = 0; i < 70; i++) expect((await lire()).statut).toBe(404);
    });

    it('un compte suspendu : même 404 que pour un jeton inconnu', async () => {
      d.sql.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run('2026-11-15T13:00:00Z', alice.userId);
      const r = await lire();
      expect({ statut: r.statut, corps: r.corps }).toEqual({ statut: 404, corps: { error: 'flux.introuvable' } });
    });
  });
});
