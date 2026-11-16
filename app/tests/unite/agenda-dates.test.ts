import { describe, expect, it } from 'vitest';
import {
  ajouterJours,
  debutSemaine,
  grilleMois,
  heureLocaleDepuisInstant,
  instantDepuisHeureLocale,
  joursDe,
  joursDeSemaine,
  moisVoisin,
} from '../../client/src/agenda/dates.js';

// Calculs de dates de l'interface d'agenda (lot 4) : la grille est faite à la main, sans dépendance.
describe('grille de l’agenda', () => {
  it('la semaine commence le lundi', () => {
    expect(debutSemaine('2027-03-20')).toBe('2027-03-15'); // samedi
    expect(debutSemaine('2027-03-15')).toBe('2027-03-15'); // lundi
    expect(debutSemaine('2027-03-21')).toBe('2027-03-15'); // dimanche
    expect(joursDeSemaine('2027-03-20')).toHaveLength(7);
  });

  it('un mois est fait de semaines complètes qui le couvrent', () => {
    const mars = grilleMois('2027-03-10');
    expect(mars.every((l) => l.length === 7)).toBe(true);
    expect(mars[0]?.[0]).toBe('2027-03-01'); // le 1er mars 2027 est un lundi
    expect(mars.flat()).toContain('2027-03-31');
    expect(mars).toHaveLength(5);
    // février 2027 tient en 4 lignes exactement (du lundi 1er au dimanche 28)
    expect(grilleMois('2027-02-01')).toHaveLength(4);
    // un mois qui déborde sur 6 lignes
    expect(grilleMois('2027-05-01')).toHaveLength(6);
  });

  it('avance de jours et de mois à travers les fins de mois et d’année', () => {
    expect(ajouterJours('2027-02-28', 1)).toBe('2027-03-01');
    expect(ajouterJours('2024-02-28', 1)).toBe('2024-02-29');
    expect(ajouterJours('2027-01-01', -1)).toBe('2026-12-31');
    expect(moisVoisin('2027-01-31', -1)).toBe('2026-12-01');
    expect(moisVoisin('2027-12-15', 1)).toBe('2028-01-01');
  });
});

describe('heure murale et fuseau', () => {
  it('Paris : UTC+1 en hiver, UTC+2 en été', () => {
    expect(instantDepuisHeureLocale('2027-01-15T19:30', 'Europe/Paris')).toBe('2027-01-15T18:30:00Z');
    expect(instantDepuisHeureLocale('2027-07-15T19:30', 'Europe/Paris')).toBe('2027-07-15T17:30:00Z');
  });

  it('est l’inverse de heureLocaleDepuisInstant, y compris autour d’un changement d’heure', () => {
    for (const [local, fuseau] of [
      ['2027-03-27T20:00', 'Europe/Paris'],
      ['2027-03-28T05:00', 'Europe/Paris'],
      ['2027-11-07T20:00', 'America/New_York'],
      ['2027-06-01T00:30', 'Asia/Tokyo'],
    ] as const) {
      expect(heureLocaleDepuisInstant(instantDepuisHeureLocale(local, fuseau), fuseau)).toBe(local);
    }
  });

  it('un fuseau inconnu lève une erreur (le formulaire la montre)', () => {
    expect(() => instantDepuisHeureLocale('2027-01-15T19:30', 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('jours touchés par un événement', () => {
  it('un événement horaire se range dans le jour de SON fuseau, pas celui d’UTC', () => {
    // 23 h 30 UTC = 00 h 30 à Paris le lendemain
    expect(joursDe({ all_day: false, starts_at: '2027-03-20T23:30:00Z', ends_at: null, time_zone: 'Europe/Paris' })).toEqual(['2027-03-21']);
  });

  it('une période s’étend sur chacun de ses jours', () => {
    expect(joursDe({ all_day: true, starts_at: '2027-02-27', ends_at: '2027-03-01', time_zone: 'Europe/Paris' })).toEqual(['2027-02-27', '2027-02-28', '2027-03-01']);
    expect(joursDe({ all_day: false, starts_at: '2027-03-20T20:00:00Z', ends_at: '2027-03-21T03:00:00Z', time_zone: 'UTC' })).toEqual(['2027-03-20', '2027-03-21']);
  });
});
