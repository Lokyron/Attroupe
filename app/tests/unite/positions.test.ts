import { describe, expect, it } from 'vitest';
import { PAS_POSITION, positionEntre } from '../../server/db/queries/listes.js';

// Le calcul de position du réordonnancement (db/queries/listes.ts) : au milieu de deux voisines, `undefined` quand il n'y a plus de place.
describe('positionEntre', () => {
  it('liste vide : le pas', () => {
    expect(positionEntre(undefined, undefined)).toBe(PAS_POSITION);
  });

  it('en tête : un pas avant la première, même sous zéro (entier relatif)', () => {
    expect(positionEntre(undefined, 1024)).toBe(0);
    expect(positionEntre(undefined, 0)).toBe(-PAS_POSITION);
  });

  it('en fin : un pas après la dernière', () => {
    expect(positionEntre(2048, undefined)).toBe(2048 + PAS_POSITION);
  });

  it('au milieu : strictement entre les deux voisines, toujours un entier', () => {
    for (const [p, s] of [[1024, 2048], [0, 3], [10, 12], [-7, 4], [5, 7]] as const) {
      const milieu = positionEntre(p, s);
      expect(milieu).toBeDefined();
      expect(Number.isInteger(milieu)).toBe(true);
      expect(milieu).toBeGreaterThan(p);
      expect(milieu).toBeLessThan(s);
    }
  });

  it('plus de place : écart de 1, positions égales, ou inversées → undefined (l’appelant renumérote)', () => {
    expect(positionEntre(5, 6)).toBeUndefined();
    expect(positionEntre(5, 5)).toBeUndefined();
    expect(positionEntre(6, 5)).toBeUndefined();
  });

  it('s’épuise après une dizaine d’insertions au même endroit (le pas est de 1024)', () => {
    let precedente = 0;
    const suivante = PAS_POSITION;
    let n = 0;
    for (let position = positionEntre(precedente, suivante); position !== undefined; position = positionEntre(precedente, suivante)) {
      precedente = position;
      n += 1;
    }
    expect(n).toBe(10);
  });
});
