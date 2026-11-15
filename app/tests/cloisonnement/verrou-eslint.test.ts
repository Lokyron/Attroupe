import { join } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Preuve que la règle ESLint du verrou n° 5 se déclenche réellement sur les contournements
// connus (mesurés lors de la revue du lot 0). Sans ce test, la règle pourrait être
// inopérante sans que personne ne le voie.
const RACINE = join(import.meta.dirname, '..', '..', '..');
const eslint = new ESLint({ cwd: RACINE });
const chemin = (...segments: string[]): string => join(RACINE, 'app', ...segments);

async function reglesDeclenchees(code: string, filePath: string): Promise<string[]> {
  const [resultat] = await eslint.lintText(code, { filePath });
  return (resultat?.messages ?? []).filter((m) => m.ruleId?.startsWith('no-restricted-') ?? false).map((m) => m.ruleId ?? '');
}

const ROUTES = chemin('server', 'http', 'routes.ts');

const CONTOURNEMENTS: ReadonlyArray<[string, string, string]> = [
  ['1. point intermédiaire', "import { db } from '../db/./connection.js';", ROUTES],
  ['2. double barre', "import { db } from '../db//connection.js';", ROUTES],
  ['3. import() littéral', "export const f = async () => await import('../db/connection.js');", ROUTES],
  ['4. import() en gabarit', 'export const f = async () => await import(`../db/connection.js`);', ROUTES],
  [
    '5. createRequire',
    "import { createRequire } from 'node:module';\nexport const m = createRequire(import.meta.url)('../db/connection.js');",
    ROUTES,
  ],
  ['6. sous-chemin de better-sqlite3', "import d from 'better-sqlite3/lib/database.js';\nexport default d;", ROUTES],
  ['7. sqlite3', "import s from 'sqlite3';\nexport default s;", ROUTES],
  ['8a. fichier .mts', "import { db } from '../db/connection.js';\nexport default db;", chemin('server', 'http', 'x.mts')],
  ['8b. fichier .cts', "import { db } from '../db/connection.js';\nexport default db;", chemin('server', 'http', 'x.cts')],
  ['9a. fichier-baril (export *)', "export * from './connection.js';", chemin('server', 'db', 'index.ts')],
  ['9b. fichier-baril (export nommé)', "export { db } from './connection.js';", chemin('server', 'db', 'index.ts')],
  [
    '10. import() de better-sqlite3 depuis queries/',
    "export const f = async () => await import('better-sqlite3');",
    chemin('server', 'db', 'queries', 'articles.ts'),
  ],
  ['11. sous-dossier dist/', "import { db } from '../../db/connection.js';\nexport default db;", chemin('server', 'http', 'dist', 'x.ts')],
  ['12. import() non littéral', 'export const f = async (n: string) => await import(n);', ROUTES],
];

describe('règle ESLint du verrou n° 5', () => {
  it.each(CONTOURNEMENTS)('bloque %s', async (_nom, code, filePath) => {
    expect(await reglesDeclenchees(code, filePath)).not.toEqual([]);
  });

  it('laisse passer l’usage légitime dans db/', async () => {
    expect(await reglesDeclenchees("import { db } from '../connection.js';\nexport default db;", chemin('server', 'db', 'queries', 'articles.ts'))).toEqual([]);
    expect(await reglesDeclenchees("import Database from 'better-sqlite3';\nexport default Database;", chemin('server', 'db', 'connection.ts'))).toEqual([]);
  });

  it('refuse le texte en dur dans une accolade JSX', async () => {
    const regles = await reglesDeclenchees("export const A = () => <p>{'Bonjour'}</p>;", chemin('client', 'src', 'A.tsx'));
    expect(regles).toContain('no-restricted-syntax');
  });
});
