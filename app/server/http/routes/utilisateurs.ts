import { Router } from 'express';
import { lireAvatarUtilisateur } from '../../db/queries/avatar.js';
import type { Contexte } from '../contexte.js';
import { ErreurHttp } from '../erreurs.js';
import { exigerSession, gardeSession } from '../middleware/session.js';
import { parametre } from '../parametres.js';

/** Routes utilisateurs authentifiées (lecture de la photo de profil d'un compte). */
export function routesUtilisateurs(_contexte: Contexte): Router {
  const routeur = Router();
  routeur.use(gardeSession);

  routeur.get('/:userId/avatar', (req, res) => {
    const { portee } = exigerSession(req);
    // Compte inconnu, sans photo ou sans groupe commun : même 404 (on ne confirme pas son existence).
    const avatar = lireAvatarUtilisateur(portee, parametre(req, 'userId'));
    if (avatar === null) throw new ErreurHttp(404, 'avatar.introuvable');
    res.set('Content-Type', avatar.mime);
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(avatar.data);
  });

  return routeur;
}
