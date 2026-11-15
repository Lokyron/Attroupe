import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listerFichiers } from '../fixtures/lister.js';

// Règle non négociable n° 2 : aucun flux bancaire, aucun IBAN stocké.
// Dès le lot 1, ce contrôle s'étendra aux colonnes réelles de la base (PRAGMA table_info).
const RACINE_APP = join(import.meta.dirname, '..', '..');
// Sous-chaînes, sans \b : `\b` traite `_` comme une lettre et laisserait passer `user_iban` ou `ibanCompte`.
// « bic » et « rib » sont trop courts pour une sous-chaîne pure (« describe », « attribut ») :
// ils ne comptent que s'ils ne touchent pas une autre lettre (`_` et chiffres sont des bornes).
const DOSSIER_MIGRATIONS = join(RACINE_APP, 'migrations'); // créé au lot 1
const MOTS_BANCAIRES = /iban|swift|card|payment|account_number|stripe|paypal|(?<![a-z])(bic|rib)(?![a-z])/i;

describe('aucune notion bancaire dans le code applicatif', () => {
  const fichiers = [
    ...listerFichiers(join(RACINE_APP, 'server'), ['.ts', '.sql', '.json']),
    ...(existsSync(DOSSIER_MIGRATIONS) ? listerFichiers(DOSSIER_MIGRATIONS, ['.sql', '.ts']) : []),
    ...listerFichiers(join(RACINE_APP, 'client', 'src'), ['.ts', '.tsx', '.json']),
  ];

  it('trouve bien des fichiers à contrôler', () => {
    expect(fichiers.length).toBeGreaterThan(0);
  });

  it.each(['user_iban', 'ibanCompte', 'credit_card', 'payment', 'account_number', 'PayPal', 'rib_titulaire', 'BIC'])(
    'le motif détecte « %s »',
    (nom) => {
      expect(MOTS_BANCAIRES.test(nom)).toBe(true);
    },
  );

  it.each(['describe', 'attribute', 'contribution'])('le motif laisse passer « %s »', (nom) => {
    expect(MOTS_BANCAIRES.test(nom)).toBe(false);
  });

  it('ne mentionne ni IBAN, ni carte, ni service de paiement', () => {
    const fautifs = fichiers.filter((f) => MOTS_BANCAIRES.test(readFileSync(f, 'utf8')));
    expect(fautifs).toEqual([]);
  });
});
