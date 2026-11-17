import { describe, expect, it } from 'vitest';
import { convertirMontant } from '../../server/domain/argent.js';
import {
  ErreurRepartition,
  repartirDepense,
  type ModeRepartition,
  type ParticipantEntree,
} from '../../server/domain/repartition.js';

/** Générateur pseudo-aléatoire déterministe (Mulberry32) pour des tests de propriétés 100 % reproductibles. */
function creerPrng(graine: number): () => number {
  let etat = graine >>> 0;
  return () => {
    etat = (etat + 0x6d2b79f5) >>> 0;
    let t = Math.imul(etat ^ (etat >>> 15), 1 | etat);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function entierAleatoire(alea: () => number, min: number, max: number): number {
  return Math.floor(alea() * (max - min + 1)) + min;
}

function melanger<T>(alea: () => number, tableau: ReadonlyArray<T>): T[] {
  const copie = [...tableau];
  for (let i = copie.length - 1; i > 0; i -= 1) {
    const j = entierAleatoire(alea, 0, i);
    const temp = copie[i] as T;
    copie[i] = copie[j] as T;
    copie[j] = temp;
  }
  return copie;
}

describe('exemple canonique (§4.5 du modèle de données)', () => {
  it('répartit 10,00 € (1000) entre 3 personnes en 334 / 333 / 333, le 334 allant au plus petit membership_id quel que soit l’ordre d’entrée', () => {
    const m1 = '01933b10-0000-7000-8000-000000000001';
    const m2 = '01933b10-0000-7000-8000-000000000002';
    const m3 = '01933b10-0000-7000-8000-000000000003';

    const permutations: ReadonlyArray<ReadonlyArray<string>> = [
      [m1, m2, m3],
      [m1, m3, m2],
      [m2, m1, m3],
      [m2, m3, m1],
      [m3, m1, m2],
      [m3, m2, m1],
    ];

    for (const ordre of permutations) {
      const parts = repartirDepense({
        amountMinor: 1000,
        amountTargetMinor: 1000,
        mode: 'equal',
        participants: ordre.map((membership_id) => ({ membership_id })),
      });

      expect(parts).toEqual([
        { membership_id: m1, weight: 1, share_minor: 334, share_target_minor: 334 },
        { membership_id: m2, weight: 1, share_minor: 333, share_target_minor: 333 },
        { membership_id: m3, weight: 1, share_minor: 333, share_target_minor: 333 },
      ]);
    }
  });
});

describe('reliquat maximal (n - 1 unités) et départage par plus grands restes', () => {
  it('affecte n - 1 unités de reliquat aux n - 1 premiers membres quand T mod n = n - 1', () => {
    // 7 participants, total = 706 -> base = 100, reliquat R = 6 (soit n - 1).
    const ids = ['m-01', 'm-02', 'm-03', 'm-04', 'm-05', 'm-06', 'm-07'];
    const parts = repartirDepense(
      706,
      706,
      'equal',
      [...ids].reverse().map((membership_id) => ({ membership_id })),
    );

    expect(parts.map((p) => p.share_minor)).toEqual([101, 101, 101, 101, 101, 101, 100]);
    expect(parts.reduce((acc, p) => acc + p.share_minor, 0)).toBe(706);
  });

  it('priorise strictement le plus grand reste avant l’ordre lexicographique de membership_id', () => {
    // Total = 10, poids : m-a = 1, m-z = 2 (somme W = 3).
    // m-a : (10 * 1) / 3 = 3, reste = 1
    // m-z : (10 * 2) / 3 = 6, reste = 2
    // Reliquat R = 1 : bien que 'm-a' < 'm-z', 'm-z' a un reste supérieur (2 > 1) et reçoit donc +1 -> 7.
    const parts = repartirDepense(10, 10, 'weights', [
      { membership_id: 'm-a', weight: 1 },
      { membership_id: 'm-z', weight: 2 },
    ]);

    expect(parts).toEqual([
      { membership_id: 'm-a', weight: 1, share_minor: 3, share_target_minor: 3 },
      { membership_id: 'm-z', weight: 2, share_minor: 7, share_target_minor: 7 },
    ]);
  });
});

describe('mode exact et conversions multi-devises (notamment JPY)', () => {
  it('refuse une répartition en mode exact dont la somme des parts ne vaut pas amountMinor (code somme_parts_inexacte)', () => {
    expect(() =>
      repartirDepense(1000, 1000, 'exact', [
        { membership_id: 'm-1', share_minor: 500 },
        { membership_id: 'm-2', share_minor: 499 },
      ]),
    ).toThrowError(ErreurRepartition);

    try {
      repartirDepense(1000, 1000, 'exact', [
        { membership_id: 'm-1', share_minor: 500 },
        { membership_id: 'm-2', share_minor: 501 },
      ]);
    } catch (err) {
      expect(err).toBeInstanceOf(ErreurRepartition);
      expect((err as ErreurRepartition).code).toBe('somme_parts_inexacte');
    }
  });

  it('conserve les proportions en mode exact lors d’une conversion JPY -> EUR et boucle au centime près', () => {
    // Dépense de 1000 ¥ (JPY, exposant 0) convertie en EUR (exposant 2) à 6250 ppm -> 625 centimes (6,25 €)
    const amountMinor = 1000;
    const amountTargetMinor = convertirMontant(amountMinor, 6250, 0, 2);
    expect(amountTargetMinor).toBe(625);

    const parts = repartirDepense(amountMinor, amountTargetMinor, 'exact', [
      { membership_id: 'm-1', share_minor: 333 },
      { membership_id: 'm-2', share_minor: 333 },
      { membership_id: 'm-3', share_minor: 334 },
    ]);

    expect(parts.reduce((s, p) => s + p.share_minor, 0)).toBe(1000);
    expect(parts.reduce((s, p) => s + p.share_target_minor, 0)).toBe(625);
    // 625 * 333 / 1000 = 208 reste 125 ; 625 * 334 / 1000 = 208 reste 750.
    // Somme des bases = 624, reliquat R = 1 attribué à m-3 (reste 750 > 125).
    expect(parts.map((p) => p.share_target_minor)).toEqual([208, 208, 209]);
  });

  it('laisse à 0 la part convertie d’un participant ayant share_minor = 0 en mode exact', () => {
    const parts = repartirDepense(1000, 333, 'exact', [
      { membership_id: 'm-0', share_minor: 0 },
      { membership_id: 'm-1', share_minor: 500 },
      { membership_id: 'm-2', share_minor: 500 },
    ]);
    expect(parts).toEqual([
      { membership_id: 'm-0', weight: 1, share_minor: 0, share_target_minor: 0 },
      { membership_id: 'm-1', weight: 1, share_minor: 500, share_target_minor: 167 },
      { membership_id: 'm-2', weight: 1, share_minor: 500, share_target_minor: 166 },
    ]);
  });
});

describe('validations d’entrées de repartirDepense', () => {
  it('refuse une liste vide de participants ou un doublon de membership_id', () => {
    expect(() => repartirDepense(100, 100, 'equal', [])).toThrowError(ErreurRepartition);
    expect(() =>
      repartirDepense(100, 100, 'equal', [{ membership_id: 'm-1' }, { membership_id: 'm-1' }]),
    ).toThrowError(ErreurRepartition);
  });

  it('refuse un poids nul ou négatif en mode weights', () => {
    expect(() =>
      repartirDepense(100, 100, 'weights', [
        { membership_id: 'm-1', weight: 0 },
        { membership_id: 'm-2', weight: 2 },
      ]),
    ).toThrowError(ErreurRepartition);
  });
});

describe('propriétés sur 200 répartitions aléatoires (seeded)', () => {
  it('vérifie la somme exacte des parts (source et cible) et l’indépendance à l’ordre d’entrée sur 200 cas', () => {
    const alea = creerPrng(20261117);
    const modes: ReadonlyArray<ModeRepartition> = ['equal', 'weights', 'exact'];

    for (let essai = 0; essai < 200; essai += 1) {
      const nbParticipants = entierAleatoire(alea, 1, 12);
      const mode = modes[entierAleatoire(alea, 0, modes.length - 1)] as ModeRepartition;
      const amountTargetMinor = entierAleatoire(alea, 1, 5_000_000);

      let amountMinor = entierAleatoire(alea, 1, 5_000_000);
      const participants: ParticipantEntree[] = [];

      if (mode === 'equal') {
        for (let i = 0; i < nbParticipants; i += 1) {
          participants.push({ membership_id: `membre-${String(i + 1).padStart(3, '0')}` });
        }
      } else if (mode === 'weights') {
        for (let i = 0; i < nbParticipants; i += 1) {
          participants.push({
            membership_id: `membre-${String(i + 1).padStart(3, '0')}`,
            weight: entierAleatoire(alea, 1, 25),
          });
        }
      } else {
        let cumul = 0;
        for (let i = 0; i < nbParticipants; i += 1) {
          const part = i === 0 ? entierAleatoire(alea, 1, 50_000) : entierAleatoire(alea, 0, 50_000);
          cumul += part;
          participants.push({
            membership_id: `membre-${String(i + 1).padStart(3, '0')}`,
            share_minor: part,
          });
        }
        amountMinor = cumul;
      }

      const resultat1 = repartirDepense(amountMinor, amountTargetMinor, mode, participants);
      const participantsMelanges = melanger(alea, participants);
      const resultat2 = repartirDepense(amountMinor, amountTargetMinor, mode, participantsMelanges);

      // (a) Somme des parts = total dans les deux devises
      const sommeSource = resultat1.reduce((acc, p) => acc + p.share_minor, 0);
      const sommeCible = resultat1.reduce((acc, p) => acc + p.share_target_minor, 0);
      expect(sommeSource).toBe(amountMinor);
      expect(sommeCible).toBe(amountTargetMinor);

      // (c) Reproductibilité totale quel que soit l'ordre d'entrée
      expect(resultat2).toEqual(resultat1);
    }
  });
});
