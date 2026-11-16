import { Router } from 'express';
import { calculerEtag, genererFlux } from '../../services/flux-ical.js';
import type { Contexte } from '../contexte.js';
import { accesFlux, jetonFlux } from '../middleware/jeton-flux.js';

// /ical/:jeton.ics — HORS /api : pas de cookie, pas de CSRF, pas de session. L'extension est dans le chemin parce que certains
// clients de calendrier refusent une URL sans extension. L'authentification est le jeton seul (intergiciel `jetonFlux`), qui
// fabrique les portées ; cette route ne lit rien d'autre que ce que ces portées lui donnent.

/** Les clients (iOS, Android) interrogent à heure fixe : cinq minutes de cache privé. */
const CACHE_CONTROL = 'private, max-age=300';

export function routesIcal(contexte: Contexte): Router {
  const routeur = Router();

  routeur.get('/:jeton.ics', jetonFlux(contexte), (req, res) => {
    const acces = accesFlux(req);
    const etag = calculerEtag(acces);
    res.set({ 'Cache-Control': CACHE_CONTROL, ETag: etag });
    // `If-None-Match` peut lister plusieurs empreintes, ou `*`.
    const propose = (req.get('if-none-match') ?? '').split(',').map((e) => e.trim().replace(/^W\//, ''));
    if (propose.includes(etag)) {
      res.status(304).end();
      return;
    }
    res.type('text/calendar; charset=utf-8').send(genererFlux(acces, contexte.env.ATTROUPE_BASE_URL.replace(/\/+$/, '')));
  });

  return routeur;
}
