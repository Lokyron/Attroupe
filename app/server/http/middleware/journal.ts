import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { authentification } from './session.js';

// Journal (architecture §2, `middleware/journal`) : une ligne JSON par événement, sur la sortie standard.
// On y met le STRICT nécessaire : méthode, chemin SANS requête, statut, durée, identifiant de requête.
// Jamais d'adresse IP, de corps, d'en-tête, de cookie ni de jeton. Par sécurité, tout champ dont le nom
// ressemble à un secret est masqué même si un appelant distrait le passait.

export type Niveau = 'debug' | 'info' | 'warn' | 'error';
const ORDRE: Readonly<Record<Niveau, number>> = { debug: 0, info: 1, warn: 2, error: 3 };
const NOM_SECRET = /mot_?de_?passe|password|passwd|token|jeton|hash|empreinte|secret|cookie|authorization|api[-_]?key|session/i;

export interface Journal {
  readonly debug: (message: string, champs?: Readonly<Record<string, unknown>>) => void;
  readonly info: (message: string, champs?: Readonly<Record<string, unknown>>) => void;
  readonly warn: (message: string, champs?: Readonly<Record<string, unknown>>) => void;
  readonly error: (message: string, champs?: Readonly<Record<string, unknown>>) => void;
}

function masquer(champs: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(champs).map(([cle, valeur]) => [cle, NOM_SECRET.test(cle) ? '[masqué]' : valeur]));
}

export function creerJournal(niveauMin: Niveau, ecrire: (ligne: string) => void = (ligne) => process.stdout.write(`${ligne}\n`)): Journal {
  const emettre = (niveau: Niveau, message: string, champs: Readonly<Record<string, unknown>> = {}): void => {
    if (ORDRE[niveau] < ORDRE[niveauMin]) return;
    ecrire(JSON.stringify({ t: new Date().toISOString(), niveau, message, ...masquer(champs) }));
  };
  return {
    debug: (m, c) => emettre('debug', m, c),
    info: (m, c) => emettre('info', m, c),
    warn: (m, c) => emettre('warn', m, c),
    error: (m, c) => emettre('error', m, c),
  };
}

/** Journal qui ne dit rien (tests). */
export const JOURNAL_SILENCIEUX: Journal = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

/** Une ligne par requête, à la fin de la réponse ; pose `X-Request-Id`. */
export function intergicielJournal(journal: Journal): RequestHandler {
  return (req, res, next) => {
    const debut = process.hrtime.bigint();
    const id = randomUUID();
    // originalUrl, sans la requête : monté sous /api, `req.path` serait relatif au point de montage.
    const chemin = (req.originalUrl.split('?')[0] ?? '').slice(0, 200);
    res.setHeader('X-Request-Id', id);
    res.on('finish', () => {
      const ms = Number((process.hrtime.bigint() - debut) / 1_000_000n);
      const auth = authentification(req);
      journal.info('http.requete', {
        id,
        methode: req.method,
        chemin,
        statut: res.statusCode,
        ms,
        ...(auth === undefined ? {} : { compte: auth.portee.userId }),
      });
    });
    next();
  };
}
