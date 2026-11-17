// Arithmétique pure de l'argent (modèle de données §3.10, §4.5, §4.6 et ADR-0004).
// Logique PURE : ni base de données, ni Express.
//
// Règles fondamentales :
//  - toute somme est représentée en unités mineures entières (centimes pour EUR, yens pour JPY) ;
//  - aucun calcul ne passe par les nombres à virgule flottante : conversions et saisies passent par BigInt ;
//  - additionner ou soustraire deux montants de devises différentes est une erreur explicite ;
//  - l'exposant de la devise (0 à 4) gouverne la saisie, la conversion et l'affichage.

/** Unité d'un taux de change figé en millionièmes : `1.0` = `1_000_000` ppm. */
export const UNITE_TAUX_PPM = 1_000_000;

/** Bornes d'exposant autorisées par le schéma (`CHECK (exponent BETWEEN 0 AND 4)`). */
export const EXPOSANT_MIN = 0;
export const EXPOSANT_MAX = 4;

export type CodeErreurArgent =
  | 'montant_invalide'
  | 'taux_invalide'
  | 'exposant_invalide'
  | 'devise_invalide'
  | 'devises_differentes'
  | 'depassement_entier';

export class ErreurArgent extends Error {
  readonly code: CodeErreurArgent;

  constructor(code: CodeErreurArgent, message: string) {
    super(message);
    this.name = 'ErreurArgent';
    this.code = code;
  }
}

/** Montant typé portant ses unités mineures entières et son code devise ISO 4217. */
export interface Montant {
  readonly minor: number;
  readonly devise: string;
}

/** Vérifie qu'un code devise respecte le format ISO 4217 (3 lettres majuscules ASCII). */
export function codeDeviseValide(code: string): boolean {
  return typeof code === 'string' && /^[A-Z]{3}$/.test(code);
}

/** Vérifie qu'un exposant de devise est un entier compris entre 0 et 4 inclus. */
export function exposantValide(exposant: number): boolean {
  return Number.isInteger(exposant) && exposant >= EXPOSANT_MIN && exposant <= EXPOSANT_MAX;
}

/** Vérifie qu'un montant d'opération est un entier sûr strictement positif (`> 0`). */
export function montantValide(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

/** Vérifie qu'un montant de part est un entier sûr positif ou nul (`>= 0`). */
export function montantPositifOuNulValide(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

/** Vérifie qu'un taux de change en ppm est un entier sûr strictement positif (`> 0`). */
export function tauxPpmValide(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

/** Fabrique un `Montant` après vérification de l'entier sûr et du code devise. */
export function creerMontant(minor: number, devise: string): Montant {
  if (!Number.isSafeInteger(minor)) {
    throw new ErreurArgent('montant_invalide', `Montant en unités mineures invalide : ${String(minor)}`);
  }
  if (!codeDeviseValide(devise)) {
    throw new ErreurArgent('devise_invalide', `Code devise ISO 4217 invalide : ${String(devise)}`);
  }
  return { minor, devise };
}

/**
 * Additionne deux montants de même devise.
 * Lève `ErreurArgent('devises_differentes')` si les devises diffèrent (ADR-0004).
 */
export function additionnerMontants(a: Montant, b: Montant): Montant {
  if (!codeDeviseValide(a.devise) || !codeDeviseValide(b.devise)) {
    throw new ErreurArgent('devise_invalide', 'Code devise ISO 4217 invalide.');
  }
  if (a.devise !== b.devise) {
    throw new ErreurArgent(
      'devises_differentes',
      `Impossible d'additionner deux devises différentes (${a.devise} et ${b.devise}).`,
    );
  }
  if (!Number.isSafeInteger(a.minor) || !Number.isSafeInteger(b.minor)) {
    throw new ErreurArgent('montant_invalide', 'Les montants à additionner doivent être des entiers sûrs.');
  }
  const somme = a.minor + b.minor;
  if (!Number.isSafeInteger(somme)) {
    throw new ErreurArgent('depassement_entier', 'Dépassement de capacité entière lors de l’addition.');
  }
  return { minor: somme, devise: a.devise };
}

/**
 * Soustrait deux montants de même devise (`a - b`).
 * Lève `ErreurArgent('devises_differentes')` si les devises diffèrent (ADR-0004).
 */
export function soustraireMontants(a: Montant, b: Montant): Montant {
  if (!codeDeviseValide(a.devise) || !codeDeviseValide(b.devise)) {
    throw new ErreurArgent('devise_invalide', 'Code devise ISO 4217 invalide.');
  }
  if (a.devise !== b.devise) {
    throw new ErreurArgent(
      'devises_differentes',
      `Impossible de soustraire deux devises différentes (${a.devise} et ${b.devise}).`,
    );
  }
  if (!Number.isSafeInteger(a.minor) || !Number.isSafeInteger(b.minor)) {
    throw new ErreurArgent('montant_invalide', 'Les montants à soustraire doivent être des entiers sûrs.');
  }
  const difference = a.minor - b.minor;
  if (!Number.isSafeInteger(difference)) {
    throw new ErreurArgent('depassement_entier', 'Dépassement de capacité entière lors de la soustraction.');
  }
  return { minor: difference, devise: a.devise };
}

/**
 * Convertit un montant total d'une devise source vers une devise cible (§4.5 du modèle de données).
 *
 * Avec `d = exposantCible - exposantSource` :
 *   numérateur   = amountMinor × ratePpm × 10^max(0, d)
 *   dénominateur = 1_000_000 × 10^max(0, -d)
 *   amountTargetMinor = (numérateur + dénominateur / 2) / dénominateur  (division entière BigInt, moitié vers le haut)
 */
export function convertirMontant(
  amountMinor: number,
  ratePpm: number,
  exposantSource: number,
  exposantCible: number,
): number {
  if (!montantValide(amountMinor)) {
    throw new ErreurArgent('montant_invalide', `Le montant à convertir doit être un entier strictement positif : ${String(amountMinor)}`);
  }
  if (!tauxPpmValide(ratePpm)) {
    throw new ErreurArgent('taux_invalide', `Le taux en ppm doit être un entier strictement positif : ${String(ratePpm)}`);
  }
  if (!exposantValide(exposantSource) || !exposantValide(exposantCible)) {
    throw new ErreurArgent(
      'exposant_invalide',
      `Exposants de devise invalides : source=${String(exposantSource)}, cible=${String(exposantCible)}`,
    );
  }

  if (ratePpm === UNITE_TAUX_PPM && exposantSource === exposantCible) {
    return amountMinor;
  }

  const d = exposantCible - exposantSource;
  const facteurNumerateur = 10n ** BigInt(Math.max(0, d));
  const facteurDenominateur = 10n ** BigInt(Math.max(0, -d));

  const numerateur = BigInt(amountMinor) * BigInt(ratePpm) * facteurNumerateur;
  const denominateur = BigInt(UNITE_TAUX_PPM) * facteurDenominateur;
  const cibleBigInt = (numerateur + denominateur / 2n) / denominateur;

  if (cibleBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ErreurArgent('depassement_entier', 'Le montant converti dépasse la capacité des entiers sûrs.');
  }

  const resultat = Number(cibleBigInt);
  if (!Number.isSafeInteger(resultat) || resultat <= 0) {
    throw new ErreurArgent('montant_invalide', 'Le montant converti doit être strictement positif.');
  }

  return resultat;
}

/**
 * Analyse une saisie humaine et la convertit en unités mineures entières sans passer par un flottant (§4.6).
 *
 * - Si `exposant === 0` (ex. JPY), toute virgule ou point décimal est refusé (`"1000,50"` -> `null`, jamais tronqué).
 * - Si `exposant > 0`, accepte un entier ou un décimal (séparateur `,` ou `.`) ayant au plus `exposant` chiffres après le séparateur.
 * - Retourne `null` si la saisie est mal formée, négative, nulle ou hors des entiers sûrs.
 */
export function analyserMontantSaisi(saisie: string, exposant: number): number | null {
  if (!exposantValide(exposant)) {
    throw new ErreurArgent('exposant_invalide', `Exposant de devise invalide : ${String(exposant)}`);
  }
  if (typeof saisie !== 'string') {
    return null;
  }

  const texte = saisie.trim();
  if (texte === '') {
    return null;
  }

  if (exposant === 0) {
    if (!/^\d+$/.test(texte)) {
      return null;
    }
    const valeur = BigInt(texte);
    if (valeur <= 0n || valeur > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    return Number(valeur);
  }

  const correspondance = texte.match(/^(\d+)(?:[,.](\d+))?$/);
  if (!correspondance) {
    return null;
  }

  const partieEntiere = correspondance[1] ?? '';
  const partieDecimale = correspondance[2] ?? '';
  if (partieDecimale.length > exposant) {
    return null;
  }

  const decimalesCompletes = partieDecimale.padEnd(exposant, '0');
  const facteur = 10n ** BigInt(exposant);
  const valeur = BigInt(partieEntiere) * facteur + BigInt(decimalesCompletes);

  if (valeur <= 0n || valeur > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }

  return Number(valeur);
}

/**
 * Formate un montant en unités mineures pour l'affichage en français selon sa devise et son exposant (§4.6).
 */
export function formaterMontant(amountMinor: number, codeDevise: string, exposant: number): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new ErreurArgent('montant_invalide', `Montant en unités mineures invalide : ${String(amountMinor)}`);
  }
  if (!codeDeviseValide(codeDevise)) {
    throw new ErreurArgent('devise_invalide', `Code devise ISO 4217 invalide : ${String(codeDevise)}`);
  }
  if (!exposantValide(exposant)) {
    throw new ErreurArgent('exposant_invalide', `Exposant de devise invalide : ${String(exposant)}`);
  }

  const formateur = new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: codeDevise,
    minimumFractionDigits: exposant,
    maximumFractionDigits: exposant,
  });

  return formateur.format(amountMinor / 10 ** exposant);
}
