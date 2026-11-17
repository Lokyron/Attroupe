import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Router } from 'express';
import { servirMediaSigne } from '../../services/immich.js';
import type { Contexte } from '../contexte.js';
import { exigerSession, gardeSession, intergicielSession } from '../middleware/session.js';
import { declarerIntergiciel } from '../montage.js';
import { parametre } from '../parametres.js';
import { schemaRequeteMedia } from '../schemas/immich.js';
import { analyser } from '../schemas/valider.js';

// /media/:albumId/:assetId/:taille — HORS /api, mais avec session requise (la signature HMAC inclut `userId`).
// Relaie les binaires depuis Immich sans jamais exposer son URL ni sa clé d'API au navigateur.

export function routesMedia(contexte: Contexte): Router {
  const routeur = Router();
  routeur.use(declarerIntergiciel('garde', intergicielSession(contexte)));
  routeur.use(gardeSession);

  routeur.get('/:albumId/:assetId/:taille', async (req, res) => {
    const { portee } = exigerSession(req);
    const { exp, sig } = analyser(schemaRequeteMedia, req.query);
    const media = await servirMediaSigne(contexte, portee, {
      albumId: parametre(req, 'albumId'),
      assetId: parametre(req, 'assetId'),
      taille: parametre(req, 'taille'),
      exp,
      sig,
    });

    res.status(media.status);
    if (media.contentType !== null) {
      res.setHeader('Content-Type', media.contentType);
    }
    res.setHeader('Cache-Control', media.status >= 200 && media.status < 300 ? 'private, max-age=300' : 'no-store');

    if (media.body === null) {
      res.end();
      return;
    }
    if (media.body instanceof ArrayBuffer) {
      res.send(Buffer.from(media.body));
      return;
    }
    try {
      await pipeline(Readable.fromWeb(media.body as WebReadableStream<Uint8Array>), res);
    } catch {
      if (!res.headersSent) res.status(502);
      if (!res.writableEnded) res.end();
    }
  });

  return routeur;
}
