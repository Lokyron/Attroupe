import { join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Preuve, par ESLint.lintText, que chaque interdiction du lot 1 corrigé se déclenche réellement :
//  - .prepare, .exec, .pragma hors de db/ (et, dans db/, hors de connection/sql/migrate) ;
//  - db/sql, db/migrate et creerScope réservés à leurs clients légitimes ;
//  - preparerTransverse réservé à db/queries/transverse.ts ; connexionBrute à sql/migrate/connection.
// Sans ce test, une règle pourrait être inopérante sans que personne ne le voie.
const RACINE = join(import.meta.dirname, '..', '..', '..');
const eslint = new ESLint({ cwd: RACINE });
const chemin = (...segments: string[]): string => join(RACINE, 'app', ...segments);

async function reglesDeclenchees(code: string, filePath: string): Promise<string[]> {
  const [resultat] = await eslint.lintText(code, { filePath });
  return (resultat?.messages ?? []).filter((m) => m.ruleId?.startsWith('no-restricted-') ?? false).map((m) => m.ruleId ?? '');
}

const ROUTES = chemin('server', 'http', 'routes.ts');
const INDEX = chemin('server', 'index.ts');
const APPARTENANCE = chemin('server', 'http', 'middleware', 'appartenance.ts');
const QUERIES = chemin('server', 'db', 'queries', 'articles.ts');
const TRANSVERSE = chemin('server', 'db', 'queries', 'transverse.ts');
const SQL = chemin('server', 'db', 'sql.ts');
const MIGRATE = chemin('server', 'db', 'migrate.ts');
const CONNECTION = chemin('server', 'db', 'connection.ts');
const SCOPE = chemin('server', 'db', 'scope.ts');
const UN_TEST = chemin('tests', 'cloisonnement', 'exemple.test.ts');

const BLOQUE: ReadonlyArray<[string, string, string]> = [
  // Appels bruts hors de db/
  ['.prepare dans une route', "export const f = (b: { prepare: (s: string) => void }) => b.prepare('SELECT * FROM events');", ROUTES],
  ['.exec dans une route', "export const f = (b: { exec: (s: string) => void }) => b.exec('DELETE FROM events');", ROUTES],
  ['.pragma dans une route', "export const f = (b: { pragma: (s: string) => void }) => b.pragma('foreign_keys = OFF');", ROUTES],
  ['.prepare par chaînage optionnel', "export const f = (b?: { prepare: (s: string) => void }) => b?.prepare('x');", ROUTES],
  ['.prepare par crochets', "export const f = (b: Record<string, (s: string) => void>) => b['prepare']?.('x');", ROUTES],
  ['.prepare dans index.ts', "export const f = (b: { prepare: (s: string) => void }) => b.prepare('x');", INDEX],
  ['.prepare dans l’intergiciel d’appartenance', "export const f = (b: { prepare: (s: string) => void }) => b.prepare('x');", APPARTENANCE],
  ['.prepare dans db/queries', "export const f = (b: { prepare: (s: string) => void }) => b.prepare('x');", QUERIES],
  ['.exec dans db/scope.ts', "export const f = (b: { exec: (s: string) => void }) => b.exec('x');", SCOPE],
  // db/sql
  ['import de db/sql depuis une route', "import { preparer } from '../db/sql.js';\nexport default preparer;", ROUTES],
  ['import de db/sql depuis index.ts', "import { preparer } from './db/sql.js';\nexport default preparer;", INDEX],
  ['import de db/sql depuis l’intergiciel', "import { preparer } from '../../db/sql.js';\nexport default preparer;", APPARTENANCE],
  ['import de db/sql avec chemin détourné', "import { preparer } from '../db/./sql.js';\nexport default preparer;", ROUTES],
  ['import() de db/sql', "export const f = async () => await import('../db/sql.js');", ROUTES],
  ['ré-export de db/sql', "export { preparer } from '../db/sql.js';", ROUTES],
  ['ré-export * de db/scope', "export * from '../db/scope.js';", ROUTES],
  // db/migrate
  ['import de db/migrate depuis une route', "import { ouvrirEtMigrer } from '../db/migrate.js';\nexport default ouvrirEtMigrer;", ROUTES],
  ['import de db/migrate depuis l’intergiciel', "import { fermer } from '../../db/migrate.js';\nexport default fermer;", APPARTENANCE],
  ['import() de db/migrate', "export const f = async () => await import('../db/migrate.js');", ROUTES],
  // creerScope et creerPorteeUtilisateur
  ['creerScope depuis une route', "import { creerScope } from '../db/scope.js';\nexport default creerScope;", ROUTES],
  ['creerScope depuis index.ts', "import { creerScope } from './db/scope.js';\nexport default creerScope;", INDEX],
  ['creerScope renommé', "import { creerScope as c } from '../db/scope.js';\nexport default c;", ROUTES],
  ['creerScope par espace de noms', "import * as scope from '../db/scope.js';\nexport default scope;", ROUTES],
  ['creerScope par import()', "export const f = async () => await import('../db/scope.js');", ROUTES],
  ['creerScope ré-exporté', "export { creerScope } from '../db/scope.js';", ROUTES],
  ['creerPorteeUtilisateur depuis une route', "import { creerPorteeUtilisateur } from '../db/portee-utilisateur.js';\nexport default creerPorteeUtilisateur;", ROUTES],
  ['creerPorteeUtilisateur depuis index.ts', "import { creerPorteeUtilisateur } from './db/portee-utilisateur.js';\nexport default creerPorteeUtilisateur;", INDEX],
  // Canal transverse et connexion brute, dans db/
  ['preparerTransverse hors de transverse.ts', "import { preparerTransverse } from '../sql.js';\nexport default preparerTransverse;", QUERIES],
  ['preparerTransverse depuis scope.ts', "import { preparerTransverse } from './sql.js';\nexport default preparerTransverse;", SCOPE],
  ['connexionBrute depuis db/queries', "import { connexionBrute } from '../connection.js';\nexport default connexionBrute;", QUERIES],
  ['connexionBrute depuis scope.ts', "import { connexionBrute } from './connection.js';\nexport default connexionBrute;", SCOPE],
  ['connexionBrute depuis transverse.ts', "import { connexionBrute } from '../connection.js';\nexport default connexionBrute;", TRANSVERSE],
  ['baseDe depuis une route', "import { baseDe } from '../db/portee-utilisateur.js';\nexport default baseDe;", ROUTES],
  ['baseDe depuis l’intergiciel', "import { baseDe } from '../../db/portee-utilisateur.js';\nexport default baseDe;", APPARTENANCE],
  // Le serveur n'importe rien de app/tests/ (fixtures/brut.ts rend la vraie connexion)
  ['fixtures/brut depuis une route', "import { brut } from '../../tests/fixtures/brut.js';\nexport default brut;", chemin('server', 'routes', 'y.ts')],
  ['fixtures/brut depuis db/queries', "import { brut } from '../../../tests/fixtures/brut.js';\nexport default brut;", QUERIES],
  ['import() de fixtures/brut depuis une route', "export const f = async () => await import('../../tests/fixtures/brut.js');", chemin('server', 'routes', 'y.ts')],
  // Tests : pas d'accès direct à connection hors fixtures/brut.ts
  ['db/connection depuis un test', "import { connexionBrute } from '../../server/db/connection.js';\nexport default connexionBrute;", UN_TEST],
];

describe('règles ESLint des verrous n° 2 et 5 (lot 1 corrigé)', () => {
  it.each(BLOQUE)('bloque %s', async (_nom, code, filePath) => {
    expect(await reglesDeclenchees(code, filePath)).not.toEqual([]);
  });

  const AUTORISE: ReadonlyArray<[string, string, string]> = [
    ['db/migrate depuis index.ts', "import { fermer, ouvrirEtMigrer } from './db/migrate.js';\nexport default [fermer, ouvrirEtMigrer];", INDEX],
    ['creerScope depuis l’intergiciel d’appartenance', "import { creerScope } from '../../db/scope.js';\nexport default creerScope;", APPARTENANCE],
    ['creerPorteeUtilisateur depuis l’intergiciel d’appartenance', "import { creerPorteeUtilisateur } from '../../db/portee-utilisateur.js';\nexport default creerPorteeUtilisateur;", APPARTENANCE],
    ['le type GroupScope depuis une route', "import type { GroupScope } from '../db/scope.js';\nexport type T = GroupScope;", ROUTES],
    ['le type Base (opaque) depuis une route', "import type { Base } from '../db/base.js';\nexport type T = Base;", ROUTES],
    ['preparer depuis db/queries', "import { preparer } from '../sql.js';\nexport default preparer;", QUERIES],
    ['preparerTransverse depuis transverse.ts', "import { preparerTransverse } from '../sql.js';\nexport default preparerTransverse;", TRANSVERSE],
    ['connexionBrute depuis sql.ts', "import { connexionBrute } from './connection.js';\nexport default connexionBrute;", SQL],
    ['connexionBrute depuis migrate.ts', "import { connexionBrute } from './connection.js';\nexport default connexionBrute;", MIGRATE],
    ['.prepare dans db/sql.ts', "export const f = (b: { prepare: (s: string) => void }) => b.prepare('x');", SQL],
    ['.exec dans db/migrate.ts', "export const f = (b: { exec: (s: string) => void }) => b.exec('x');", MIGRATE],
    ['.pragma dans db/connection.ts', "export const f = (b: { pragma: (s: string) => void }) => b.pragma('x');", CONNECTION],
    ['.prepare dans un test (amorçage)', "export const f = (b: { prepare: (s: string) => void }) => b.prepare('x');", UN_TEST],
    ['une méthode qui s’appelle autrement', "export const f = (b: { preparer: (s: string) => void }) => b.preparer('x');", ROUTES],
  ];

  it.each(AUTORISE)('laisse passer %s', async (_nom, code, filePath) => {
    expect(await reglesDeclenchees(code, filePath)).toEqual([]);
  });
});
