import { Router } from 'express';
import { listerDevises } from '../../db/queries/depenses.js';
import type { Contexte } from '../contexte.js';

// /api/devises : liste publique des devises activées (table de référence sans groupe).

export function routesDevises(contexte: Contexte): Router {
  const routeur = Router();

  routeur.get('/', (_req, res) => {
    res.json({ devises: listerDevises(contexte.base) });
  });

  return routeur;
}
