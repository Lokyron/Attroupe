import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Liste récursivement les fichiers d'un dossier dont l'extension est donnée, hors dist et node_modules. */
export function listerFichiers(dossier: string, extensions: readonly string[]): string[] {
  return readdirSync(dossier, { withFileTypes: true }).flatMap((entree) => {
    const chemin = join(dossier, entree.name);
    if (entree.isDirectory()) {
      return entree.name === 'dist' || entree.name === 'node_modules' ? [] : listerFichiers(chemin, extensions);
    }
    return extensions.some((ext) => entree.name.endsWith(ext)) ? [chemin] : [];
  });
}
