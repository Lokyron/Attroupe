import type { Request } from 'express';
import { ErreurHttp } from './erreurs.js';

/** Paramètre d'URL textuel (`:membreId`). Absent ou multiple : la route n'existe pas (404), jamais une valeur devinée. */
export function parametre(req: Request, nom: string): string {
  const valeur: unknown = req.params[nom];
  if (typeof valeur !== 'string' || valeur === '') throw new ErreurHttp(404, 'route.introuvable');
  return valeur;
}
