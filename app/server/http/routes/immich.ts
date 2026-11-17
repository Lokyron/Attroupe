import express, { Router, type Request } from 'express';
import {
  configurerImmich,
  creerAlbumGroupe,
  lireDetailAlbumGroupe,
  lireEtatImmich,
  listerAlbumsGroupe,
  listerPhotosAlbum,
  modifierAlbumGroupe,
  retirerPhotoAlbum,
  supprimerAlbumGroupe,
  supprimerConfigurationImmich,
  televerserPhotosAlbum,
  testerConfigurationImmich,
  type FichierTeleverse,
} from '../../services/immich.js';
import type { Contexte } from '../contexte.js';
import { ErreurHttp } from '../erreurs.js';
import { exigerAdminGroupe, scopeDe } from '../middleware/appartenance.js';
import { parametre } from '../parametres.js';
import {
  schemaConfigImmich,
  schemaCreationAlbum,
  schemaModificationAlbum,
  schemaRequetePhotos,
  schemaTeleversementJson,
} from '../schemas/immich.js';
import { analyser } from '../schemas/valider.js';

// /api/groupes/:groupId/immich (admin) et /api/groupes/:groupId/albums (appartenance) — lot 11.

async function extraireFichiersTeleversement(req: Request): Promise<FichierTeleverse[]> {
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.toLowerCase().startsWith('multipart/form-data')) {
    if (!Buffer.isBuffer(req.body)) {
      throw new ErreurHttp(400, 'requete.invalide');
    }
    const requeteWeb = new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: new Uint8Array(req.body),
    });
    let formData: FormData;
    try {
      formData = await requeteWeb.formData();
    } catch {
      throw new ErreurHttp(400, 'requete.invalide');
    }
    const fichiers: FichierTeleverse[] = [];
    for (const [, valeur] of formData.entries()) {
      if (typeof valeur === 'string') continue;
      const mimeType = valeur.type || 'application/octet-stream';
      if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/')) {
        throw new ErreurHttp(400, 'requete.invalide', undefined, ['files']);
      }
      const buffer = Buffer.from(await valeur.arrayBuffer());
      if (buffer.length === 0) continue;
      fichiers.push({
        filename: valeur.name || 'photo.jpg',
        mimeType,
        buffer,
      });
    }
    if (fichiers.length === 0) throw new ErreurHttp(400, 'requete.invalide', undefined, ['files']);
    return fichiers;
  }

  const corps = analyser(schemaTeleversementJson, req.body);
  return corps.files.map((f) => ({
    filename: f.filename,
    mimeType: f.mime_type,
    buffer: Buffer.from(f.content_base64, 'base64'),
  }));
}

export function routesImmich(contexte: Contexte): Router {
  const routeur = Router({ mergeParams: true });

  routeur.get('/', exigerAdminGroupe, (req, res) => {
    res.json(lireEtatImmich(scopeDe(req)));
  });

  routeur.put('/', exigerAdminGroupe, async (req, res) => {
    const corps = analyser(schemaConfigImmich, req.body);
    res.json(await configurerImmich(contexte, scopeDe(req), corps));
  });

  routeur.delete('/', exigerAdminGroupe, (req, res) => {
    supprimerConfigurationImmich(scopeDe(req));
    res.json({ ok: true });
  });

  routeur.post('/test', exigerAdminGroupe, async (req, res) => {
    res.json(await testerConfigurationImmich(contexte, scopeDe(req)));
  });

  return routeur;
}

export function routesAlbums(contexte: Contexte): Router {
  const routeur = Router({ mergeParams: true });
  const parseurMultipart = express.raw({ type: 'multipart/form-data', limit: '50mb' });

  routeur.get('/', (req, res) => {
    res.json({ albums: listerAlbumsGroupe(contexte, scopeDe(req)) });
  });

  routeur.post('/', async (req, res) => {
    const corps = analyser(schemaCreationAlbum, req.body);
    res.status(201).json(await creerAlbumGroupe(contexte, scopeDe(req), corps));
  });

  routeur.get('/:albumId', (req, res) => {
    res.json(lireDetailAlbumGroupe(contexte, scopeDe(req), parametre(req, 'albumId')));
  });

  routeur.patch('/:albumId', (req, res) => {
    const champs = analyser(schemaModificationAlbum, req.body);
    res.json(modifierAlbumGroupe(contexte, scopeDe(req), parametre(req, 'albumId'), champs));
  });

  routeur.delete('/:albumId', (req, res) => {
    supprimerAlbumGroupe(scopeDe(req), parametre(req, 'albumId'));
    res.json({ ok: true });
  });

  routeur.get('/:albumId/photos', async (req, res) => {
    const { sync } = analyser(schemaRequetePhotos, req.query);
    res.json(await listerPhotosAlbum(contexte, scopeDe(req), parametre(req, 'albumId'), sync === 'true'));
  });

  routeur.post('/:albumId/photos', parseurMultipart, async (req, res) => {
    const fichiers = await extraireFichiersTeleversement(req);
    res.status(201).json(await televerserPhotosAlbum(contexte, scopeDe(req), parametre(req, 'albumId'), fichiers));
  });

  routeur.delete('/:albumId/photos/:assetId', async (req, res) => {
    await retirerPhotoAlbum(contexte, scopeDe(req), parametre(req, 'albumId'), parametre(req, 'assetId'));
    res.json({ ok: true });
  });

  return routeur;
}
