import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

const NOM_PAQUET = '@attroupe/server';

const schemaPaquet = z.object({ name: z.string(), version: z.string().min(1) });

/**
 * Remonte depuis le dossier du module jusqu'au package.json du serveur.
 * Le code tourne aussi bien depuis les sources (tsx, tests) que depuis dist/ :
 * on ne peut donc pas compter sur une profondeur fixe.
 */
function trouverRacineServeur(depart: string): string {
  let courant = resolve(depart);
  for (;;) {
    const candidat = join(courant, 'package.json');
    if (existsSync(candidat)) {
      const lu = schemaPaquet.safeParse(JSON.parse(readFileSync(candidat, 'utf8')));
      if (lu.success && lu.data.name === NOM_PAQUET) return courant;
    }
    const parent = dirname(courant);
    if (parent === courant) {
      throw new Error(`Package ${NOM_PAQUET} introuvable en remontant depuis ${depart}.`);
    }
    courant = parent;
  }
}

export const racineServeur: string = trouverRacineServeur(import.meta.dirname);

/** Dossier du client construit (app/client/dist), voisin du serveur dans le dépôt comme dans l'image. */
export const dossierClient: string = join(racineServeur, '..', 'client', 'dist');

/** Version de l'application, lue dans le package.json du serveur. */
export const version: string = schemaPaquet.parse(
  JSON.parse(readFileSync(join(racineServeur, 'package.json'), 'utf8')),
).version;
