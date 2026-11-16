import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOSSIER_DB, FIXTURE_BRUT, RACINE_APP, violationsDuVerrou } from '../fixtures/verrou-db.js';

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

    // Lot 5 : les POUVOIRS de db/ (creerScope, creerPorteeUtilisateur, preparer, preparerTransverse, migrate) se jugent sur le chemin RÉSOLU.
    // La regex d'ESLint compare du texte : `db/queries/../scope.js` et `db/.//scope.js` lui échappaient (défaut du lot 1).
    describe('les pouvoirs de db/ se jugent sur le chemin résolu', () => {
      const route = join(RACINE_APP, 'server', 'http', 'routes', 'ical.ts');
      const middleware = (nom: string): string => join(RACINE_APP, 'server', 'http', 'middleware', nom);
      const bloque: ReadonlyArray<[string, string, string]> = [
        ['creerScope par un segment « .. » (sonde 2)', "import { creerScope } from '../../db/queries/../scope.js';", route],
        ['creerScope par « ./ » doublé (sonde 3)', "import { creerScope } from '../../db/.//scope.js';", route],
        ['preparerTransverse par un segment « .. » (sonde 4)', "import { preparerTransverse } from '../../db/queries/../sql.js';", route],
        ['preparer par un segment « .. »', "import { preparer } from '../../db/queries/../sql.js';", route],
        ['creerScope par un détour par un autre dossier', "import { creerScope } from '../routes/../../db/scope.js';", route],
        ['creerPorteeUtilisateur par un segment « .. »', "import { creerPorteeUtilisateur } from '../../db/queries/../portee-utilisateur.js';", route],
        ['creerPorteeUtilisateur depuis un 4e fichier (csrf.ts)', "import { creerPorteeUtilisateur } from '../../db/portee-utilisateur.js';", middleware('csrf.ts')],
        ['creerScope depuis un 4e fichier (cadence.ts)', "import { creerScope } from '../../db/scope.js';", middleware('cadence.ts')],
        ['creerScope depuis session.ts (il ne fabrique que des portées de compte)', "import { creerScope } from '../../db/scope.js';", middleware('session.ts')],
        ['creerScope renommé', "import { creerScope as c } from '../../db/scope.js';", route],
        ['creerScope parmi des types', "import { type GroupScope, creerScope } from '../../db/scope.js';", route],
        ['baseDeScope', "import { baseDeScope } from '../../db/queries/../scope.js';", middleware('jeton-flux.ts')],
        ['baseDe', "import { baseDe } from '../../db/portee-utilisateur.js';", middleware('appartenance.ts')],
        ['espace de noms de db/scope', "import * as scope from '../../db/queries/../scope.js';", route],
        ['import() de db/scope', "const m = await import('../../db/queries/../scope.js');", route],
        ['require de db/sql', "const m = require('../../db/./sql.js');", route],
        ['ré-export de db/scope', "export { creerScope } from '../../db/queries/../scope.js';", route],
        ['ré-export * de db/portee-utilisateur', "export * from '../../db/portee-utilisateur.js';", middleware('session.ts')],
        ['db/migrate hors index.ts', "import { ouvrirEtMigrer } from '../../db/queries/../migrate.js';", route],
        ['preparerTransverse depuis un autre fichier de db/', "import { preparerTransverse } from '../sql.js';", dansQueries],
        ['espace de noms de db/sql depuis un autre fichier de db/queries', "import * as sql from '../sql.js';", dansQueries],
      ];
      it.each(bloque)('bloque %s', (_nom, code, fichier) => {
        expect(violationsDuVerrou(code, fichier)).not.toEqual([]);
      });

      const autorise: ReadonlyArray<[string, string, string]> = [
        ['creerScope depuis appartenance.ts', "import { creerScope } from '../../db/scope.js';", middleware('appartenance.ts')],
        ['creerScope depuis jeton-flux.ts', "import { creerScope } from '../../db/queries/../scope.js';", middleware('jeton-flux.ts')],
        ['creerPorteeUtilisateur depuis session.ts', "import { creerPorteeUtilisateur } from '../../db/portee-utilisateur.js';", middleware('session.ts')],
        ['creerPorteeUtilisateur depuis jeton-flux.ts', "import { creerPorteeUtilisateur } from '../../db/portee-utilisateur.js';", middleware('jeton-flux.ts')],
        ['db/migrate depuis index.ts', "import { fermer } from './db/migrate.js';", join(RACINE_APP, 'server', 'index.ts')],
        ['preparer depuis db/queries', "import { preparer } from '../sql.js';", dansQueries],
        ['preparerTransverse depuis transverse.ts', "import { preparerTransverse } from '../sql.js';", join(DOSSIER_DB, 'queries', 'transverse.ts')],
        ['baseDeScope depuis db/queries', "import { baseDeScope } from '../scope.js';", dansQueries],
        ['les types (GroupScope, PorteeUtilisateur) depuis une route', "import type { GroupScope } from '../../db/scope.js';\nimport { type PorteeUtilisateur } from '../../db/portee-utilisateur.js';", route],
        ['une constante ou une classe d’erreur de db/scope', "import { ErreurAppartenance } from '../../db/queries/../scope.js';", route],
        ['les tests amorcent la base à la main', "import { creerScope } from '../../server/db/scope.js';", join(RACINE_APP, 'tests', 'fixtures', 'base.ts')],
      ];
      it.each(autorise)('laisse passer %s', (_nom, code, fichier) => {
        expect(violationsDuVerrou(code, fichier)).toEqual([]);
      });
    });

    it('la fixture brut.ts est la seule exception côté tests', () => {
      const import_ = "import { connexionBrute } from '../../server/db/connection.js';";
      expect(violationsDuVerrou(import_, FIXTURE_BRUT)).toEqual([]);
      expect(violationsDuVerrou(import_, join(RACINE_APP, 'tests', 'fixtures', 'base.ts'))).not.toEqual([]);
      expect(violationsDuVerrou("export { connexionBrute } from '../../server/db/connection.js';", FIXTURE_BRUT)).not.toEqual([]);
      expect(violationsDuVerrou("import Database from 'better-sqlite3';", FIXTURE_BRUT)).not.toEqual([]);
    });

    it('laisse passer l’usage légitime dans db/', () => {
      expect(violationsDuVerrou("import { db } from '../connection.js';", dansQueries)).toEqual([]);
      expect(violationsDuVerrou("import Database from 'better-sqlite3';", CONNECTION)).toEqual([]);
    });
  });
});
