import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOSSIER_DB, RACINE_APP, violationsDuVerrou } from '../fixtures/verrou-db.js';

// Filet de sécurité de la règle ESLint (verrou n° 5, architecture §4) : même si la
// configuration du linter dérivait, ce test échouerait. Il s'appuie sur le compilateur
// TypeScript et compare le chemin résolu des modules, pas le texte du spécificateur.
const EXTENSIONS_CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

/** Tous les fichiers de code de app/, hors node_modules et hors dist/ de premier niveau de chaque paquet. */
function fichiersDeCode(): string[] {
  return readdirSync(RACINE_APP, { recursive: true, encoding: 'utf8' })
    .filter((chemin) => EXTENSIONS_CODE.test(chemin))
    .filter((chemin) => {
      const segments = chemin.split(sep);
      return !segments.includes('node_modules') && segments[1] !== 'dist';
    })
    .map((chemin) => join(RACINE_APP, chemin));
}

const CONNECTION = join(DOSSIER_DB, 'connection.ts');

describe('verrou n° 5 : seul app/server/db/ parle à la base', () => {
  const fichiers = fichiersDeCode();

  it('trouve bien des fichiers à contrôler', () => {
    expect(fichiers.length).toBeGreaterThan(0);
  });

  it('aucun fichier ne contourne le verrou (imports résolus, ré-exports, import() et require)', () => {
    const fautifs = fichiers.flatMap((f) =>
      violationsDuVerrou(readFileSync(f, 'utf8'), f).map((v) => `${relative(RACINE_APP, f)} ${v}`),
    );
    expect(fautifs).toEqual([]);
  });

  // Preuve que l'analyseur lui-même voit les contournements (pas seulement le code actuel).
  describe('l’analyseur détecte les contournements', () => {
    const dehors = join(RACINE_APP, 'server', 'http', 'routes.ts');
    const dansQueries = join(DOSSIER_DB, 'queries', 'articles.ts');
    const cas: ReadonlyArray<[string, string, string]> = [
      ['point intermédiaire', "import { db } from '../db/./connection.js';", dehors],
      ['double barre', "import { db } from '../db//connection.js';", dehors],
      ['import() littéral', "const m = await import('../db/connection.js');", dehors],
      ['import() en gabarit', 'const m = await import(`../db/connection.js`);', dehors],
      ['import() non littéral', 'const m = await import(nom);', dehors],
      ['createRequire', "createRequire(import.meta.url)('../db/connection.js');", dehors],
      ['require non littéral', 'const m = require(nom);', dehors],
      ['sous-chemin de la bibliothèque', "import d from 'better-sqlite3/lib/database.js';", dehors],
      ['sqlite3', "import s from 'sqlite3';", dehors],
      ['fichier .mts', "import { db } from '../db/connection.js';", join(RACINE_APP, 'server', 'http', 'x.mts')],
      ['fichier .cts', "import { db } from '../db/connection.js';", join(RACINE_APP, 'server', 'http', 'x.cts')],
      ['fichier-baril', "export * from './connection.js';", join(DOSSIER_DB, 'index.ts')],
      ['fichier-baril nommé', "export { db } from './connection.js';", join(DOSSIER_DB, 'index.ts')],
      ['bibliothèque depuis queries/', "const m = await import('better-sqlite3');", dansQueries],
      ['sous-dossier dist/', "import { db } from '../../db/connection.js';", join(RACINE_APP, 'server', 'http', 'dist', 'x.ts')],
      ['chemin détourné', "import { db } from '../db/queries/../connection.js';", dehors],
    ];

    it.each(cas)('%s', (_nom, code, fichier) => {
      expect(violationsDuVerrou(code, fichier)).not.toEqual([]);
    });

    it('laisse passer l’usage légitime dans db/', () => {
      expect(violationsDuVerrou("import { db } from '../connection.js';", dansQueries)).toEqual([]);
      expect(violationsDuVerrou("import Database from 'better-sqlite3';", CONNECTION)).toEqual([]);
    });
  });
});
