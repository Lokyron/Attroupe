import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Env } from '../config/env.js';

export interface OptionsApp {
  env: Env;
  version: string;
  /** Dossier du client construit ; absent = le serveur ne sert que l'API. */
  dossierClient?: string;
}

/** En-têtes posés sur toutes les réponses, avant tout le reste (sans dépendance externe). */
const EN_TETES_SECURITE: Readonly<Record<string, string>> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

/** Statut HTTP porté par une erreur (ex. corps JSON mal formé : 400), s'il est de la famille 4xx. */
function statutClient(erreur: unknown): number | undefined {
  if (typeof erreur !== 'object' || erreur === null || !('status' in erreur)) return undefined;
  const { status } = erreur;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500
    ? status
    : undefined;
}

/** Gestionnaire d'erreurs d'Express (quatre paramètres obligatoires pour être reconnu comme tel). */
export function gestionnaireErreurs(erreur: unknown, _req: Request, res: Response, next: NextFunction): void {
  // Les en-têtes sont déjà partis : on ne peut plus répondre, Express fermera la connexion.
  if (res.headersSent) {
    next(erreur);
    return;
  }
  const statut = statutClient(erreur);
  if (statut !== undefined) {
    res.status(statut).json({ error: 'requete.invalide' });
    return;
  }
  console.error('Erreur non gérée :', erreur);
  res.status(500).json({ error: 'erreur.interne' });
}

/**
 * Assemblage Express. L'ordre compte : API d'abord, puis fichiers statiques du client,
 * puis repli sur index.html (application monopage), puis gestion d'erreurs en dernier.
 */
export function creerApp({ env, version, dossierClient }: OptionsApp): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.ATTROUPE_TRUST_PROXY);

  app.use((_req, res, next) => {
    res.set(EN_TETES_SECURITE);
    next();
  });

  app.get('/api/sante', (_req, res) => {
    res.json({ status: 'ok', version });
  });

  // Toute autre URL d'API est inconnue : JSON, jamais la page du client.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'route.introuvable' });
  });

  if (dossierClient !== undefined) {
    const index = join(dossierClient, 'index.html');
    if (!existsSync(index)) {
      throw new Error(`Client construit introuvable : ${index} (lancer « npm run build » ?).`);
    }
    app.use(express.static(dossierClient, { index: false }));
    app.get(/^(?!\/api(\/|$)).*/, (_req, res) => {
      res.sendFile(index);
    });
  }

  app.use(gestionnaireErreurs);

  return app;
}
