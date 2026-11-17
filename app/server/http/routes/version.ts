import { Router } from 'express';
import type { Base } from '../../db/base.js';
import { derniereMigration } from '../../db/queries/version.js';

/**
 * Route publique d'exploitation : expose la version applicative, l'étiquette d'image (`ATTROUPE_TAG`)
 * et la dernière migration SQL appliquée.
 */
export function routesVersion(version: string, base?: Base): Router {
  const routeur = Router();

  routeur.get('/', (_req, res) => {
    const derniere = base === undefined ? undefined : derniereMigration(base);
    res.json({
      name: 'attroupe',
      version,
      tag: process.env['ATTROUPE_TAG'] ?? version,
      migration: derniere?.version ?? null,
      migration_nom: derniere?.nom ?? null,
    });
  });

  return routeur;
}
