import type { RequestHandler } from 'express';
import { ErreurHttp } from '../erreurs.js';

// Protection CSRF : vérification de l'en-tête `Origin` sur toute requête qui modifie (tout sauf GET, HEAD,
// OPTIONS), en plus de `SameSite=Lax` sur le cookie. Choix justifié (architecture §5, ADR-0007) :
//  - le cookie `SameSite=Lax` n'est pas envoyé sur un POST inter-site ;
//  - `Origin` est posé par TOUS les navigateurs visés sur les requêtes non-GET, et un script de page tierce
//    ne peut pas le falsifier (c'est un en-tête interdit côté `fetch`) ;
//  - un jeton à double soumission ajouterait un état côté client (stockage, rotation, renvoi à chaque appel)
//    pour un bénéfice nul ici : il n'y a pas de formulaire inter-site, ni de sous-domaines non fiables.
// Les requêtes SANS `Origin` sont refusées, même sans cookie : elles ne viennent pas d'un navigateur, et
// laisser passer une connexion sans origine ouvrirait le « login CSRF » (forcer la victime à se connecter
// au compte de l'attaquant). Un client non navigateur envoie simplement l'en-tête `Origin` de l'instance.
//
// Placé AVANT la lecture du corps et de la session : une requête refusée ne coûte presque rien.

const METHODES_SURES = new Set(['GET', 'HEAD', 'OPTIONS']);

/** @param urlPublique ATTROUPE_BASE_URL : seule son origine (schéma, hôte, port) est admise. */
export function csrf(urlPublique: string): RequestHandler {
  const origineAutorisee = new URL(urlPublique).origin;
  return (req, _res, next) => {
    if (METHODES_SURES.has(req.method)) {
      next();
      return;
    }
    const origine = req.headers.origin;
    if (origine === undefined) {
      next(new ErreurHttp(403, 'csrf.origine_absente'));
    } else if (origine !== origineAutorisee) {
      next(new ErreurHttp(403, 'csrf.origine_refusee'));
    } else {
      next();
    }
  };
}
