import { describe, expect, it } from 'vitest';
import { champsHoraireInvalides, dateValide, fenetreValide, instantValide } from '../../server/domain/evenements.js';

// Règles de date d'un événement (lot 4) : ce que le schéma SQL imposerait par CHECK est refusé AVANT la base.
describe('instantValide / dateValide', () => {
  it.each(['2027-03-20T18:00:00Z', '2024-02-29T00:00:00Z', '2027-12-31T23:59:59Z'])('instant réel : %s', (v) => {
    expect(instantValide(v)).toBe(true);
  });

  it.each([
    '2027-03-20T18:00:00', // pas de Z
    '2027-03-20T18:00:00+01:00', // décalage au lieu de Z
    '2027-03-20T18:00:00.000Z', // millisecondes (24 caractères)
    '2027-03-20 18:00:00Z',
    '2027-02-30T10:00:00Z', // le 30 février
    '2027-03-20T25:00:00Z',
    '2027-03-20',
    '',
  ])('instant refusé : %j', (v) => {
    expect(instantValide(v)).toBe(false);
  });

  it.each(['2027-03-20', '2024-02-29'])('date réelle : %s', (v) => {
    expect(dateValide(v)).toBe(true);
  });

  it.each(['2027-02-29', '2027-13-01', '2027-3-20', '2027-03-20T18:00:00Z', '20270320', ''])('date refusée : %j', (v) => {
    expect(dateValide(v)).toBe(false);
  });
});

describe('champsHoraireInvalides', () => {
  const instant = { all_day: false, starts_at: '2027-03-20T18:00:00Z', ends_at: null } as const;
  const journee = { all_day: true, starts_at: '2027-03-20', ends_at: null } as const;

  it('accepte un instant seul, un instant borné, une journée, une période de plusieurs jours', () => {
    expect(champsHoraireInvalides(instant)).toEqual([]);
    expect(champsHoraireInvalides({ ...instant, ends_at: '2027-03-20T18:00:00Z' })).toEqual([]); // fin = début admise
    expect(champsHoraireInvalides({ ...instant, ends_at: '2027-03-21T02:00:00Z' })).toEqual([]);
    expect(champsHoraireInvalides(journee)).toEqual([]);
    expect(champsHoraireInvalides({ ...journee, ends_at: '2027-03-22' })).toEqual([]);
  });

  it('refuse une date pour un événement horaire et un instant pour une journée entière', () => {
    expect(champsHoraireInvalides({ ...instant, starts_at: '2027-03-20' })).toEqual(['starts_at']);
    expect(champsHoraireInvalides({ ...journee, starts_at: '2027-03-20T18:00:00Z' })).toEqual(['starts_at']);
  });

  it('refuse une fin de longueur différente (le CHECK de la base la refuserait en 500)', () => {
    expect(champsHoraireInvalides({ ...instant, ends_at: '2027-03-21' })).toEqual(['ends_at']);
    expect(champsHoraireInvalides({ ...journee, ends_at: '2027-03-21T10:00:00Z' })).toEqual(['ends_at']);
  });

  it('refuse une fin antérieure au début', () => {
    expect(champsHoraireInvalides({ ...instant, ends_at: '2027-03-20T17:59:59Z' })).toEqual(['ends_at']);
    expect(champsHoraireInvalides({ ...journee, ends_at: '2027-03-19' })).toEqual(['ends_at']);
  });

  it('si le début est invalide, ne juge pas la fin', () => {
    expect(champsHoraireInvalides({ all_day: false, starts_at: 'demain', ends_at: 'après-demain' })).toEqual(['starts_at']);
  });
});

describe('fenetreValide', () => {
  it('admet un mois, un jour, et refuse l’inversion ou l’excès', () => {
    expect(fenetreValide('2027-03-01', '2027-03-31')).toBe(true);
    expect(fenetreValide('2027-03-01', '2027-03-01')).toBe(true);
    expect(fenetreValide('2027-03-02', '2027-03-01')).toBe(false);
    expect(fenetreValide('2027-01-01', '2028-12-31')).toBe(false);
  });
});
