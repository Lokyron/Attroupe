import { describe, expect, it } from 'vitest';
import { convertirMontant, UNITE_TAUX_PPM } from '../../server/domain/argent.js';
import {
  repartirDepense,
  type ModeRepartition,
  type ParticipantEntree,
} from '../../server/domain/repartition.js';
import {
  calculerSoldesDevise,
  calculerSoldesParDevise,
  ErreurSolde,
  suggererRemboursements,
  type EntreeDepenseSolde,
  type EntreeRemboursementSolde,
} from '../../server/domain/soldes.js';

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

describe('calcul des soldes et remboursements suggérés sur un cas canonique', () => {
  const m1 = '01933b10-0000-7000-8000-000000000001';
  const m2 = '01933b10-0000-7000-8000-000000000002';
  const m3 = '01933b10-0000-7000-8000-000000000003';

  it('calcule les soldes après une dépense de 10,00 € à trois et suggère les deux remboursements exacts', () => {
    const parts = repartirDepense(1000, 1000, 'equal', [
      { membership_id: m1 },
      { membership_id: m2 },
      { membership_id: m3 },
    ]);

    const ardoise = calculerSoldesDevise('EUR', [
      {
        payer_membership_id: m1,
        amount_target_minor: 1000,
        target_currency_code: 'EUR',
        shares: parts,
      },
    ]);

    expect(ardoise.soldes).toEqual([
      { membership_id: m1, net_minor: 666 },
      { membership_id: m2, net_minor: -333 },
      { membership_id: m3, net_minor: -333 },
    ]);

    expect(ardoise.transferts).toEqual([
      { from_membership_id: m2, to_membership_id: m1, amount_minor: 333, currency_code: 'EUR' },
      { from_membership_id: m3, to_membership_id: m1, amount_minor: 333, currency_code: 'EUR' },
    ]);
  });

  it('met à jour les soldes après un remboursement déclaré et gère le filtre uniquementConfirmes', () => {
    const parts = repartirDepense(1000, 1000, 'equal', [
      { membership_id: m1 },
      { membership_id: m2 },
      { membership_id: m3 },
    ]);
    const depense: EntreeDepenseSolde = {
      payer_membership_id: m1,
      amount_target_minor: 1000,
      target_currency_code: 'EUR',
      shares: parts,
    };
    const rembNonConfirme: EntreeRemboursementSolde = {
      from_membership_id: m2,
      to_membership_id: m1,
      amount_minor: 333,
      currency_code: 'EUR',
      target_currency_code: 'EUR',
      amount_target_minor: 333,
      confirmed_by_membership_id: null,
    };

    // Par défaut (tous les remboursements actifs) : la dette de m2 est éteinte.
    const avecDeclare = calculerSoldesDevise('EUR', [depense], [rembNonConfirme]);
    expect(avecDeclare.soldes).toEqual([
      { membership_id: m1, net_minor: 333 },
      { membership_id: m2, net_minor: 0 },
      { membership_id: m3, net_minor: -333 },
    ]);
    expect(avecDeclare.transferts).toEqual([
      { from_membership_id: m3, to_membership_id: m1, amount_minor: 333, currency_code: 'EUR' },
    ]);

    // En filtrant uniquement les confirmés : le remboursement non confirmé n'est pas encore déduit.
    const confirmesSeulement = calculerSoldesDevise('EUR', [depense], [rembNonConfirme], {
      uniquementConfirmes: true,
    });
    expect(confirmesSeulement.soldes).toEqual([
      { membership_id: m1, net_minor: 666 },
      { membership_id: m2, net_minor: -333 },
      { membership_id: m3, net_minor: -333 },
    ]);
  });
});

describe('séparation stricte par devise cible et garde-fous', () => {
  it('refuse de mêler deux devises dans calculerSoldesDevise', () => {
    expect(() =>
      calculerSoldesDevise('EUR', [
        {
          payer_membership_id: 'm-1',
          amount_target_minor: 1000,
          target_currency_code: 'JPY',
          shares: [{ membership_id: 'm-1', share_target_minor: 1000 }],
        },
      ]),
    ).toThrowError(ErreurSolde);
  });

  it('refuse une dépense dont les parts ne bouclent pas sur amount_target_minor', () => {
    expect(() =>
      calculerSoldesDevise('EUR', [
        {
          payer_membership_id: 'm-1',
          amount_target_minor: 1000,
          target_currency_code: 'EUR',
          shares: [
            { membership_id: 'm-1', share_target_minor: 500 },
            { membership_id: 'm-2', share_target_minor: 499 },
          ],
        },
      ]),
    ).toThrowError(ErreurSolde);
  });

  it('refuse de suggérer des remboursements si la somme des soldes ne vaut pas 0', () => {
    expect(() =>
      suggererRemboursements(
        [
          { membership_id: 'm-1', net_minor: 500 },
          { membership_id: 'm-2', net_minor: -499 },
        ],
        'EUR',
      ),
    ).toThrowError(ErreurSolde);
  });

  it('groupe proprement les ardoises par devise cible (EUR et JPY séparés)', () => {
    const ardoises = calculerSoldesParDevise([
      {
        payer_membership_id: 'm-1',
        amount_target_minor: 2000,
        target_currency_code: 'JPY',
        shares: [
          { membership_id: 'm-1', share_target_minor: 1000 },
          { membership_id: 'm-2', share_target_minor: 1000 },
        ],
      },
      {
        payer_membership_id: 'm-2',
        amount_target_minor: 1500,
        target_currency_code: 'EUR',
        shares: [
          { membership_id: 'm-1', share_target_minor: 750 },
          { membership_id: 'm-2', share_target_minor: 750 },
        ],
      },
    ]);

    expect(ardoises.map((a) => a.currency_code)).toEqual(['EUR', 'JPY']);
    expect(ardoises[0]?.transferts).toEqual([
      { from_membership_id: 'm-1', to_membership_id: 'm-2', amount_minor: 750, currency_code: 'EUR' },
    ]);
    expect(ardoises[1]?.transferts).toEqual([
      { from_membership_id: 'm-2', to_membership_id: 'm-1', amount_minor: 1000, currency_code: 'JPY' },
    ]);
  });
});

describe('test de propriétés sur 200 suites aléatoires de dépenses, modes, devises et remboursements', () => {
  const DEVISES = [
    { code: 'EUR', exposant: 2 },
    { code: 'JPY', exposant: 0 },
    { code: 'USD', exposant: 2 },
    { code: 'CHF', exposant: 2 },
    { code: 'GBP', exposant: 2 },
  ] as const;

  const MODES: ReadonlyArray<ModeRepartition> = ['equal', 'weights', 'exact'];

  it('vérifie les 4 invariants (a, b, c, d) sur 200 suites complètes multi-devises', () => {
    const alea = creerPrng(90042026);

    for (let suite = 0; suite < 200; suite += 1) {
      const nbMembres = entierAleatoire(alea, 2, 10);
      const membres = Array.from(
        { length: nbMembres },
        (_, i) => `01933b10-0000-7000-8000-${String(i + 1).padStart(12, '0')}`,
      );

      const nbDepenses = entierAleatoire(alea, 1, 15);
      const depenses: EntreeDepenseSolde[] = [];

      for (let d = 0; d < nbDepenses; d += 1) {
        const deviseSource = DEVISES[entierAleatoire(alea, 0, DEVISES.length - 1)] ?? DEVISES[0];
        const deviseCible = DEVISES[entierAleatoire(alea, 0, DEVISES.length - 1)] ?? DEVISES[0];

        const memeDevise = deviseSource.code === deviseCible.code;
        const ratePpm = memeDevise
          ? UNITE_TAUX_PPM
          : deviseSource.code === 'JPY'
            ? entierAleatoire(alea, 5_000, 9_000)
            : deviseCible.code === 'JPY'
              ? entierAleatoire(alea, 130_000_000, 180_000_000)
              : entierAleatoire(alea, 700_000, 1_400_000);

        const nbParticipants = entierAleatoire(alea, 1, nbMembres);
        const sousEnsembleMembres = melanger(alea, membres).slice(0, nbParticipants);
        const mode = MODES[entierAleatoire(alea, 0, MODES.length - 1)] as ModeRepartition;

        let amountMinor = entierAleatoire(alea, 50, 200_000);
        const participants: ParticipantEntree[] = [];

        if (mode === 'equal') {
          for (const id of sousEnsembleMembres) {
            participants.push({ membership_id: id });
          }
        } else if (mode === 'weights') {
          for (const id of sousEnsembleMembres) {
            participants.push({ membership_id: id, weight: entierAleatoire(alea, 1, 10) });
          }
        } else {
          let totalExact = 0;
          for (let i = 0; i < sousEnsembleMembres.length; i += 1) {
            const id = sousEnsembleMembres[i] as string;
            const part = i === 0 ? entierAleatoire(alea, 10, 20_000) : entierAleatoire(alea, 0, 20_000);
            totalExact += part;
            participants.push({ membership_id: id, share_minor: part });
          }
          amountMinor = totalExact;
        }

        const amountTargetMinor = convertirMontant(
          amountMinor,
          ratePpm,
          deviseSource.exposant,
          deviseCible.exposant,
        );

        const parts = repartirDepense(amountMinor, amountTargetMinor, mode, participants);
        const partsOrdreInverse = repartirDepense(
          amountMinor,
          amountTargetMinor,
          mode,
          [...participants].reverse(),
        );

        // (a) Somme des parts = total dans la devise de dépense et dans la devise cible
        expect(parts.reduce((s, p) => s + p.share_minor, 0)).toBe(amountMinor);
        expect(parts.reduce((s, p) => s + p.share_target_minor, 0)).toBe(amountTargetMinor);

        // (c) Reproductibilité de la répartition quel que soit l'ordre des participants
        expect(partsOrdreInverse).toEqual(parts);

        const payeur = membres[entierAleatoire(alea, 0, membres.length - 1)] as string;
        depenses.push({
          payer_membership_id: payeur,
          amount_target_minor: amountTargetMinor,
          target_currency_code: deviseCible.code,
          shares: parts,
        });
      }

      // Génération de remboursements aléatoires déjà déclarés
      const nbRemboursements = entierAleatoire(alea, 0, 6);
      const remboursements: EntreeRemboursementSolde[] = [];
      for (let r = 0; r < nbRemboursements; r += 1) {
        const idxFrom = entierAleatoire(alea, 0, membres.length - 1);
        const idxTo = (idxFrom + entierAleatoire(alea, 1, membres.length - 1)) % membres.length;
        const deviseCible = DEVISES[entierAleatoire(alea, 0, DEVISES.length - 1)] ?? DEVISES[0];

        remboursements.push({
          from_membership_id: membres[idxFrom] as string,
          to_membership_id: membres[idxTo] as string,
          amount_target_minor: entierAleatoire(alea, 1, 10_000),
          target_currency_code: deviseCible.code,
        });
      }

      const ardoises = calculerSoldesParDevise(depenses, remboursements, { membresIds: membres });
      const ardoisesMelangees = calculerSoldesParDevise(
        melanger(alea, depenses),
        melanger(alea, remboursements),
        { membresIds: melanger(alea, membres) },
      );

      // (c) Reproductibilité des soldes et des transferts suggérés quel que soit l'ordre des entrées
      expect(ardoisesMelangees).toEqual(ardoises);

      for (const ardoise of ardoises) {
        // (b) La somme des soldes du groupe pour chaque devise est exactement zéro
        const sommeSoldes = ardoise.soldes.reduce((acc, s) => acc + s.net_minor, 0);
        expect(sommeSoldes).toBe(0);

        // Le nombre de transferts suggérés est au plus N - 1
        expect(ardoise.transferts.length).toBeLessThanOrEqual( Math.max(0, ardoise.soldes.length - 1) );

        // (d) Appliquer tous les remboursements suggérés ramène tous les soldes à 0
        const depensesDevise = depenses.filter((d) => d.target_currency_code === ardoise.currency_code);
        const rembDevise = remboursements.filter(
          (r) => (r.target_currency_code ?? r.currency_code) === ardoise.currency_code,
        );
        const apresReglement = calculerSoldesDevise(
          ardoise.currency_code,
          depensesDevise,
          [...rembDevise, ...ardoise.transferts],
          { membresIds: membres },
        );

        for (const soldeFinal of apresReglement.soldes) {
          expect(soldeFinal.net_minor).toBe(0);
        }
        expect(apresReglement.transferts).toEqual([]);
      }
    }
  });
});
