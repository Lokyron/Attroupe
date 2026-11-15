import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifierDossierDonnees } from '../../server/config/donnees.js';
import { ErreurConfiguration } from '../../server/config/env.js';

const racines: string[] = [];
function dossierTemporaire(): string {
  const dossier = mkdtempSync(join(tmpdir(), 'attroupe-donnees-'));
  racines.push(dossier);
  return dossier;
}

afterEach(() => {
  for (const racine of racines.splice(0)) {
    chmodSync(racine, 0o700);
    rmSync(racine, { recursive: true, force: true });
  }
});

describe('config/donnees : dossier de données', () => {
  it('accepte un dossier inscriptible et crée un dossier absent', () => {
    const racine = dossierTemporaire();
    expect(() => verifierDossierDonnees(racine)).not.toThrow();
    expect(() => verifierDossierDonnees(join(racine, 'nouveau', 'profond'))).not.toThrow();
  });

  it('refuse un chemin qui est un fichier', () => {
    const fichier = join(dossierTemporaire(), 'f');
    writeFileSync(fichier, '');
    expect(() => verifierDossierDonnees(fichier)).toThrow(ErreurConfiguration);
  });

  // root passe outre les droits : le contrôle n'aurait alors rien à prouver.
  it.skipIf(process.getuid?.() === 0)('refuse un dossier non inscriptible avec un message clair', () => {
    const racine = dossierTemporaire();
    chmodSync(racine, 0o500);
    expect(() => verifierDossierDonnees(racine)).toThrow(/pas inscriptible.*chown 1000:1000 data/s);
  });
});
