import type { Request, RequestHandler } from 'express';
import { creerScope, ErreurAppartenance, type GroupScope } from '../../db/scope.js';
import type { Contexte } from '../contexte.js';
import { ErreurHttp } from '../erreurs.js';
import { exigerSession } from './session.js';

// Verrou n° 3 (architecture §4) : l'intergiciel de résolution d'appartenance. Monté UNE fois sur le préfixe
// `/api/groupes/:groupId`, il rend impossible d'atteindre une route de groupe sans avoir prouvé l'appartenance.
//  - il réutilise l'authentification du lot 2 : `exigerSession` (401 sans session), puis l'identifiant du compte
//    vient de la `PorteeUtilisateur` de la session, jamais de la requête ;
//  - `creerScope` relit l'appartenance ACTIVE en base : un groupe étranger, un groupe inexistant et un ancien
//    membre reçoivent la MÊME réponse, 404 (jamais 403, qui confirmerait l'existence du groupe) ;
//  - il ne lit PAS `users.is_instance_admin` : l'administrateur de l'instance n'a aucun accès au contenu des groupes
//    (ADR-0002). Aucune ligne de ce fichier ne touche ce drapeau.
//
// C'est, avec session.ts, le seul fichier qui fabrique une portée ; il est le seul à fabriquer un GroupScope.

// WeakMap plutôt qu'une propriété sur `req` (même choix que session.ts) : pas d'augmentation globale des types d'Express.
const SCOPES = new WeakMap<Request, GroupScope>();

/** Le scope du groupe de la requête. Lève une erreur de programmation si `exigerAppartenance` n'a pas été monté. */
export function scopeDe(req: Request): GroupScope {
  const scope = SCOPES.get(req);
  if (scope === undefined) throw new Error("Aucun scope sur la requête : exigerAppartenance doit être monté sur le préfixe du groupe.");
  return scope;
}

/** Le groupe n'existe pas pour cet appelant : même réponse que le groupe soit inconnu, étranger ou quitté. */
function groupeIntrouvable(): ErreurHttp {
  return new ErreurHttp(404, 'groupe.introuvable');
}

/** À monter sur `/api/groupes/:groupId` : pose le scope, ou répond 401 (sans session) / 404 (sans appartenance active). */
export function exigerAppartenance(contexte: Contexte): RequestHandler {
  return (req, _res, next) => {
    try {
      const { portee } = exigerSession(req);
      const groupId = req.params['groupId'];
      if (typeof groupId !== 'string') throw groupeIntrouvable();
      let scope: GroupScope;
      try {
        scope = creerScope(contexte.base, portee.userId, groupId);
      } catch (erreur) {
        if (erreur instanceof ErreurAppartenance) throw groupeIntrouvable();
        throw erreur;
      }
      // Groupe supprimé (marquage, purge différée) : l'appartenance existe encore, le groupe n'existe plus pour personne.
      const groupe = scope.groupe<{ archived_at: string | null }>();
      if (groupe === undefined) throw groupeIntrouvable();
      // Groupe en sommeil : lecture seule (modèle §3.3).
      if (groupe.archived_at !== null && req.method !== 'GET') throw new ErreurHttp(409, 'groupe.archive');
      SCOPES.set(req, scope);
      next();
    } catch (erreur) {
      next(erreur);
    }
  };
}

/**
 * Second contrôle, distinct du premier : « ai-je le droit ? ». À poser sur une route réservée aux administrateurs du
 * groupe, APRÈS `exigerAppartenance`. 403 : la ressource existe, dans MON groupe, mais le droit manque. Un échec de
 * cloisonnement reste un 404 : les deux codes ne se croisent jamais.
 */
export const exigerAdminGroupe: RequestHandler = (req, _res, next) => {
  try {
    if (scopeDe(req).role !== 'admin') throw new ErreurHttp(403, 'droit.admin_requis');
    next();
  } catch (erreur) {
    next(erreur);
  }
};
