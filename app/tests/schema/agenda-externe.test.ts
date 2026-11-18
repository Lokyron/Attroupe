import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { creerPorteeUtilisateur } from '../../server/db/portee-utilisateur.js';
import {
  creerSource,
  listerMesSources,
  lireSource,
  lireUrlSource,
  modifierSource,
  remplacerCreneauxImportes,
  sourcesAFaire,
  supprimerSource,
  type PlageImportee,
} from '../../server/db/queries/agenda-externe.js';
import { diagnostiquer, PORTEE_TABLES } from '../../server/db/sql.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';

// Agenda externe entrant (migration 0004) : les invariants tiennent DANS la base (CHECK, déclencheurs), quel que soit le chemin
// d'écriture, et la couche de requêtes ne s'appuie pas sur eux pour réussir.

const T0 = '2026-01-01T00:00:00Z';
const CLE = randomBytes(32).toString('base64');
const URL_SECRETE = 'https://calendar.google.com/calendar/ical/secret%40exemple.test/private-abcdef/basic.ics';

const PLAGE: PlageImportee = { starts_at: '2027-03-01T09:00:00Z', ends_at: '2027-03-01T10:00:00Z', all_day: false, time_zone: 'UTC' };

describe('agenda externe : base et requêtes', () => {
  let t: BaseTemporaire;
  let d: DeuxGroupes;
  let n = 0;

  beforeAll(() => {
    t = baseTemporaire();
    d = deuxGroupes(t.base);
  });
  afterAll(() => t.nettoyer());

  /** Source insérée en SQL brut (hors couche de requêtes) : les invariants sont testés sur la base seule. */
  const sourceBrute = (userId: string): string => {
    n += 1;
    const id = `src-brute-${String(n)}`;
    t.sql
      .prepare(
        `INSERT INTO calendar_sources (id, user_id, label, url_cipher, url_nonce, url_host, url_fingerprint, created_at, updated_at, next_attempt_at)
         VALUES (?, ?, 'Perso', x'00', x'00', 'exemple.test', ?, ?, ?, ?)`,
      )
      .run(id, userId, `empreinte-${String(n)}`, T0, T0, T0);
    return id;
  };

  const creneauBrut = (userId: string, sourceId: string | null, titre = ''): string => {
    n += 1;
    const id = `pe-${String(n)}`;
    t.sql
      .prepare(
        `INSERT INTO personal_events (id, user_id, title, all_day, starts_at, ends_at, time_zone, created_at, updated_at, calendar_source_id)
         VALUES (?, ?, ?, 0, '2027-03-01T09:00:00Z', '2027-03-01T10:00:00Z', 'UTC', ?, ?, ?)`,
      )
      .run(id, userId, titre, T0, T0, sourceId);
    return id;
  };

  const partage = (creneauId: string, visibilite: string): void => {
    t.sql
      .prepare('INSERT INTO personal_event_shares (personal_event_id, membership_id, group_id, visibility, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(creneauId, d.a.membershipId, d.a.groupId, visibilite, T0);
  };

  describe('schéma', () => {
    it('le CHECK est porté par la colonne calendar_source_id, pas interprété comme une colonne', () => {
      const sqlTable = t.sql.prepare("SELECT sql FROM sqlite_master WHERE name = 'personal_events'").pluck().get() as string;
      expect(sqlTable).toMatch(/calendar_source_id TEXT REFERENCES calendar_sources \(id\) ON DELETE CASCADE\s+CHECK \(calendar_source_id IS NULL OR/);
      const colonnes = t.sql.prepare('SELECT name FROM pragma_table_info(?)').pluck().all('personal_events') as string[];
      expect(colonnes.filter((c) => c === 'calendar_source_id')).toHaveLength(1);
      expect(colonnes).not.toContain('CHECK');
    });

    it('les trois déclencheurs et les index existent', () => {
      const declencheurs = t.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").pluck().all();
      expect(declencheurs).toEqual(
        expect.arrayContaining(['trg_pes_import_sans_details_insert', 'trg_pes_import_sans_details_update', 'trg_personal_events_suppression_douce']),
      );
      const index = t.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").pluck().all();
      expect(index).toEqual(expect.arrayContaining(['idx_calendar_sources_user', 'idx_calendar_sources_due', 'idx_personal_events_source']));
    });

    it('les contraintes de calendar_sources refusent un libellé vide, un statut inconnu et un doublon d’empreinte', () => {
      const insere = (valeurs: { label?: string; statut?: string | null; empreinte?: string }): void => {
        n += 1;
        t.sql
          .prepare(
            `INSERT INTO calendar_sources (id, user_id, label, url_cipher, url_nonce, url_host, url_fingerprint, created_at, updated_at, next_attempt_at, last_status)
             VALUES (?, ?, ?, x'00', x'00', 'h', ?, ?, ?, ?, ?)`,
          )
          .run(`src-c-${String(n)}`, d.a.userId, valeurs.label ?? 'ok', valeurs.empreinte ?? `e-${String(n)}`, T0, T0, T0, valeurs.statut ?? null);
      };
      expect(() => insere({ label: '' })).toThrow(/CHECK/);
      expect(() => insere({ statut: 'inconnu' })).toThrow(/CHECK/);
      insere({ empreinte: 'meme' });
      expect(() => insere({ empreinte: 'meme' })).toThrow(/UNIQUE/);
    });
  });

  describe('CHECK : un créneau importé ne porte aucun texte', () => {
    it('refuse un titre à l’INSERT', () => {
      const s = sourceBrute(d.a.userId);
      expect(() => creneauBrut(d.a.userId, s, 'Rendez-vous médecin')).toThrow(/CHECK/);
    });

    it('refuse un titre, une description, un lieu ou une récurrence à l’UPDATE après coup', () => {
      const s = sourceBrute(d.a.userId);
      const id = creneauBrut(d.a.userId, s);
      for (const colonne of ['title', 'description', 'location_name', 'recurrence_rule']) {
        expect(() => t.sql.prepare(`UPDATE personal_events SET ${colonne} = 'secret' WHERE id = ?`).run(id)).toThrow(/CHECK/);
      }
    });

    it('refuse de rattacher après coup à une source un créneau manuel qui porte un titre', () => {
      const s = sourceBrute(d.a.userId);
      const manuel = creneauBrut(d.a.userId, null, 'Kiné');
      expect(() => t.sql.prepare('UPDATE personal_events SET calendar_source_id = ? WHERE id = ?').run(s, manuel)).toThrow(/CHECK/);
    });

    it('laisse un créneau manuel porter titre, description et lieu', () => {
      const id = creneauBrut(d.a.userId, null, 'Kiné');
      expect(() => t.sql.prepare("UPDATE personal_events SET description = 'dos', location_name = 'Cabinet' WHERE id = ?").run(id)).not.toThrow();
    });
  });

  describe('déclencheurs de partage : jamais `details` sur un créneau importé', () => {
    it('refuse `details` à l’INSERT du partage, l’accepte en `busy`', () => {
      const id = creneauBrut(d.a.userId, sourceBrute(d.a.userId));
      expect(() => partage(id, 'details')).toThrow(/partage\.import_sans_details/);
      expect(() => partage(id, 'busy')).not.toThrow();
    });

    it('refuse de passer un partage `busy` en `details` à l’UPDATE', () => {
      const id = creneauBrut(d.a.userId, sourceBrute(d.a.userId));
      partage(id, 'busy');
      expect(() => t.sql.prepare("UPDATE personal_event_shares SET visibility = 'details' WHERE personal_event_id = ?").run(id)).toThrow(
        /partage\.import_sans_details/,
      );
      expect(t.sql.prepare('SELECT visibility FROM personal_event_shares WHERE personal_event_id = ?').pluck().get(id)).toBe('busy');
    });

    it('reste permissif pour un créneau manuel (INSERT et UPDATE en `details`)', () => {
      const id = creneauBrut(d.a.userId, null, 'Kiné');
      expect(() => partage(id, 'details')).not.toThrow();
      partage_vers_busy(id);
      expect(() => t.sql.prepare("UPDATE personal_event_shares SET visibility = 'details' WHERE personal_event_id = ?").run(id)).not.toThrow();
    });

    const partage_vers_busy = (id: string): void => {
      t.sql.prepare("UPDATE personal_event_shares SET visibility = 'busy' WHERE personal_event_id = ?").run(id);
    };
  });

  describe('suppression', () => {
    it('refuse la suppression réelle d’un créneau manuel', () => {
      const id = creneauBrut(d.a.userId, null, 'Kiné');
      expect(() => t.sql.prepare('DELETE FROM personal_events WHERE id = ?').run(id)).toThrow(/creneau\.suppression_douce_seulement/);
      expect(t.sql.prepare('SELECT count(*) FROM personal_events WHERE id = ?').pluck().get(id)).toBe(1);
    });

    it('accepte la suppression réelle d’un créneau importé', () => {
      const id = creneauBrut(d.a.userId, sourceBrute(d.a.userId));
      expect(() => t.sql.prepare('DELETE FROM personal_events WHERE id = ?').run(id)).not.toThrow();
      expect(t.sql.prepare('SELECT count(*) FROM personal_events WHERE id = ?').pluck().get(id)).toBe(0);
    });

    it('supprimer une source efface ses créneaux et leurs partages en cascade, et laisse les créneaux manuels', () => {
      const s = sourceBrute(d.a.userId);
      const importe = creneauBrut(d.a.userId, s);
      partage(importe, 'busy');
      const manuel = creneauBrut(d.a.userId, null, 'Kiné');
      t.sql.prepare('DELETE FROM calendar_sources WHERE id = ?').run(s);
      expect(t.sql.prepare('SELECT count(*) FROM personal_events WHERE id = ?').pluck().get(importe)).toBe(0);
      expect(t.sql.prepare('SELECT count(*) FROM personal_event_shares WHERE personal_event_id = ?').pluck().get(importe)).toBe(0);
      expect(t.sql.prepare('SELECT count(*) FROM personal_events WHERE id = ?').pluck().get(manuel)).toBe(1);
    });
  });

  describe('cloisonnement', () => {
    it('calendar_sources est déclarée dans la garde du SQL brut, qui refuse alors une lecture sans user_id', () => {
      expect(PORTEE_TABLES['calendar_sources']).toBe('user_id');
      expect(diagnostiquer('SELECT id FROM calendar_sources WHERE disabled_at IS NULL')).toBeTypeOf('string');
      expect(diagnostiquer('SELECT id FROM calendar_sources WHERE user_id = ?')).toBeUndefined();
    });

    it('le sélecteur de la tâche de fond n’a de passage que par le canal transverse', () => {
      expect(
        diagnostiquer('SELECT id, user_id FROM calendar_sources WHERE disabled_at IS NULL AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?'),
      ).toBeTypeOf('string');
    });
  });

  describe('couche de requêtes', () => {
    const portee = (user: string) => creerPorteeUtilisateur(t.base, user);
    const nouvelle = (url = URL_SECRETE) => ({ label: 'Google', url, hote: 'calendar.google.com', prochaineTentative: T0 });

    beforeEach(() => {
      t.sql.prepare('DELETE FROM calendar_sources').run();
    });

    it('crée une source dont l’URL est chiffrée au repos, se relit et se refuse en double', () => {
      const alice = portee(d.a.userId);
      const r = creerSource(alice, nouvelle(), CLE);
      expect(r.ok).toBe(true);
      expect(creerSource(alice, nouvelle(), CLE)).toEqual({ ok: false, raison: 'doublon' });
      if (!r.ok) throw new Error('création attendue');

      const stocke = t.sql.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(r.id) as Record<string, unknown>;
      expect(JSON.stringify(stocke)).not.toContain('secret');
      expect(JSON.stringify(stocke)).not.toContain('private-abcdef');
      expect(stocke['url_host']).toBe('calendar.google.com');

      const lue = lireSource(alice, r.id);
      expect(lue).toMatchObject({ label: 'Google', url_host: 'calendar.google.com', consecutive_failures: 0, last_status: null });
      expect(JSON.stringify(lue)).not.toContain('private-abcdef');
      expect(lireUrlSource(alice, r.id, CLE)).toBe(URL_SECRETE);
      expect(() => lireUrlSource(alice, r.id, randomBytes(32).toString('base64'))).toThrow();
    });

    it('un autre compte ne voit, ne lit, ne modifie ni ne supprime la source, même en forgeant l’identifiant', () => {
      const r = creerSource(portee(d.a.userId), nouvelle(), CLE);
      if (!r.ok) throw new Error('création attendue');
      const bob = portee(d.b.userId);
      expect(listerMesSources(bob)).toEqual([]);
      expect(lireSource(bob, r.id)).toBeUndefined();
      expect(lireUrlSource(bob, r.id, CLE)).toBeUndefined();
      expect(modifierSource(bob, r.id, { label: 'Pris' })).toBe(false);
      expect(supprimerSource(bob, r.id)).toBe(false);
      expect(remplacerCreneauxImportes(bob, r.id, [PLAGE])).toBeUndefined();
      expect(t.sql.prepare('SELECT count(*) FROM personal_events WHERE calendar_source_id = ?').pluck().get(r.id)).toBe(0);
      expect(lireSource(portee(d.a.userId), r.id)?.label).toBe('Google');
    });

    it('modifie l’état de synchronisation et refuse un statut inconnu', () => {
      const alice = portee(d.a.userId);
      const r = creerSource(alice, nouvelle(), CLE);
      if (!r.ok) throw new Error('création attendue');
      expect(modifierSource(alice, r.id, { last_status: 'ok', consecutive_failures: 0, slots_imported: 4, last_success_at: T0 })).toBe(true);
      expect(lireSource(alice, r.id)).toMatchObject({ last_status: 'ok', slots_imported: 4, last_success_at: T0 });
      expect(() => t.sql.prepare("UPDATE calendar_sources SET last_status = 'nimporte' WHERE id = ?").run(r.id)).toThrow(/CHECK/);
    });

    it('sourcesAFaire ne rend que les sources actives échues, les plus en retard d’abord, tous comptes confondus', () => {
      const alice = portee(d.a.userId);
      const bob = portee(d.b.userId);
      const s1 = creerSource(alice, { ...nouvelle('https://a.test/1.ics'), prochaineTentative: '2026-06-02T00:00:00Z' }, CLE);
      const s2 = creerSource(bob, { ...nouvelle('https://b.test/2.ics'), prochaineTentative: '2026-06-01T00:00:00Z' }, CLE);
      const s3 = creerSource(alice, { ...nouvelle('https://a.test/3.ics'), prochaineTentative: '2030-01-01T00:00:00Z' }, CLE);
      const s4 = creerSource(alice, { ...nouvelle('https://a.test/4.ics'), prochaineTentative: '2026-06-01T00:00:00Z' }, CLE);
      if (!s1.ok || !s2.ok || !s3.ok || !s4.ok) throw new Error('création attendue');
      modifierSource(alice, s4.id, { disabled_at: T0 });
      expect(sourcesAFaire(t.base, '2026-07-01T00:00:00Z', 10)).toEqual([
        { id: s2.id, user_id: d.b.userId },
        { id: s1.id, user_id: d.a.userId },
      ]);
      expect(sourcesAFaire(t.base, '2026-07-01T00:00:00Z', 1)).toHaveLength(1);
    });

    it('remplacerCreneauxImportes remplace le lot sans toucher aux créneaux manuels', () => {
      const alice = portee(d.a.userId);
      const r = creerSource(alice, nouvelle(), CLE);
      if (!r.ok) throw new Error('création attendue');
      const manuel = creneauBrut(d.a.userId, null, 'Kiné');
      expect(remplacerCreneauxImportes(alice, r.id, [PLAGE, { ...PLAGE, starts_at: '2027-03-02T09:00:00Z', ends_at: '2027-03-02T10:00:00Z' }])).toBe(2);
      expect(remplacerCreneauxImportes(alice, r.id, [{ ...PLAGE, starts_at: '2027-04-01T09:00:00Z', ends_at: '2027-04-01T10:00:00Z' }])).toBe(1);
      const lignes = t.sql.prepare('SELECT title, description, location_name, starts_at FROM personal_events WHERE calendar_source_id = ?').all(r.id);
      expect(lignes).toEqual([{ title: '', description: null, location_name: null, starts_at: '2027-04-01T09:00:00Z' }]);
      expect(t.sql.prepare('SELECT count(*) FROM personal_events WHERE id = ?').pluck().get(manuel)).toBe(1);
      expect(remplacerCreneauxImportes(alice, r.id, [])).toBe(0);
      expect(t.sql.prepare('SELECT count(*) FROM personal_events WHERE calendar_source_id = ?').pluck().get(r.id)).toBe(0);
    });

    it('remplacerCreneauxImportes ÉCRASE `details` en `busy` (réglage du membre) au lieu de laisser le déclencheur échouer', () => {
      const alice = portee(d.a.userId);
      const r = creerSource(alice, nouvelle(), CLE);
      if (!r.ok) throw new Error('création attendue');
      t.sql.prepare("UPDATE memberships SET default_personal_visibility = 'details' WHERE id = ?").run(d.a.membershipId);
      try {
        expect(remplacerCreneauxImportes(alice, r.id, [PLAGE])).toBe(1);
        const visibilites = t.sql
          .prepare(
            'SELECT s.visibility FROM personal_event_shares AS s JOIN personal_events AS p ON p.id = s.personal_event_id WHERE p.calendar_source_id = ?',
          )
          .pluck()
          .all(r.id);
        expect(visibilites).toEqual(['busy']);
      } finally {
        t.sql.prepare("UPDATE memberships SET default_personal_visibility = 'busy' WHERE id = ?").run(d.a.membershipId);
      }
    });

    it('remplacerCreneauxImportes respecte `none` : aucun partage', () => {
      const alice = portee(d.a.userId);
      const r = creerSource(alice, nouvelle(), CLE);
      if (!r.ok) throw new Error('création attendue');
      t.sql.prepare("UPDATE memberships SET default_personal_visibility = 'none' WHERE id = ?").run(d.a.membershipId);
      try {
        expect(remplacerCreneauxImportes(alice, r.id, [PLAGE])).toBe(1);
        expect(
          t.sql
            .prepare('SELECT count(*) FROM personal_event_shares AS s JOIN personal_events AS p ON p.id = s.personal_event_id WHERE p.calendar_source_id = ?')
            .pluck()
            .get(r.id),
        ).toBe(0);
      } finally {
        t.sql.prepare("UPDATE memberships SET default_personal_visibility = 'busy' WHERE id = ?").run(d.a.membershipId);
      }
    });

    it('remplacerCreneauxImportes est atomique : une plage invalide annule tout le lot, l’ancien reste', () => {
      const alice = portee(d.a.userId);
      const r = creerSource(alice, nouvelle(), CLE);
      if (!r.ok) throw new Error('création attendue');
      remplacerCreneauxImportes(alice, r.id, [PLAGE]);
      const casse: PlageImportee = { starts_at: 'pas-un-instant', ends_at: null, all_day: false, time_zone: 'UTC' };
      expect(() => remplacerCreneauxImportes(alice, r.id, [PLAGE, casse])).toThrow();
      expect(t.sql.prepare('SELECT starts_at FROM personal_events WHERE calendar_source_id = ?').pluck().all(r.id)).toEqual([PLAGE.starts_at]);
    });

    it('supprimerSource emporte les créneaux importés', () => {
      const alice = portee(d.a.userId);
      const r = creerSource(alice, nouvelle(), CLE);
      if (!r.ok) throw new Error('création attendue');
      remplacerCreneauxImportes(alice, r.id, [PLAGE]);
      expect(supprimerSource(alice, r.id)).toBe(true);
      expect(lireSource(alice, r.id)).toBeUndefined();
      expect(t.sql.prepare('SELECT count(*) FROM personal_events WHERE calendar_source_id = ?').pluck().get(r.id)).toBe(0);
    });
  });
});
