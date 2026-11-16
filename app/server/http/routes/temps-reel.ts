import { Router, type Response } from 'express';
import { sessionVivante } from '../../db/queries/comptes.js';
import { versInstant } from '../../domain/instant.js';
import type { SortieFlux } from '../../services/temps-reel.js';
import type { Contexte } from '../contexte.js';
import { ErreurHttp } from '../erreurs.js';
import { appartenanceActive, scopeDe } from '../middleware/appartenance.js';
import { exigerSession } from '../middleware/session.js';

// GET /api/groupes/:groupId/temps-reel : le flux SSE du groupe (architecture §3.2). DESCENDANT seulement : le client écrit par les routes
// ordinaires, qui diffusent ensuite. Monté sous le préfixe du groupe, donc derrière `exigerAppartenance` : un étranger reçoit son 404 AVANT
// que le flux ne s'ouvre (jamais d'en-têtes SSE pour qui n'a pas prouvé son appartenance).
//
// Cette connexion reste ouverte des heures : l'appartenance prouvée à l'ouverture ne vaut pas pour la suite. Le diffuseur la REPROUVE avant
// chaque envoi (voir services/temps-reel.ts) avec la fermeture ci-dessous : `toujoursAutorise` relit l'appartenance et la session en base.

/** Délai de reconnexion conseillé au navigateur (`retry:`). */
const RECONNEXION_MS = 5000;
/** Un client qui n'absorbe pas : au-delà de ce volume en attente d'écriture, on le coupe (il se reconnectera et rechargera). */
const TAMPON_MAX_OCTETS = 64 * 1024;
/** Indication de nouvelle tentative pour un client refusé par le plafond de connexions. */
const REESSAI_PLAFOND_SECONDES = 30;

function sortieDe(res: Response): SortieFlux {
  return {
    ecrire: (bloc) => {
      if (res.writableEnded || res.destroyed) return false;
      res.write(bloc);
      return res.writableLength <= TAMPON_MAX_OCTETS;
    },
    terminer: () => {
      if (!res.writableEnded) res.end();
    },
  };
}

export function routesTempsReel(contexte: Contexte): Router {
  const routeur = Router({ mergeParams: true });

  routeur.get('/', (req, res) => {
    const scope = scopeDe(req);
    const { portee, sessionId } = exigerSession(req);
    const connexion = contexte.diffuseur.ouvrir(scope, sortieDe(res), () => {
      // Rejouée avant chaque envoi : la session n'est pas révoquée ET l'appartenance au groupe est toujours active.
      return sessionVivante(portee, sessionId, versInstant(contexte.horloge())) && appartenanceActive(contexte, scope.userId, scope.groupId);
    });
    // Plafond atteint : 429 JSON ordinaire, avant tout en-tête de flux. (EventSource ne retente pas sur un statut d'erreur : le client le fait.)
    if (connexion === undefined) throw new ErreurHttp(429, 'flux.trop_de_connexions', REESSAI_PLAFOND_SECONDES);

    // Le retrait doit se faire à la fermeture ET à l'erreur de socket : sans l'un des deux, le registre garderait un abonné mort.
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true, 30_000);
    res.on('close', connexion.retirer);
    res.on('error', connexion.retirer);
    req.on('error', connexion.retirer);
    req.socket.on('error', connexion.retirer);

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx Proxy Manager tamponnerait sinon la réponse et le client ne verrait rien avant la fermeture.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(`retry: ${String(RECONNEXION_MS)}\n: ouvert\n\n`);
  });

  return routeur;
}
