import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Env } from '../config/env.js';
import type { Base } from '../db/base.js';
import { LimiteurCadence, REGLES_PAR_DEFAUT, type Horloge, type ReglesCadence } from '../services/cadence.js';
import type { DependancesAgenda } from '../services/agenda-externe.js';
import type { DnsLookupImmich, FetchImmich } from '../services/immich-client.js';
import { empreinteLeurre, PARAMETRES_PRODUCTION, type ParametresScrypt } from '../services/mot-de-passe.js';
import { DiffuseurTempsReel } from '../services/temps-reel.js';
import type { Contexte } from './contexte.js';
import { csrf } from './middleware/csrf.js';
import { gestionnaireErreurs } from './middleware/erreurs.js';
import { creerJournal, intergicielJournal, JOURNAL_SILENCIEUX, type Journal } from './middleware/journal.js';
import { intergicielSession } from './middleware/session.js';
import { declarerIntergiciel, monter } from './montage.js';
import { routesAuth } from './routes/auth.js';
import { routesDevises } from './routes/devises.js';
import { routesGroupes } from './routes/groupes.js';
import { routesIcal } from './routes/ical.js';
import { routesInvitations } from './routes/invitations.js';
import { routesMedia } from './routes/media.js';
import { routesMoi } from './routes/moi.js';
import { routesUtilisateurs } from './routes/utilisateurs.js';
import { routesVersion } from './routes/version.js';

// Réexporté : le gestionnaire d'erreurs vit désormais dans middleware/erreurs.ts.
export { gestionnaireErreurs };

export interface OptionsApp {
  env: Env;
  version: string;
  /** Dossier du client construit ; absent = le serveur ne sert que l'API. */
  dossierClient?: string;
  /** Base migrée. Absente : seule la santé est servie (test de l'assemblage) ; en service, `index.ts` la fournit toujours. */
  base?: Base;
  // Les réglages ci-dessous existent pour que les tests injectent l'horloge, un hachage léger ou un journal muet.
  horloge?: Horloge;
  parametresScrypt?: ParametresScrypt;
  regles?: ReglesCadence;
  limiteur?: LimiteurCadence;
  journal?: Journal;
  /** La diffusion du temps réel : `index.ts` la fournit pour pouvoir fermer les flux à l'arrêt ; les tests l'injectent (battement court, plafond). */
  diffuseur?: DiffuseurTempsReel;
  delaiMinimalOubliMs?: number;
  fetchImmich?: FetchImmich;
  dnsLookupImmich?: DnsLookupImmich;
  agendaExterne?: DependancesAgenda;
}

/** Durée minimale d'une réponse à « mot de passe oublié » : bien au-dessus de l'écart entre adresse connue et inconnue. */
const DELAI_MINIMAL_OUBLI_MS = 300;

/** En-têtes posés sur toutes les réponses, avant tout le reste (sans dépendance externe). */
const EN_TETES_SECURITE: Readonly<Record<string, string>> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    // `img-src` doit être explicite : sans lui, `default-src 'self'` s'applique aux images et BLOQUE les URL
    // `blob:`. Or la préparation de la photo de profil passe par `URL.createObjectURL` pour décoder le fichier
    // choisi (api/groupes.ts). Sans cette ligne, l'image ne se charge jamais, `onerror` part, et l'ajout de
    // photo échoue pour tout le monde — silencieusement, puisque seule la console du navigateur le dit.
    // `blob:` ne désigne que des objets fabriqués par la page elle-même, de même origine : rien n'entre par là.
    "img-src 'self' blob:",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

/**
 * Assemblage Express. L'ordre compte : API d'abord, puis fichiers statiques du client,
 * puis repli sur index.html (application monopage), puis gestion d'erreurs en dernier.
 */
export function creerApp(options: OptionsApp): Express {
  const { env, version, dossierClient } = options;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.ATTROUPE_TRUST_PROXY);

  // Tout intergiciel non routeur est déclaré (`transversal`) : le test de complétude signale les autres (tests/fixtures/routes.ts).
  app.use(
    declarerIntergiciel('transversal', (_req: Request, res: Response, next: NextFunction) => {
      res.set(EN_TETES_SECURITE);
      next();
    }),
  );

  const journal = options.journal ?? (env.NODE_ENV === 'test' ? JOURNAL_SILENCIEUX : creerJournal(env.ATTROUPE_LOG_LEVEL));
  app.use('/api', declarerIntergiciel('transversal', intergicielJournal(journal)));

  app.get('/api/sante', (_req, res) => {
    res.json({ status: 'ok', version });
  });
  monter(app, '/api/version', routesVersion(version, options.base));

  if (options.base !== undefined) {
    const horloge = options.horloge ?? ((): Date => new Date());
    const parametresScrypt = options.parametresScrypt ?? PARAMETRES_PRODUCTION;
    const contexte: Contexte = {
      base: options.base,
      env,
      journal,
      horloge,
      limiteur: options.limiteur ?? new LimiteurCadence(horloge),
      regles: options.regles ?? REGLES_PAR_DEFAUT,
      parametresScrypt,
      delaiMinimalOubliMs: options.delaiMinimalOubliMs ?? DELAI_MINIMAL_OUBLI_MS,
      cookieSecurise: env.ATTROUPE_BASE_URL.startsWith('https:'),
      diffuseur: options.diffuseur ?? new DiffuseurTempsReel({ horloge, journal, plafondGlobal: env.ATTROUPE_SSE_MAX_CONNECTIONS }),
      ...(options.fetchImmich !== undefined ? { fetchImmich: options.fetchImmich } : {}),
      ...(options.dnsLookupImmich !== undefined ? { dnsLookupImmich: options.dnsLookupImmich } : {}),
      ...(options.agendaExterne !== undefined ? { agendaExterne: options.agendaExterne } : {}),
    };
    // Empreinte leurre chauffée au démarrage : la première connexion sur une adresse inconnue ne doit pas durer deux fois plus.
    empreinteLeurre(parametresScrypt).catch((erreur: unknown) => {
      journal.error('auth.leurre_echec', { erreur: erreur instanceof Error ? erreur.message : String(erreur) });
    });

    // Ordre des intergiciels de /api : journal (ci-dessus) → CSRF (refus peu coûteux, avant de lire le corps)
    // → corps JSON borné → session (facultative) → routes (cadence posée route par route : elle lit l'e-mail du corps)
    // → 404 → gestionnaire d'erreurs, en dernier.
    app.use('/api', declarerIntergiciel('transversal', csrf(env.ATTROUPE_BASE_URL)));
    const jsonStandard = express.json({ limit: '16kb', strict: true });
    const jsonAvatar = express.json({ limit: '2mb', strict: true });
    app.use(
      '/api',
      declarerIntergiciel('transversal', (req: Request, res: Response, next: NextFunction) => {
        if (req.method === 'PUT' && req.path === '/moi/avatar') {
          jsonAvatar(req, res, next);
        } else {
          jsonStandard(req, res, next);
        }
      }),
    );
    app.use('/api', declarerIntergiciel('transversal', intergicielSession(contexte)));
    // Chaque sous-application est montée par `monter` : le registre de cloisonnement en reconstitue les chemins (tests/cloisonnement).
    monter(app, '/api/auth', routesAuth(contexte));
    monter(app, '/api/devises', routesDevises(contexte));
    monter(app, '/api/moi', routesMoi(contexte));
    monter(app, '/api/utilisateurs', routesUtilisateurs(contexte));
    monter(app, '/api/groupes', routesGroupes(contexte));
    monter(app, '/api/invitations', routesInvitations(contexte));
    // Le flux iCal est HORS /api : ni cookie, ni CSRF, ni corps JSON, ni session — le jeton de l'URL est l'unique authentification.
    monter(app, '/ical', routesIcal(contexte));
    // Le relai média signé est HORS /api (binaires) mais exige une session valide (la signature HMAC inclut `userId`).
    monter(app, '/media', routesMedia(contexte));
  }

  // Toute autre URL d'API est inconnue : JSON, jamais la page du client.
  app.use(
    '/api',
    declarerIntergiciel('transversal', (_req: Request, res: Response) => {
      res.status(404).json({ error: 'route.introuvable' });
    }),
  );

  if (dossierClient !== undefined) {
    const index = join(dossierClient, 'index.html');
    if (!existsSync(index)) {
      throw new Error(`Client construit introuvable : ${index} (lancer « npm run build » ?).`);
    }
    app.use(declarerIntergiciel('transversal', express.static(dossierClient, { index: false })));
    app.get(/^(?!\/api(\/|$)).*/, (_req, res) => {
      res.sendFile(index);
    });
  }

  app.use(declarerIntergiciel('transversal', gestionnaireErreurs));

  return app;
}
