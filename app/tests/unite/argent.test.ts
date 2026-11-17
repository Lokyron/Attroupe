import { describe, expect, it } from 'vitest';
import {
  additionnerMontants,
  analyserMontantSaisi,
  codeDeviseValide,
  convertirMontant,
  creerMontant,
  ErreurArgent,
  exposantValide,
  formaterMontant,
  montantPositifOuNulValide,
  montantValide,
  soustraireMontants,
  tauxPpmValide,
  UNITE_TAUX_PPM,
} from '../../server/domain/argent.js';

describe('validations élémentaires et constantes', () => {
  it('définit UNITE_TAUX_PPM à 1 000 000', () => {
    expect(UNITE_TAUX_PPM).toBe(1_000_000);
  });

  it('valide les montants strictement positifs en unités mineures', () => {
    expect(montantValide(1)).toBe(true);
    expect(montantValide(1000)).toBe(true);
    expect(montantValide(0)).toBe(false);
    expect(montantValide(-10)).toBe(false);
    expect(montantValide(12.34)).toBe(false);
    expect(montantValide(Number.NaN)).toBe(false);
    expect(montantValide(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it('valide les montants positifs ou nuls et les taux en ppm', () => {
    expect(montantPositifOuNulValide(0)).toBe(true);
    expect(montantPositifOuNulValide(500)).toBe(true);
    expect(montantPositifOuNulValide(-1)).toBe(false);

    expect(tauxPpmValide(UNITE_TAUX_PPM)).toBe(true);
    expect(tauxPpmValide(1)).toBe(true);
    expect(tauxPpmValide(0)).toBe(false);
    expect(tauxPpmValide(-100)).toBe(false);
    expect(tauxPpmValide(1.5)).toBe(false);
  });

  it('valide les codes ISO 4217 et les exposants (0 à 4)', () => {
    expect(codeDeviseValide('EUR')).toBe(true);
    expect(codeDeviseValide('JPY')).toBe(true);
    expect(codeDeviseValide('eur')).toBe(false);
    expect(codeDeviseValide('EU')).toBe(false);
    expect(codeDeviseValide('EURO')).toBe(false);

    for (const e of [0, 1, 2, 3, 4]) expect(exposantValide(e)).toBe(true);
    for (const e of [-1, 5, 2.5, Number.NaN]) expect(exposantValide(e)).toBe(false);
  });
});

describe('Montant typé et interdiction de mêler deux devises (ADR-0004)', () => {
  it('additionne et soustrait deux montants de même devise', () => {
    const a = creerMontant(1250, 'EUR');
    const b = creerMontant(750, 'EUR');
    expect(additionnerMontants(a, b)).toEqual({ minor: 2000, devise: 'EUR' });
    expect(soustraireMontants(a, b)).toEqual({ minor: 500, devise: 'EUR' });
  });

  it('refuse d’additionner ou de soustraire deux devises différentes', () => {
    const eur = creerMontant(1000, 'EUR');
    const jpy = creerMontant(1000, 'JPY');

    expect(() => additionnerMontants(eur, jpy)).toThrowError(ErreurArgent);
    try {
      additionnerMontants(eur, jpy);
    } catch (err) {
      expect(err).toBeInstanceOf(ErreurArgent);
      expect((err as ErreurArgent).code).toBe('devises_differentes');
    }

    expect(() => soustraireMontants(eur, jpy)).toThrowError(ErreurArgent);
  });
});

describe('convertirMontant (BigInt, exposants, arrondi moitié vers le haut)', () => {
  it('retourne le montant intact quand le taux est neutre et l’exposant identique', () => {
    expect(convertirMontant(2500, UNITE_TAUX_PPM, 2, 2)).toBe(2500);
    expect(convertirMontant(1000, UNITE_TAUX_PPM, 0, 0)).toBe(1000);
  });

  it('convertit de EUR (exposant 2) vers JPY (exposant 0)', () => {
    // 10,00 € (1000 centimes) au taux 1 EUR = 160 JPY (ratePpm = 160_000_000) -> 1600 ¥
    expect(convertirMontant(1000, 160_000_000, 2, 0)).toBe(1600);
    // 12,34 € (1234 centimes) à 160 JPY -> 1974,4 ¥ -> arrondi à 1974 ¥
    expect(convertirMontant(1234, 160_000_000, 2, 0)).toBe(1974);
    // 12,35 € (1235 centimes) à 159 JPY -> 1235 * 159 / 100 = 1963,65 ¥ -> arrondi à 1964 ¥
    expect(convertirMontant(1235, 159_000_000, 2, 0)).toBe(1964);
  });

  it('convertit de JPY (exposant 0) vers EUR (exposant 2)', () => {
    // 1600 ¥ au taux 1 JPY = 0,00625 EUR (ratePpm = 6250) -> 10,00 € (1000 centimes)
    expect(convertirMontant(1600, 6250, 0, 2)).toBe(1000);
    // 1000 ¥ au taux 1 JPY = 0,006123 EUR (ratePpm = 6123) -> 6,123 € -> 612 centimes
    expect(convertirMontant(1000, 6123, 0, 2)).toBe(612);
    // 1000 ¥ au taux 1 JPY = 0,006125 EUR (ratePpm = 6125) -> 6,125 € -> 612,5 centimes -> 613 centimes (moitié vers le haut)
    expect(convertirMontant(1000, 6125, 0, 2)).toBe(613);
  });

  it('arrondit exactement au plus proche, moitié vers le haut (half-up)', () => {
    // Même exposant (2 -> 2) : dénominateur = 1_000_000.
    // amountMinor = 1, ratePpm = 1_499_999 -> 1,499999 -> 1
    expect(convertirMontant(1, 1_499_999, 2, 2)).toBe(1);
    // amountMinor = 1, ratePpm = 1_500_000 -> 1,500000 -> 2
    expect(convertirMontant(1, 1_500_000, 2, 2)).toBe(2);
    // amountMinor = 1, ratePpm = 2_500_000 -> 2,500000 -> 3 (moitié vers le haut, pas pair/impair)
    expect(convertirMontant(1, 2_500_000, 2, 2)).toBe(3);
  });

  it('ne déborde pas sur de grands montants grâce à BigInt en interne', () => {
    // 50_000_000_00 centimes (50 millions d'euros) * 160_000_000 ppm dépasserait Number.MAX_SAFE_INTEGER au numérateur (8e17 > 9e15),
    // mais en BigInt le calcul est exact et donne 8_000_000_000 ¥.
    expect(convertirMontant(5_000_000_000, 160_000_000, 2, 0)).toBe(8_000_000_000);
  });

  it('refuse les montants, taux ou exposants invalides', () => {
    expect(() => convertirMontant(0, UNITE_TAUX_PPM, 2, 2)).toThrowError(ErreurArgent);
    expect(() => convertirMontant(-100, UNITE_TAUX_PPM, 2, 2)).toThrowError(ErreurArgent);
    expect(() => convertirMontant(100, 0, 2, 2)).toThrowError(ErreurArgent);
    expect(() => convertirMontant(100, UNITE_TAUX_PPM, -1, 2)).toThrowError(ErreurArgent);
    expect(() => convertirMontant(100, UNITE_TAUX_PPM, 2, 5)).toThrowError(ErreurArgent);
    // Conversion qui s'arrondirait à 0 unité mineure : refusée (CHECK amount_target_minor > 0)
    expect(() => convertirMontant(1, 1, 2, 0)).toThrowError(ErreurArgent);
  });
});

describe('analyserMontantSaisi (saisie décimale sans flottant et cas JPY exposant 0)', () => {
  it('convertit les saisies en EUR (exposant 2) sans erreur de flottant', () => {
    expect(analyserMontantSaisi('10', 2)).toBe(1000);
    expect(analyserMontantSaisi('10,5', 2)).toBe(1050);
    expect(analyserMontantSaisi('10,50', 2)).toBe(1050);
    expect(analyserMontantSaisi('10.50', 2)).toBe(1050);
    expect(analyserMontantSaisi('  19,99  ', 2)).toBe(1999);
    expect(analyserMontantSaisi('0,01', 2)).toBe(1);
  });

  it('refuse toute décimale ou virgule en JPY (exposant 0) sans jamais tronquer (§4.6)', () => {
    expect(analyserMontantSaisi('1000', 0)).toBe(1000);
    expect(analyserMontantSaisi('1000,50', 0)).toBeNull();
    expect(analyserMontantSaisi('1000.50', 0)).toBeNull();
    expect(analyserMontantSaisi('1000,00', 0)).toBeNull();
    expect(analyserMontantSaisi('1000,0', 0)).toBeNull();
    expect(analyserMontantSaisi('1000,', 0)).toBeNull();
  });

  it('refuse un nombre de décimales supérieur à l’exposant de la devise', () => {
    expect(analyserMontantSaisi('10,555', 2)).toBeNull();
    expect(analyserMontantSaisi('1,234', 3)).toBe(1234);
    expect(analyserMontantSaisi('1,2345', 3)).toBeNull();
    expect(analyserMontantSaisi('1,2345', 4)).toBe(12345);
  });

  it('refuse zéro, les montants négatifs et les chaînes mal formées', () => {
    expect(analyserMontantSaisi('0', 0)).toBeNull();
    expect(analyserMontantSaisi('0', 2)).toBeNull();
    expect(analyserMontantSaisi('0,00', 2)).toBeNull();
    expect(analyserMontantSaisi('-10', 2)).toBeNull();
    expect(analyserMontantSaisi('+10', 2)).toBeNull();
    expect(analyserMontantSaisi('', 2)).toBeNull();
    expect(analyserMontantSaisi('   ', 2)).toBeNull();
    expect(analyserMontantSaisi(',50', 2)).toBeNull();
    expect(analyserMontantSaisi('10,', 2)).toBeNull();
    expect(analyserMontantSaisi('10,5,0', 2)).toBeNull();
    expect(analyserMontantSaisi('12abc', 2)).toBeNull();
  });
});

describe('formaterMontant (Intl.NumberFormat fr-FR)', () => {
  it('formate un montant en EUR avec 2 décimales et en JPY avec 0 décimale', () => {
    const eur = formaterMontant(1050, 'EUR', 2);
    expect(eur).toContain('10,50');
    expect(eur).toContain('€');

    const jpy = formaterMontant(1000, 'JPY', 0);
    expect(jpy).not.toContain(',');
    expect(jpy).toMatch(/1[\s\u00a0\u202f]?000/);
  });

  it('accepte un solde nul ou négatif pour l’affichage des ardoises', () => {
    expect(formaterMontant(0, 'EUR', 2)).toContain('0,00');
    expect(formaterMontant(-333, 'EUR', 2)).toContain('3,33');
  });
});
