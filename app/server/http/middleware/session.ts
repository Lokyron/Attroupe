import { createHmac } from 'node:crypto';
import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import { prolongerSession, trouverSession } from '../../db/queries/comptes.js';
import { creerPorteeUtilisateur, ErreurCompte, type PorteeUtilisateur } from '../../db/portee-utilisateur.js';
import { depuisInstant, versInstant } from '../../domain/instant.js';
import { FORME_JETON, empreinteJeton } from '../../domain/jetons.js';
import { DUREE_GLISSANTE_MS, echeanceSession, SEUIL_PROLONGATION_MS } from '../../domain/session.js';
import type { Contexte } from '../contexte.js';
import { ErreurHttp } from '../erreurs.js';
import { declarerIntergiciel } from '../montage.js';

// Intergiciel de session (verrou d'identité, architecture §5). Il lit le cookie, retrouve la session par
// l'empreinte SHA-256 du jeton, relit le compte en base (`creerPorteeUtilisateur` refuse un compte suspendu
// ou anonymisé) et dépose la `PorteeUtilisateur` sur la requête. Une route n'obtient jamais l'identifiant du
// compte autrement que par cette portée.
//
// C'est, avec appartenance.ts, le seul fichier qui fabrique une portée (règle ESLint, eslint.config.js).

export const NOM_COOKIE = 'attroupe_session';

export interface Authentification {
  readonly portee: PorteeUtilisateur;
  readonly sessionId: string;
  /** Ouverture de la session : le plafond absolu de 90 jours s'y compte. */
  readonly createdAt: string;
}

// WeakMap plutôt qu'une propriété sur `req` : pas d'augmentation globale des types d'Express, et la
// clé est la requête elle-même (rien ne survit à la requête).
const AUTHENTIFICATIONS = new WeakMap<Request, Authentification>();

/** L'authentification de la requête, si une session valide l'accompagne. */
export function authentification(req: Request): Authentification | undefined {
  return AUTHENTIFICATIONS.get(req);
}

/** Comme `authentification`, mais 401 sans session. */
export function exigerSession(req: Request): Authentification {
  const auth = AUTHENTIFICATIONS.get(req);
  if (auth === undefined) throw new ErreurHttp(401, 'session.requise');
  return auth;
}

/** Garde de routeur : `routeur.use(gardeSession)` ; les routes lisent ensuite `exigerSession(req)`. */
export const gardeSession: RequestHandler = declarerIntergiciel('garde', (req, _res, next) => {
  exigerSession(req);
  next();
});

/** Valeur du cookie de session dans l'en-tête `Cookie`, si elle a la forme d'un jeton (aucun traitement sinon). */
function jetonDuCookie(req: Request): string | undefined {
  const entete = req.headers.cookie;
  if (entete === undefined) return undefined;
  for (const morceau of entete.split(';')) {
    const egal = morceau.indexOf('=');
    if (egal < 0 || morceau.slice(0, egal).trim() !== NOM_COOKIE) continue;
    const valeur = morceau.slice(egal + 1).trim();
    return FORME_JETON.test(valeur) ? valeur : undefined;
  }
  return undefined;
}

function optionsCookie(securise: boolean, dureeMs: number): CookieOptions {
  return { httpOnly: true, secure: securise, sameSite: 'lax', path: '/', maxAge: dureeMs };
}

/** Dépose le cookie de session : jeton opaque, `HttpOnly`, `Secure` (https), `SameSite=Lax`. */
export function poserCookieSession(res: Response, contexte: Contexte, jeton: string, expireLe: Date): void {
  res.cookie(NOM_COOKIE, jeton, optionsCookie(contexte.cookieSecurise, Math.max(0, expireLe.getTime() - contexte.horloge().getTime())));
}

export function effacerCookieSession(res: Response, contexte: Contexte): void {
  res.clearCookie(NOM_COOKIE, { httpOnly: true, secure: contexte.cookieSecurise, sameSite: 'lax', path: '/' });
}

/** HMAC de l'adresse (clé : ATTROUPE_SESSION_SECRET) : permet de reconnaître un appareil sans conserver d'adresse en clair. */
export function hacherAdresse(contexte: Contexte, adresse: string): string {
  return createHmac('sha256', contexte.env.ATTROUPE_SESSION_SECRET).update(adresse).digest('hex');
}

/** Lit la session (facultative) : sans cookie valide la requête continue anonyme ; `exigerSession` tranche ensuite. */
export function intergicielSession(contexte: Contexte): RequestHandler {
  return (req, res, next) => {
    const jeton = jetonDuCookie(req);
    if (jeton === undefined) {
      next();
      return;
    }
    try {
      const maintenant = contexte.horloge();
      const session = trouverSession(contexte.base, empreinteJeton(jeton), versInstant(maintenant));
      if (session === undefined) {
        effacerCookieSession(res, contexte); // cookie périmé ou révoqué : on le retire du navigateur
        next();
        return;
      }
      let portee: PorteeUtilisateur;
      try {
        portee = creerPorteeUtilisateur(contexte.base, session.userId);
      } catch (erreur) {
        if (!(erreur instanceof ErreurCompte)) throw erreur;
        effacerCookieSession(res, contexte); // compte suspendu ou anonymisé depuis
        next();
        return;
      }
      AUTHENTIFICATIONS.set(req, { portee, sessionId: session.id, createdAt: session.createdAt });
      // Prolongation glissante, plafonnée à 90 jours depuis l'ouverture.
      if (maintenant.getTime() - depuisInstant(session.lastSeenAt).getTime() >= SEUIL_PROLONGATION_MS) {
        const expireLe = echeanceSession(depuisInstant(session.createdAt), maintenant);
        prolongerSession(portee, session.id, versInstant(maintenant), versInstant(expireLe));
        poserCookieSession(res, contexte, jeton, expireLe);
      }
      next();
    } catch (erreur) {
      next(erreur);
    }
  };
}

export { DUREE_GLISSANTE_MS };
