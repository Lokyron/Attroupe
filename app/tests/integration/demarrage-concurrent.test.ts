import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOSSIER_MIGRATIONS, fermer, ouvrirEtMigrer } from '../../server/db/migrate.js';
import { brut } from '../fixtures/brut.js';

// Revue du lot 1 : deux conteneurs qui démarrent ensemble sur le même volume. Le perdant plantait
// (« database is locked » au passage en WAL, ou migration rejouée puis échec). Ici, N vrais processus
// partent au même instant ; aucun ne doit échouer, et chaque migration n'est jouée qu'une fois.
const RACINE = join(import.meta.dirname, '..', '..', '..');
const SCRIPT = join(import.meta.dirname, '..', 'fixtures', 'demarrer-base.ts');
const PROCESSUS = 6;

interface Sortie {
  readonly code: number | null;
  readonly sortie: string;
}

function lancer(chemin: string, barriere: number, migrations: string): Promise<Sortie> {
  return new Promise((resolu) => {
    const enfant = spawn(process.execPath, ['--import', 'tsx', SCRIPT, chemin, String(barriere), migrations], { cwd: RACINE });
    let sortie = '';
    enfant.stdout.on('data', (morceau: Buffer) => (sortie += morceau.toString()));
    enfant.stderr.on('data', (morceau: Buffer) => (sortie += morceau.toString()));
    enfant.on('close', (code) => resolu({ code, sortie: sortie.trim() }));
  });
}

describe('démarrage simultané de plusieurs processus sur la même base', () => {
  let dossier: string;
  let migrations: string;
  let chemin: string;
  beforeEach(() => {
    dossier = mkdtempSync(join(tmpdir(), 'attroupe-course-'));
    migrations = join(dossier, 'migrations');
    mkdirSync(migrations);
    copyFileSync(join(DOSSIER_MIGRATIONS, '0001_socle.sql'), join(migrations, '0001_socle.sql'));
    chemin = join(dossier, 'base.sqlite');
  });
  afterEach(() => rmSync(dossier, { recursive: true, force: true }));

  const lancerTous = (): Promise<Sortie[]> => {
    const barriere = Date.now() + 2500; // laisse le temps à chaque processus de charger tsx et le code
    return Promise.all(Array.from({ length: PROCESSUS }, () => lancer(chemin, barriere, migrations)));
  };

  const versions = (): unknown[] => {
    const base = ouvrirEtMigrer(chemin, { dossierMigrations: migrations });
    try {
      return brut(base).prepare('SELECT version FROM schema_migrations ORDER BY version').pluck().all();
    } finally {
      fermer(base);
    }
  };

  it('base vierge : aucun processus ne plante, la migration n’est jouée qu’une fois', async () => {
    const sorties = await lancerTous();
    expect(sorties.map((s) => s.sortie)).toEqual(Array(PROCESSUS).fill('ok'));
    expect(sorties.map((s) => s.code)).toEqual(Array(PROCESSUS).fill(0));
    expect(versions()).toEqual(['0001_socle']);
  }, 60_000);

  it('migration en attente sur une base existante : aucun plantage, jouée une fois, sauvegardes à noms uniques', async () => {
    fermer(ouvrirEtMigrer(chemin, { dossierMigrations: migrations }));
    writeFileSync(join(migrations, '0002_ajout.sql'), 'CREATE TABLE ajout (id TEXT NOT NULL PRIMARY KEY) STRICT;');
    const sorties = await lancerTous();
    expect(sorties.map((s) => s.sortie)).toEqual(Array(PROCESSUS).fill('ok'));
    expect(versions()).toEqual(['0001_socle', '0002_ajout']);
    const sauvegardes = readdirSync(join(dossier, 'sauvegardes'));
    expect(sauvegardes.length).toBeGreaterThanOrEqual(1);
    expect(new Set(sauvegardes).size).toBe(sauvegardes.length);
  }, 60_000);
});
