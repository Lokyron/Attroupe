import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseTemporaire, type BaseTemporaire } from '../fixtures/base.js';
import { listerFichiers } from '../fixtures/lister.js';
import { listerTables } from '../fixtures/schema.js';

// Règle non négociable n° 2 : aucun flux bancaire, aucun IBAN stocké.
// Deux contrôles : le texte du code et des migrations, puis les colonnes réelles de la base.
const RACINE_APP = join(import.meta.dirname, '..', '..');
// Sous-chaînes, sans \b : `\b` traite `_` comme une lettre et laisserait passer `user_iban` ou `ibanCompte`.
// « bic » et « rib » sont trop courts pour une sous-chaîne pure (« describe », « attribut ») :
// ils ne comptent que s'ils ne touchent pas une autre lettre (`_` et chiffres sont des bornes).
const DOSSIER_MIGRATIONS = join(RACINE_APP, 'migrations');
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

// Architecture §4, verrou 5 : aucune colonne ne doit correspondre à ces motifs LIKE.
const MOTIFS_COLONNES = ['%iban%', '%bic%', '%card%', '%payment%', '%account_number%'];

describe('aucune colonne bancaire dans la base migrée', () => {
  let t: BaseTemporaire;
  beforeAll(() => {
    t = baseTemporaire();
  });
  afterAll(() => t.nettoyer());

  const colonnes = (): string[] =>
    listerTables(t.sql).flatMap((table) =>
      t.sql.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(table) as string[],
    );

  it('parcourt bien les colonnes de la base', () => {
    expect(colonnes().length).toBeGreaterThan(200);
  });

  it.each(MOTIFS_COLONNES)('aucune colonne ne correspond à « %s »', (motif) => {
    const fautives = colonnes().filter(
      (nom) => t.sql.prepare('SELECT ? LIKE ?').pluck().get(nom, motif) === 1,
    );
    expect(fautives).toEqual([]);
  });

  it('le motif LIKE détecte bien un nom bancaire (le contrôle n’est pas vide)', () => {
    expect(t.sql.prepare("SELECT 'user_iban' LIKE '%iban%'").pluck().get()).toBe(1);
  });
});
