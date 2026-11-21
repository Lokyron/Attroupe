import { describe, expect, it } from 'vitest';
import { defilementPourCentrer } from '../../client/src/lib/defilement-ruban.js';

// Recentrage du ruban « Ma semaine » sur le jour courant.
describe('défilement du ruban', () => {
  it('cas mesuré à 375 px : samedi, en fin de ruban, amène le défilement au maximum (111)', () => {
    expect(defilementPourCentrer(309, 420, 337, 52)).toBe(111);
  });

  it('une cible au milieu est centrée exactement', () => {
    expect(defilementPourCentrer(300, 1000, 500, 100)).toBe(400);
  });

  it('une cible proche du début : jamais négatif', () => {
    expect(defilementPourCentrer(309, 420, 10, 52)).toBe(0);
  });

  it('un contenu qui tient dans le champ : 0', () => {
    expect(defilementPourCentrer(400, 380, 300, 52)).toBe(0);
  });
});
