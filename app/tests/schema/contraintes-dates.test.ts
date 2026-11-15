import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';

// Revue du lot 1 : `'2026-12-01T20:00:00+'` (20 caractères, sans Z) était accepté par personal_events
// et date_poll_options, qui n'avaient pas le contrôle du « Z » final ni de la longueur de ends_at
// que events possède (modèle §4.2).
const T0 = '2026-01-01T00:00:00Z';
const CHECK = /CHECK constraint failed/;

describe('CHECK des instants : events, personal_events et date_poll_options sont alignés', () => {
  let t: BaseTemporaire;
  let d: DeuxGroupes;
  beforeAll(() => {
    t = baseTemporaire();
    d = deuxGroupes(t.base);
    t.sql.prepare(`INSERT INTO date_polls (id, group_id, title, created_by_membership_id, created_at, updated_at) VALUES ('pA', ?, 'S', ?, ?, ?)`).run(d.a.groupId, d.a.membershipId, T0, T0);
  });
  afterAll(() => t.nettoyer());

  let n = 0;
  const evenement = (touche: string, allDay: number, debut: string, fin: string | null): void => {
    t.sql.prepare(`INSERT INTO events (id, group_id, title, all_day, starts_at, ends_at, time_zone, created_by_membership_id, created_at, updated_at) VALUES (?, ?, 'E', ?, ?, ?, 'Europe/Paris', ?, ?, ?)`).run(`${touche}${String(n++)}`, d.a.groupId, allDay, debut, fin, d.a.membershipId, T0, T0);
  };
  const personnel = (allDay: number, debut: string, fin: string | null): void => {
    t.sql.prepare(`INSERT INTO personal_events (id, user_id, title, all_day, starts_at, ends_at, time_zone, created_at, updated_at) VALUES (?, ?, 'P', ?, ?, ?, 'Europe/Paris', ?, ?)`).run(`p${String(n++)}`, d.a.userId, allDay, debut, fin, T0, T0);
  };
  const option = (allDay: number, debut: string, fin: string | null): void => {
    t.sql.prepare(`INSERT INTO date_poll_options (id, date_poll_id, group_id, all_day, starts_at, ends_at, position, created_at) VALUES (?, 'pA', ?, ?, ?, ?, ?, ?)`).run(`o${String(n++)}`, d.a.groupId, allDay, debut, fin, n, T0);
  };

  const tables: ReadonlyArray<[string, (allDay: number, debut: string, fin: string | null) => void]> = [
    ['events', (a, s, e) => evenement('e', a, s, e)],
    ['personal_events', personnel],
    ['date_poll_options', option],
  ];

  describe.each(tables)('%s', (_nom, inserer) => {
    it('refuse un instant sans Z final (le cas de la revue)', () => {
      expect(() => inserer(0, '2026-12-01T20:00:00+', null)).toThrow(CHECK);
      expect(() => inserer(0, '2026-12-01T20:00:00X', null)).toThrow(CHECK);
    });
    it('refuse une fin de longueur différente du début', () => {
      expect(() => inserer(0, '2026-12-01T20:00:00Z', '2026-12-02')).toThrow(CHECK);
      expect(() => inserer(1, '2026-12-01', '2026-12-02T20:00:00Z')).toThrow(CHECK);
    });
    it('refuse une fin antérieure au début', () => {
      expect(() => inserer(0, '2026-12-01T20:00:00Z', '2026-12-01T19:00:00Z')).toThrow(CHECK);
    });
    it('refuse une journée entière portant un instant UTC', () => {
      expect(() => inserer(1, '2026-12-01T20:00:00Z', null)).toThrow(CHECK);
    });
    it('accepte un instant UTC bien formé, avec ou sans fin, et une journée entière', () => {
      expect(() => inserer(0, '2026-12-01T20:00:00Z', null)).not.toThrow();
      expect(() => inserer(0, '2026-12-02T20:00:00Z', '2026-12-02T22:00:00Z')).not.toThrow();
      expect(() => inserer(1, '2026-12-03', '2026-12-04')).not.toThrow();
    });
  });
});
