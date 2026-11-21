import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEURE_MS, MINUTE_MS } from '../../server/domain/instant.js';
import { JOURNAL_SILENCIEUX, type Journal } from '../../server/http/middleware/journal.js';
import { OCTETS_MAX } from '../../server/services/agenda-externe.js';
import { REGLES_PAR_DEFAUT } from '../../server/services/cadence.js';
import { demarrerTaches, type Taches } from '../../server/services/taches.js';
import { secretFactice } from '../fixtures/env.js';
import { decor, groupe, personne, type Personne } from '../fixtures/groupes.js';
import type { Decor } from '../fixtures/comptes.js';
import { demarrerFauxAgenda, ICS_UN_EVENEMENT, ICS_VIDE, type FauxAgenda } from '../fixtures/faux-agenda.js';

// Synchronisation d'agenda ENTRANTE (ADR-0013) : routes /api/moi/agenda/sources, récupération contre un faux serveur ICS local, échecs, recul
// exponentiel et désactivation. Le cloisonnement (identifiant de source forgé) est dans tests/cloisonnement ; la boucle de rétroaction du flux
// sortant dans tests/unite/agenda-externe-flux.test.ts.

const SOURCES = '/api/moi/agenda/sources';

describe('agenda externe : synchronisation entrante', () => {
  let faux: FauxAgenda;
  let d: Decor;
  let alice: Personne;
  let journaux: Array<{ niveau: string; message: string; champs: unknown }>;
  const cle = secretFactice();

  const monter = async (surcharges: Partial<FauxAgenda['dependances']> = {}): Promise<void> => {
    d = decor({ agendaExterne: { ...faux.dependances, ...surcharges }, journal: journalDeTest() }, { ATTROUPE_ENCRYPTION_KEY: cle });
    alice = await personne(d, 'alice_ag');
  };
  const journalDeTest = (): Journal => ({
    ...JOURNAL_SILENCIEUX,
    info: (message, champs) => journaux.push({ niveau: 'info', message, champs }),
    warn: (message, champs) => journaux.push({ niveau: 'warn', message, champs }),
    error: (message, champs) => journaux.push({ niveau: 'error', message, champs }),
  });

  beforeEach(async () => {
    journaux = [];
    faux = await demarrerFauxAgenda();
    await monter();
  });
  afterEach(async () => {
    d.nettoyer();
    await faux.arreter();
  });

  const creer = async (url: string = faux.url, corps: Record<string, unknown> = {}) => alice.client.post(SOURCES, { url, ...corps });
  const ligneSource = (id: string): Record<string, unknown> => d.sql.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(id) as Record<string, unknown>;
  const importes = (id: string): Array<{ id: string; starts_at: string; title: string; description: string | null; location_name: string | null }> =>
    d.sql.prepare('SELECT id, starts_at, title, description, location_name FROM personal_events WHERE calendar_source_id = ? ORDER BY starts_at').all(id) as never;
  const resynchroniser = async (id: string) => {
    d.temps.avancer(6 * MINUTE_MS); // la synchronisation à la demande est limitée à une fois par 5 min
    return alice.client.post(`${SOURCES}/${id}/synchronisation`);
  };

  describe('création', () => {
    it('201 : synchronise tout de suite, n’écrit que des plages (jamais un texte) et ne rend jamais l’URL', async () => {
      const r = await creer();
      expect(r.statut, JSON.stringify(r.corps)).toBe(201);
      expect(r.corps).toMatchObject({
        label: 'agenda.exemple.org',
        url_host: 'agenda.exemple.org',
        last_status: 'ok',
        consecutive_failures: 0,
        slots_imported: 1,
        disabled_at: null,
        synchronisation: { statut: 'ok', creneaux_importes: 1, ignores: 0, modifiee: true, desactivee: false },
      });
      const id = r.corps['id'] as string;
      expect(importes(id)).toEqual([{ id: expect.any(String), starts_at: '2026-11-20T10:00:00Z', title: '', description: null, location_name: null }]);
      // L'URL (secret porteur) ne sort ni en clair ni chiffrée, ni à la création ni dans la liste ; les validateurs HTTP non plus.
      const liste = await alice.client.get(SOURCES);
      for (const sortie of [JSON.stringify(r.corps), JSON.stringify(liste.corps)]) {
        expect(sortie).not.toContain('calendrier.ics');
        expect(sortie).not.toContain('prive');
        expect(sortie).not.toMatch(/url_cipher|url_nonce|url_fingerprint|http_etag|http_last_modified/);
        expect(sortie).not.toContain('Secret médical');
      }
      expect((liste.corps['sources'] as unknown[]).length).toBe(1);
      // En base, l'URL est chiffrée (ADR-0013 §7), pas lisible dans le fichier.
      expect(Buffer.from(ligneSource(id)['url_cipher'] as Buffer).toString('utf8')).not.toContain('calendrier.ics');
    });

    it('envoie la requête en https sur l’hôte saisi, avec Accept-Encoding: identity et sans validateur la première fois', async () => {
      await creer();
      expect(faux.urlsDemandees).toEqual([faux.url]);
      expect(faux.appels).toHaveLength(1);
      expect(faux.appels[0]?.entetes['accept-encoding']).toBe('identity');
      expect(faux.appels[0]?.entetes['if-none-match']).toBeUndefined();
      expect(faux.appels[0]?.entetes['if-modified-since']).toBeUndefined();
    });

    it('webcal:// est accepté et normalisé en https://', async () => {
      const r = await creer(faux.url.replace('https://', 'webcal://'));
      expect(r.statut, JSON.stringify(r.corps)).toBe(201);
      expect(faux.urlsDemandees).toEqual([faux.url]);
    });

    it('un libellé fourni est conservé (rogné) ; un libellé vide ou trop long est refusé en 400', async () => {
      expect((await creer(faux.url, { label: '  Mon Google  ' })).corps).toMatchObject({ label: 'Mon Google' });
      for (const label of ['', '   ', 'x'.repeat(61)]) {
        expect((await creer(`${faux.url}?l=${label.length}`, { label })).statut, JSON.stringify(label)).toBe(400);
      }
    });

    it('toute URL de forme refusée donne LA MÊME réponse 400 `source.url_invalide`, sans requête sortante ni écriture', async () => {
      const refusees = [
        'http://agenda.exemple.org/a.ics',
        'ftp://agenda.exemple.org/a.ics',
        'https://agenda.exemple.org:8443/a.ics',
        'https://agenda.exemple.org:80/a.ics',
        'https://alice:secret@agenda.exemple.org/a.ics',
        'https://alice@agenda.exemple.org/a.ics',
        'webcal://alice:secret@agenda.exemple.org/a.ics',
        'webcal://agenda.exemple.org:8080/a.ics',
        'file:///etc/passwd',
        'javascript:alert(1)',
        'pas une url',
        'https://',
        '',
        '   ',
        `https://agenda.exemple.org/${'a'.repeat(2100)}`,
      ];
      // Quinze essais : le seuil de cadence (10 par quart d’heure) est relevé pour ne juger ici que la forme.
      d.nettoyer();
      d = decor({ agendaExterne: faux.dependances, regles: { ...REGLES_PAR_DEFAUT, import_agenda: { compte: { max: 100, fenetreMs: 900_000 }, ip: { max: 100, fenetreMs: 900_000 }, reseau: { max: 100, fenetreMs: 900_000 } } } }, { ATTROUPE_ENCRYPTION_KEY: cle });
      alice = await personne(d, 'alice_forme');
      for (const url of refusees) {
        const r = await alice.client.post(SOURCES, { url });
        expect({ url: url.slice(0, 60), statut: r.statut, corps: r.corps }).toEqual({ url: url.slice(0, 60), statut: 400, corps: { error: 'source.url_invalide' } });
      }
      expect(faux.appels).toHaveLength(0);
      expect(d.sql.prepare('SELECT count(*) FROM calendar_sources').pluck().get()).toBe(0);
    });

    it('une adresse privée n’est jamais jointe : 201 mais `refuse`, sans aucun envoi (autoriserPrive: false en dur)', async () => {
      // Le décor SANS double : le vrai DNS n’est pas sollicité pour une IP littérale, la vérification d’adresse est la vraie.
      d.nettoyer();
      d = decor({}, { ATTROUPE_ENCRYPTION_KEY: cle });
      alice = await personne(d, 'alice_prive');
      for (const [i, hote] of ['127.0.0.1', '10.0.0.5', '192.168.1.10', '169.254.169.254', '[::1]'].entries()) {
        const r = await alice.client.post(SOURCES, { url: `https://${hote}/a.ics` });
        expect(r.statut, `${hote} : ${JSON.stringify(r.corps)}`).toBe(201);
        expect(r.corps, hote).toMatchObject({ last_status: 'refuse', slots_imported: 0, synchronisation: { statut: 'refuse' } });
        expect(i).toBeGreaterThanOrEqual(0);
      }
      expect(faux.appels).toHaveLength(0);
    });

    it('409 `source.deja_presente` pour la même URL (webcal et https confondus), 409 `source.plafond` au sixième', async () => {
      expect((await creer()).statut).toBe(201);
      for (const url of [faux.url, faux.url.replace('https://', 'webcal://'), `${faux.url}#fragment`]) {
        const doublon = await creer(url);
        expect(doublon.statut).toBe(409);
        expect(doublon.corps).toEqual({ error: 'source.deja_presente' });
      }
      for (let i = 2; i <= 5; i++) expect((await creer(`${faux.url}?n=${String(i)}`)).statut).toBe(201);
      const sixieme = await creer(`${faux.url}?n=6`);
      expect(sixieme.statut).toBe(409);
      expect(sixieme.corps).toEqual({ error: 'source.plafond' });
      expect(d.sql.prepare('SELECT count(*) FROM calendar_sources').pluck().get()).toBe(5);
    });

    it('les partages suivent le réglage de compte, mais `details` est ramené à `busy`', async () => {
      await groupe(d, 'Groupe Agenda', [{ personne: alice, role: 'admin' }]);
      d.sql.prepare("UPDATE users SET personal_agenda_visibility = 'details' WHERE id = ?").run(alice.userId);
      const r = await creer();
      expect(r.statut).toBe(201);
      const partages = d.sql.prepare('SELECT visibility FROM personal_event_shares').pluck().all();
      expect(partages).toEqual(['busy']);
    });

    it('cadence : au-delà de 10 créations par compte et par quart d’heure, 429', async () => {
      let dernier = 201;
      for (let i = 0; i < 11; i++) {
        // Une adresse privée par appel : aucune requête sortante, seul le compteur nous intéresse (et le plafond de 5 sources aussi, d’où le 409).
        dernier = (await alice.client.post(SOURCES, { url: 'ftp://refuse' })).statut;
      }
      expect(dernier).toBe(429);
    });
  });

  describe('récupération', () => {
    it('304 : aucune écriture de créneaux, validateurs renvoyés, dernier statut conservé', async () => {
      const id = (await creer()).corps['id'] as string;
      const avant = d.sql.prepare('SELECT id, updated_at FROM personal_events WHERE calendar_source_id = ?').all(id);
      faux.reponse = { statut: 304, corps: '', entetes: { etag: '"v1"' } };
      const r = await resynchroniser(id);
      expect(r.statut, JSON.stringify(r.corps)).toBe(200);
      expect(r.corps).toMatchObject({ last_status: 'ok', slots_imported: 1, synchronisation: { statut: 'ok', creneaux_importes: 1, modifiee: false } });
      expect(faux.appels.at(-1)?.entetes['if-none-match']).toBe('"v1"');
      // Mêmes lignes, mêmes identifiants, mêmes horodatages : rien n’a été réécrit.
      expect(d.sql.prepare('SELECT id, updated_at FROM personal_events WHERE calendar_source_id = ?').all(id)).toEqual(avant);
      expect(ligneSource(id)).toMatchObject({ consecutive_failures: 0, http_etag: '"v1"', last_success_at: '2026-11-15T12:06:00Z' });
    });

    it('envoie If-Modified-Since quand le serveur n’a donné que Last-Modified', async () => {
      faux.reponse = { statut: 200, corps: ICS_UN_EVENEMENT, entetes: { 'last-modified': 'Sat, 14 Nov 2026 08:00:00 GMT' } };
      const id = (await creer()).corps['id'] as string;
      await resynchroniser(id);
      expect(faux.appels.at(-1)?.entetes['if-modified-since']).toBe('Sat, 14 Nov 2026 08:00:00 GMT');
      expect(faux.appels.at(-1)?.entetes['if-none-match']).toBeUndefined();
    });

    it('un contenu qui change remplace le lot entier (un événement supprimé disparaît)', async () => {
      const id = (await creer()).corps['id'] as string;
      expect(importes(id)).toHaveLength(1);
      faux.reponse = { statut: 200, corps: ICS_UN_EVENEMENT.replace('20261120T100000Z', '20261125T100000Z').replace('20261120T110000Z', '20261125T110000Z'), entetes: { etag: '"v2"' } };
      const r = await resynchroniser(id);
      expect(r.corps).toMatchObject({ synchronisation: { modifiee: true, creneaux_importes: 1 } });
      expect(importes(id).map((c) => c.starts_at)).toEqual(['2026-11-25T10:00:00Z']);
    });

    it('trop gros : abandonné au seuil, sans croire le Content-Length, et les créneaux restent', async () => {
      const id = (await creer()).corps['id'] as string;
      let ecrits = 0;
      faux.gestionnaire = (_req, res) => {
        // Content-Length MENTEUR (petit) : seul le compteur d’octets réel compte. Puis un flot sans fin, tant que le client écoute.
        res.writeHead(200, { 'content-type': 'text/calendar' });
        const flot = setInterval(() => {
          if (res.destroyed || res.writableEnded) return clearInterval(flot);
          for (let i = 0; i < 64; i++) {
            ecrits += 16 * 1024;
            res.write(Buffer.alloc(16 * 1024, 0x41));
          }
          return undefined;
        }, 1);
        res.on('close', () => clearInterval(flot));
      };
      const r = await resynchroniser(id);
      expect(r.corps).toMatchObject({ last_status: 'trop_gros', consecutive_failures: 1, synchronisation: { statut: 'trop_gros', modifiee: false } });
      expect(importes(id)).toHaveLength(1);
      expect(ecrits).toBeGreaterThan(OCTETS_MAX);
      expect(ecrits).toBeLessThan(OCTETS_MAX * 32);
    });

    it('exactement 1 Mio est lu (illisible, pas trop gros) ; 1 Mio + 1 octet est refusé comme trop gros', async () => {
      const id = (await creer()).corps['id'] as string;
      faux.reponse = { statut: 200, corps: Buffer.alloc(OCTETS_MAX, 0x41), entetes: {} };
      expect((await resynchroniser(id)).corps).toMatchObject({ last_status: 'illisible' });
      faux.reponse = { statut: 200, corps: Buffer.alloc(OCTETS_MAX + 1, 0x41), entetes: {} };
      expect((await resynchroniser(id)).corps).toMatchObject({ last_status: 'trop_gros' });
    });

    it('illisible : un corps qui n’est pas de l’iCalendar, et une bombe gzip (jamais décompressée) arrivent comme des octets illisibles', async () => {
      const id = (await creer()).corps['id'] as string;
      faux.reponse = { statut: 200, corps: '<html>Connectez-vous</html>', entetes: {} };
      expect((await resynchroniser(id)).corps).toMatchObject({ last_status: 'illisible', slots_imported: 1 });
      faux.reponse = { statut: 200, corps: gzipSync(Buffer.from(ICS_UN_EVENEMENT)), entetes: { 'content-encoding': 'gzip' } };
      expect((await resynchroniser(id)).corps).toMatchObject({ last_status: 'illisible' });
      expect(importes(id)).toHaveLength(1);
    });

    it('vide : un ICS valide sans aucun VEVENT est appliqué tel quel (les créneaux disparaissent) et journalisé', async () => {
      const id = (await creer()).corps['id'] as string;
      faux.reponse = { statut: 200, corps: ICS_VIDE, entetes: { etag: '"vide"' } };
      const r = await resynchroniser(id);
      expect(r.corps).toMatchObject({ last_status: 'vide', consecutive_failures: 0, slots_imported: 0, synchronisation: { statut: 'vide', creneaux_importes: 0, modifiee: true } });
      expect(importes(id)).toHaveLength(0);
      expect(journaux).toContainEqual({ niveau: 'warn', message: 'agenda.import_vide', champs: { source: id } });
    });

    it('401, 403, 404, 410 : `refuse` ; 500, 503, 429 et une redirection non suivie : `injoignable` — créneaux conservés', async () => {
      const id = (await creer()).corps['id'] as string;
      for (const [statut, attendu] of [[401, 'refuse'], [403, 'refuse'], [404, 'refuse'], [410, 'refuse'], [500, 'injoignable'], [503, 'injoignable'], [429, 'injoignable'], [302, 'injoignable']] as const) {
        faux.reponse = { statut, corps: '', entetes: statut === 302 ? { location: 'https://ailleurs.exemple.org/x.ics' } : {} };
        const r = await resynchroniser(id);
        expect(r.corps, String(statut)).toMatchObject({ last_status: attendu });
        // Une source `refuse` finirait désactivée, ce qui ne se resynchronise pas… à la demande si : on la réactive entre deux essais.
        await alice.client.patch(`${SOURCES}/${id}`, { disabled: false });
      }
      expect(faux.appels.every((a) => a.chemin === '/prive/calendrier.ics')).toBe(true); // la redirection n’a pas été suivie
      expect(importes(id)).toHaveLength(1);
    });

    it('inactivité réseau et budget total : coupés, `injoignable`', async () => {
      d.nettoyer();
      await faux.arreter();
      faux = await demarrerFauxAgenda();
      await monter({ inactiviteMs: 150, budgetMs: 400 });
      const id = (await creer()).corps['id'] as string;
      // Muet : aucune réponse, jamais.
      faux.gestionnaire = () => undefined;
      const muet = await resynchroniser(id);
      expect(muet.corps).toMatchObject({ last_status: 'injoignable' });
      // Goutte à goutte : chaque octet remet l’inactivité à zéro, c’est le budget total qui coupe.
      faux.gestionnaire = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/calendar' });
        const goutte = setInterval(() => res.write('X'), 50);
        res.on('close', () => clearInterval(goutte));
      };
      const debut = Date.now();
      const lent = await resynchroniser(id);
      expect(lent.corps).toMatchObject({ last_status: 'injoignable' });
      expect(Date.now() - debut).toBeLessThan(3000);
    });
  });

  describe('synchronisation à la demande', () => {
    it('limitée à une fois par 5 minutes et par source : 429 avec Retry-After, rien n’est envoyé', async () => {
      const id = (await creer()).corps['id'] as string;
      const appels = faux.appels.length;
      d.temps.avancer(2 * MINUTE_MS);
      const trop_tot = await alice.client.post(`${SOURCES}/${id}/synchronisation`);
      expect(trop_tot.statut).toBe(429);
      expect(trop_tot.corps).toEqual({ error: 'cadence.depassee' });
      expect(trop_tot.entetes['retry-after']).toBe('180');
      expect(faux.appels).toHaveLength(appels);
      d.temps.avancer(3 * MINUTE_MS);
      expect((await alice.client.post(`${SOURCES}/${id}/synchronisation`)).statut).toBe(200);
      expect(faux.appels).toHaveLength(appels + 1);
    });

    it('une source désactivée se reprend à la main : un succès la réactive', async () => {
      const id = (await creer()).corps['id'] as string;
      d.sql.prepare("UPDATE calendar_sources SET disabled_at = '2026-11-15T12:00:00Z', consecutive_failures = 10, last_status = 'refuse' WHERE id = ?").run(id);
      const r = await resynchroniser(id);
      expect(r.corps).toMatchObject({ disabled_at: null, consecutive_failures: 0, last_status: 'ok' });
    });
  });

  describe('modification et suppression', () => {
    it('PATCH : libellé ; désactiver puis réactiver (compteur remis à zéro, essai immédiat) ; corps vide ou champ inconnu : 400', async () => {
      const id = (await creer()).corps['id'] as string;
      expect((await alice.client.patch(`${SOURCES}/${id}`, { label: 'Perso' })).corps).toMatchObject({ label: 'Perso' });
      const off = await alice.client.patch(`${SOURCES}/${id}`, { disabled: true });
      expect(off.corps['disabled_at']).toBeTypeOf('string');
      d.sql.prepare('UPDATE calendar_sources SET consecutive_failures = 4 WHERE id = ?').run(id);
      const on = await alice.client.patch(`${SOURCES}/${id}`, { disabled: false });
      expect(on.corps).toMatchObject({ disabled_at: null, consecutive_failures: 0, next_attempt_at: '2026-11-15T12:00:00Z' });
      for (const corps of [{}, { label: '' }, { url: 'https://autre.exemple.org/x.ics' }, { disabled: 'oui' }, { last_status: 'ok' }]) {
        expect((await alice.client.patch(`${SOURCES}/${id}`, corps)).statut, JSON.stringify(corps)).toBe(400);
      }
    });

    it('DELETE : la source et ses créneaux importés partent ensemble ; les créneaux saisis à la main restent', async () => {
      const manuel = (await alice.client.post('/api/moi/agenda', { title: 'Dentiste', starts_at: '2026-11-20T09:00:00Z', time_zone: 'Europe/Paris' })).corps['id'];
      const id = (await creer()).corps['id'] as string;
      expect(importes(id)).toHaveLength(1);
      expect((await alice.client.delete(`${SOURCES}/${id}`)).statut).toBe(200);
      expect(d.sql.prepare('SELECT count(*) FROM calendar_sources').pluck().get()).toBe(0);
      expect(d.sql.prepare('SELECT id FROM personal_events WHERE deleted_at IS NULL').pluck().all()).toEqual([manuel]);
      expect(d.sql.prepare('SELECT count(*) FROM personal_event_shares').pluck().get()).toBe(0);
      expect((await alice.client.delete(`${SOURCES}/${id}`)).corps).toEqual({ error: 'source.introuvable' });
    });
  });

  describe('créneaux importés dans l’agenda personnel', () => {
    it('409 `agenda.creneau_importe` pour modifier ou supprimer un créneau importé (jamais une SqliteError)', async () => {
      await groupe(d, 'Groupe Agenda', [{ personne: alice, role: 'admin' }]);
      const sourceId = (await creer()).corps['id'] as string;
      const creneau = importes(sourceId)[0]?.id ?? '';
      const modif = await alice.client.patch(`/api/moi/agenda/${creneau}`, { title: 'Renommé' });
      expect(modif.statut).toBe(409);
      expect(modif.corps).toEqual({ error: 'agenda.creneau_importe' });
      const suppr = await alice.client.delete(`/api/moi/agenda/${creneau}`);
      expect(suppr.statut).toBe(409);
      expect(suppr.corps).toEqual({ error: 'agenda.creneau_importe' });
      expect(importes(sourceId)[0]?.title).toBe('');
    });

    it('un ami du groupe voit « occupé » sans aucun titre, ni description, ni lieu', async () => {
      const carole = await personne(d, 'carole_ag');
      const g = await groupe(d, 'Groupe Agenda', [{ personne: alice, role: 'admin' }, { personne: carole, role: 'member' }]);
      await creer();
      const r = await carole.client.get(`/api/groupes/${g.groupId}/disponibilites?du=2026-11-01&au=2026-12-31`);
      expect(r.statut, JSON.stringify(r.corps)).toBe(200);
      const dispo = (r.corps['disponibilites'] ?? r.corps['creneaux']) as Array<Record<string, unknown>>;
      expect(dispo).toHaveLength(1);
      expect(dispo[0]).toMatchObject({ visibility: 'busy', title: null, description: null, location_name: null });
      expect(JSON.stringify(r.corps)).not.toContain('Secret médical');
    });
  });

  describe('flux iCal sortant', () => {
    it('le flux d’abonnement n’expose jamais un créneau importé (boucle de rétroaction), ni son titre d’origine', async () => {
      await alice.client.post('/api/moi/agenda', { title: 'Dentiste', starts_at: '2026-11-20T09:00:00Z', ends_at: '2026-11-20T09:30:00Z', time_zone: 'Europe/Paris' });
      await creer();
      const flux = await alice.client.post('/api/moi/flux-ical', { label: 'Téléphone', include_personal: true, include_declined: true });
      const jeton = flux.corps['token'] as string;
      const lu = await d.client('198.51.100.9').get(`/ical/${jeton}.ics`);
      expect(lu.statut, lu.texte).toBe(200);
      expect(lu.texte).toContain('Dentiste');
      expect(lu.texte).not.toContain('20261120T100000Z');
      expect(lu.texte).not.toContain('Secret médical');
    });
  });

  describe('tâche de fond', () => {
    let taches: Taches | undefined;
    afterEach(async () => {
      await taches?.arreter();
      taches = undefined;
    });

    const demarrer = (options: { cle?: string | undefined; intervalleImportMs?: number } = {}): Taches => {
      taches = demarrerTaches({
        base: d.base,
        transporteur: undefined,
        journal: journalDeTest(),
        baseUrl: 'https://attroupe.test',
        horloge: d.temps.horloge,
        intervalleFileMs: 3_600_000,
        intervalleImportMs: options.intervalleImportMs ?? 3_600_000,
        agendaExterne: faux.dependances,
        ...('cle' in options ? { cleChiffrement: options.cle } : { cleChiffrement: cle }),
      });
      return taches;
    };
    const tour = async (t: Taches, avanceMs = 3 * HEURE_MS): Promise<void> => {
      d.temps.avancer(avanceMs);
      await t.importerMaintenant();
    };

    it('ne synchronise rien avant l’échéance (2 h), puis un 304 ne réécrit rien et ne fait pas de bruit', async () => {
      const id = (await creer()).corps['id'] as string;
      const t = demarrer();
      journaux.length = 0;
      const appels = faux.appels.length;
      await tour(t, HEURE_MS);
      expect(faux.appels).toHaveLength(appels);
      faux.reponse = { statut: 304, corps: '', entetes: {} };
      const avant = d.sql.prepare('SELECT id FROM personal_events WHERE calendar_source_id = ?').all(id);
      await tour(t, 2 * HEURE_MS);
      expect(faux.appels).toHaveLength(appels + 1);
      expect(faux.appels.at(-1)?.entetes['if-none-match']).toBe('"v1"');
      expect(d.sql.prepare('SELECT id FROM personal_events WHERE calendar_source_id = ?').all(id)).toEqual(avant);
      expect(journaux.filter((j) => j.message.startsWith('agenda.import'))).toEqual([]);
    });

    it('un changement est importé et un bilan `agenda.import` est journalisé', async () => {
      await creer();
      const t = demarrer();
      journaux.length = 0;
      faux.reponse = { statut: 200, corps: ICS_VIDE.replace('END:VCALENDAR', 'BEGIN:VEVENT\r\nDTSTART:20261201T100000Z\r\nDTEND:20261201T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR'), entetes: { etag: '"v2"' } };
      await tour(t);
      expect(journaux).toContainEqual({ niveau: 'info', message: 'agenda.import', champs: { sources: 1, importees: 1, inchangees: 0, echecs: 0, desactivees: 0, erreurs: 0 } });
    });

    it('au plus 3 sources par tour, l’une après l’autre', async () => {
      for (let i = 0; i < 5; i++) await creer(`${faux.url}?n=${String(i)}`);
      const t = demarrer();
      const avant = faux.appels.length;
      await tour(t);
      expect(faux.appels.length - avant).toBe(3);
      await t.importerMaintenant();
      expect(faux.appels.length - avant).toBe(5);
    });

    it('pas de chevauchement : un fournisseur lent ne fait pas empiler les tours', async () => {
      await creer();
      d.temps.avancer(3 * HEURE_MS);
      faux.gestionnaire = (_req, res) => {
        setTimeout(() => res.writeHead(200, { 'content-type': 'text/calendar' }).end(ICS_UN_EVENEMENT), 400);
      };
      const avant = faux.appels.length;
      const t = demarrer({ intervalleImportMs: 20 });
      await new Promise((resolu) => setTimeout(resolu, 300));
      expect(faux.appels.length - avant).toBe(1);
      await t.arreter();
    });

    it('sans clé de chiffrement, l’import n’a pas lieu', async () => {
      await creer();
      const t = demarrer({ cle: undefined });
      const avant = faux.appels.length;
      await tour(t);
      expect(faux.appels).toHaveLength(avant);
    });

    it('échec : créneaux conservés, recul 2 h × 2^(n−1) plafonné à 24 h, désactivation à la 10e', async () => {
      const id = (await creer()).corps['id'] as string;
      const t = demarrer();
      faux.reponse = { statut: 500, corps: '', entetes: {} };
      const attendus = [2, 4, 8, 16, 24, 24, 24, 24, 24];
      for (const [i, heures] of attendus.entries()) {
        await tour(t, 25 * HEURE_MS);
        const ligne = ligneSource(id);
        expect(ligne['consecutive_failures'], `échec ${String(i + 1)}`).toBe(i + 1);
        expect(ligne['last_status']).toBe('injoignable');
        expect(Date.parse(ligne['next_attempt_at'] as string) - Date.parse(ligne['last_attempt_at'] as string)).toBe(heures * HEURE_MS);
        expect(ligne['disabled_at'], `échec ${String(i + 1)}`).toBeNull();
        expect(importes(id), 'les créneaux déjà importés sont conservés').toHaveLength(1);
      }
      await tour(t, 25 * HEURE_MS);
      const finale = ligneSource(id);
      expect(finale['consecutive_failures']).toBe(10);
      expect(finale['disabled_at']).toBeTypeOf('string');
      expect(importes(id)).toHaveLength(1);
      // Désactivée : plus jamais sélectionnée.
      const appels = faux.appels.length;
      await tour(t, 48 * HEURE_MS);
      expect(faux.appels).toHaveLength(appels);
    });

    it('un succès remet le compteur d’échecs à zéro', async () => {
      const id = (await creer()).corps['id'] as string;
      const t = demarrer();
      faux.reponse = { statut: 500, corps: '', entetes: {} };
      await tour(t);
      await tour(t, 5 * HEURE_MS);
      expect(ligneSource(id)['consecutive_failures']).toBe(2);
      faux.reponse = { statut: 200, corps: ICS_UN_EVENEMENT, entetes: { etag: '"v3"' } };
      await tour(t, 5 * HEURE_MS);
      expect(ligneSource(id)).toMatchObject({ consecutive_failures: 0, last_status: 'ok', disabled_at: null });
    });

    it('`refuse` (URL révoquée) : désactivée dès la 3e, pas la 10e', async () => {
      const id = (await creer()).corps['id'] as string;
      const t = demarrer();
      faux.reponse = { statut: 410, corps: '', entetes: {} };
      for (let i = 1; i <= 2; i++) {
        await tour(t, 25 * HEURE_MS);
        expect(ligneSource(id)).toMatchObject({ consecutive_failures: i, last_status: 'refuse', disabled_at: null });
      }
      await tour(t, 25 * HEURE_MS);
      expect(ligneSource(id)).toMatchObject({ consecutive_failures: 3, last_status: 'refuse' });
      expect(ligneSource(id)['disabled_at']).toBeTypeOf('string');
      expect(importes(id)).toHaveLength(1);
    });

    it('clé maîtresse changée : `cle_illisible`, désactivée tout de suite, aucune requête, créneaux conservés', async () => {
      const id = (await creer()).corps['id'] as string;
      const t = demarrer({ cle: secretFactice() });
      const avant = faux.appels.length;
      await tour(t);
      expect(faux.appels).toHaveLength(avant);
      expect(ligneSource(id)).toMatchObject({ last_status: 'cle_illisible', consecutive_failures: 1 });
      expect(ligneSource(id)['disabled_at']).toBeTypeOf('string');
      expect(importes(id)).toHaveLength(1);
    });
  });
});
