import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { derniereMigration } from '../../server/db/queries/version.js';
import { routesVersion } from '../../server/http/routes/version.js';
import { baseTemporaire, type BaseTemporaire } from '../fixtures/base.js';

const RACINE_DEPOT = join(import.meta.dirname, '..', '..', '..');
const DOSSIER_PUBLIC = join(RACINE_DEPOT, 'app', 'client', 'public');
const DOSSIER_SCRIPTS = join(RACINE_DEPOT, 'scripts');

function sqlite3Disponible(): boolean {
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('lot 12 : version et dernière migration', () => {
  let b: BaseTemporaire;
  beforeAll(() => {
    b = baseTemporaire();
  });
  afterAll(() => b.nettoyer());

  it('derniereMigration retourne la dernière migration appliquée sur une base migrée', () => {
    const derniere = derniereMigration(b.base);
    expect(derniere).toBeDefined();
    expect(derniere?.version).toBe('0005');
    expect(derniere?.nom).toBe('0005_agenda_externe_details');
  });

  it('routesVersion renvoie name, version, tag, migration et migration_nom', () => {
    const routeur = routesVersion('0.1.0-test', b.base);
    const couche = routeur.stack.find((s) => s.route?.path === '/');
    const handler = couche?.route?.stack[0]?.handle;
    expect(handler).toBeTypeOf('function');

    let corps: unknown;
    const res = {
      json: (payload: unknown) => {
        corps = payload;
        return res;
      },
    } as unknown as Response;

    handler?.({} as Request, res, () => undefined);
    expect(corps).toEqual({
      name: 'attroupe',
      version: '0.1.0-test',
      tag: process.env['ATTROUPE_TAG'] ?? '0.1.0-test',
      migration: '0005',
      migration_nom: '0005_agenda_externe_details',
    });
  });
});

describe('lot 12 : fichiers PWA', () => {
  it('manifest.webmanifest est présent et valide', () => {
    const chemin = join(DOSSIER_PUBLIC, 'manifest.webmanifest');
    expect(existsSync(chemin)).toBe(true);
    const manifeste = JSON.parse(readFileSync(chemin, 'utf8')) as {
      name?: string;
      short_name?: string;
      display?: string;
      start_url?: string;
      icons?: Array<{ src: string }>;
    };
    expect(manifeste.name).toBe('Attroupe');
    expect(manifeste.short_name).toBe('Attroupe');
    expect(manifeste.display).toBe('standalone');
    expect(manifeste.start_url).toBe('/');
    const srcs = (manifeste.icons ?? []).map((i) => i.src);
    expect(srcs).toContain('/icons/icon-192.png');
    expect(srcs).toContain('/icons/icon-512.png');
    expect(srcs).toContain('/icons/icon.svg');
  });

  it('sw.js existe et exclut /api/, /ical/ et /media/ du cache', () => {
    const chemin = join(DOSSIER_PUBLIC, 'sw.js');
    expect(existsSync(chemin)).toBe(true);
    const contenu = readFileSync(chemin, 'utf8');
    expect(contenu).toContain('/api/');
    expect(contenu).toContain('/ical/');
    expect(contenu).toContain('/media/');
  });

  it('les icônes SVG et PNG existent et les PNG ont une signature valide', () => {
    expect(existsSync(join(DOSSIER_PUBLIC, 'icons', 'icon.svg'))).toBe(true);
    const sigPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    for (const fichier of ['icon-192.png', 'icon-512.png']) {
      const chemin = join(DOSSIER_PUBLIC, 'icons', fichier);
      expect(existsSync(chemin)).toBe(true);
      const octets = readFileSync(chemin);
      expect(octets.subarray(0, 8).equals(sigPng)).toBe(true);
    }
  });
});

describe('lot 12 : scripts de sauvegarde et restauration', () => {
  const sauvegardeSh = join(DOSSIER_SCRIPTS, 'sauvegarde.sh');
  const restaurationSh = join(DOSSIER_SCRIPTS, 'restauration.sh');

  it('ont une syntaxe bash valide', () => {
    execFileSync('bash', ['-n', sauvegardeSh]);
    execFileSync('bash', ['-n', restaurationSh]);
  });

  it('sauvegardent une base SQLite WAL et la restaurent avec vérification d’intégrité', () => {
    if (!sqlite3Disponible()) return;

    const racine = mkdtempSync(join(tmpdir(), 'attroupe-backup-'));
    try {
      const dataSrc = join(racine, 'data-src');
      const sauvegardes = join(racine, 'sauvegardes');
      const dataCible = join(racine, 'data-cible');
      mkdirSync(join(dataSrc, 'fichiers'), { recursive: true });
      writeFileSync(join(dataSrc, 'fichiers', 'note.txt'), 'bonjour attroupe', 'utf8');

      const baseSrc = join(dataSrc, 'attroupe.sqlite');
      execFileSync('sqlite3', [
        baseSrc,
        'PRAGMA journal_mode=WAL; CREATE TABLE test (id INTEGER PRIMARY KEY, valeur TEXT); INSERT INTO test (valeur) VALUES (\'ok\');',
      ]);

      const archive = execFileSync(sauvegardeSh, [dataSrc, sauvegardes], { encoding: 'utf8' }).trim();
      expect(archive.endsWith('.tar.gz')).toBe(true);
      expect(existsSync(archive)).toBe(true);

      execFileSync(restaurationSh, [archive, dataCible]);
      expect(existsSync(join(dataCible, 'attroupe.sqlite'))).toBe(true);
      expect(readFileSync(join(dataCible, 'fichiers', 'note.txt'), 'utf8')).toBe('bonjour attroupe');

      const contenu = execFileSync('sqlite3', [join(dataCible, 'attroupe.sqlite'), 'SELECT valeur FROM test;'], {
        encoding: 'utf8',
      }).trim();
      expect(contenu).toBe('ok');

      // Sans --force, la restauration sur une base existante doit échouer.
      expect(() => execFileSync(restaurationSh, [archive, dataCible], { stdio: 'ignore' })).toThrow();

      // Avec --force, elle réussit et nettoie d'éventuels fichiers -wal/-shm.
      writeFileSync(join(dataCible, 'attroupe.sqlite-wal'), 'obsolete', 'utf8');
      execFileSync(restaurationSh, [archive, dataCible, '--force']);
      expect(existsSync(join(dataCible, 'attroupe.sqlite-wal'))).toBe(false);
    } finally {
      rmSync(racine, { recursive: true, force: true });
    }
  });
});
