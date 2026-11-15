import type { z } from 'zod';
import { ErreurHttp } from '../erreurs.js';

/** Valide un corps de requête ; sinon 400 `requete.invalide` avec les NOMS des champs fautifs (jamais leurs valeurs). */
export function analyser<S extends z.ZodType>(schema: S, corps: unknown): z.output<S> {
  const resultat = schema.safeParse(corps ?? {});
  if (resultat.success) return resultat.data;
  const champs = [...new Set(resultat.error.issues.map((i) => i.path.map(String).join('.') || '_'))];
  throw new ErreurHttp(400, 'requete.invalide', undefined, champs);
}
