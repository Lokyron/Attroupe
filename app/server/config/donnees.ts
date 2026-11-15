import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import { ErreurConfiguration } from './env.js';

/**
 * Vérifie, au démarrage, que le dossier de données existe et qu'on peut y écrire.
 * Sous Docker, un `./data` créé par le démon appartient à root : sans ce contrôle,
 * l'échec n'apparaîtrait qu'à la première écriture, loin de sa cause.
 */
export function verifierDossierDonnees(dossier: string): void {
  try {
    mkdirSync(dossier, { recursive: true });
    if (!statSync(dossier).isDirectory()) {
      throw new ErreurConfiguration([`ATTROUPE_DATA_DIR : « ${dossier} » n'est pas un dossier`]);
    }
    accessSync(dossier, constants.R_OK | constants.W_OK);
  } catch (erreur) {
    if (erreur instanceof ErreurConfiguration) throw erreur;
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    throw new ErreurConfiguration([
      `ATTROUPE_DATA_DIR : le dossier « ${dossier} » n'est pas inscriptible par l'utilisateur du serveur` +
        (uid === undefined ? '' : ` (uid ${uid})`) +
        ` — ${erreur instanceof Error ? erreur.message : String(erreur)}. ` +
        'Sous Docker : mkdir data && chown 1000:1000 data (voir DOCUMENTATION.md, section 5).',
    ]);
  }
}
