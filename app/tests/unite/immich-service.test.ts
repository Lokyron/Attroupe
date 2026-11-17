import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { creerPorteeUtilisateur } from '../../server/db/portee-utilisateur.js';
import { lireConfigImmich } from '../../server/db/queries/immich.js';
import { creerScope } from '../../server/db/scope.js';
import type { Contexte } from '../../server/http/contexte.js';
import { ErreurHttp } from '../../server/http/erreurs.js';
import { detailGroupe } from '../../server/services/groupes.js';
import { ClientImmich, type DnsLookupImmich, type FetchImmich } from '../../server/services/immich-client.js';
import {
  configurerImmich,
  creerAlbumGroupe,
  lireEtatImmich,
  listerAlbumsGroupe,
  listerPhotosAlbum,
  retirerPhotoAlbum,
  servirMediaSigne,
  supprimerConfigurationImmich,
  televerserPhotosAlbum,
  testerConfigurationImmich,
} from '../../server/services/immich.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';
import { envValide } from '../fixtures/env.js';

function creerDoubleImmich(): {
  fetchImmich: FetchImmich;
  dnsLookup: DnsLookupImmich;
  appels: Array<{ methode: string; url: string; headers: Headers }>;
  assetsParAlbum: Map<string, Array<{ id: string; type: 'IMAGE' | 'VIDEO'; fileCreatedAt: string }>>;
  prochainStatutUpload?: number;
} {
  let compteur = 0;
  const appels: Array<{ methode: string; url: string; headers: Headers }> = [];
  const assetsParAlbum = new Map<string, Array<{ id: string; type: 'IMAGE' | 'VIDEO'; fileCreatedAt: string }>>();

  const fetchImmich: FetchImmich = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const methode = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    appels.push({ methode, url, headers });

    const chemin = new URL(url).pathname.replace(/^\/api/, '');
    if (methode === 'GET' && chemin === '/users/me') {
      return new Response(JSON.stringify({ id: 'immich-u-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (methode === 'POST' && chemin === '/albums') {
      compteur += 1;
      const id = `immich-alb-${compteur}`;
      assetsParAlbum.set(id, []);
      return new Response(JSON.stringify({ id }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (methode === 'GET' && chemin.startsWith('/albums/')) {
      const id = decodeURIComponent(chemin.slice('/albums/'.length));
      return new Response(JSON.stringify({ id, assets: assetsParAlbum.get(id) ?? [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (methode === 'POST' && chemin === '/assets') {
      compteur += 1;
      return new Response(JSON.stringify({ id: `immich-asset-${compteur}` }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (methode === 'PUT' && chemin.endsWith('/assets')) {
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (methode === 'DELETE' && chemin.endsWith('/assets')) {
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (methode === 'GET' && chemin.startsWith('/assets/')) {
      return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
  };

  const dnsLookup: DnsLookupImmich = async () => [{ address: '93.184.216.34', family: 4 }];
  return { fetchImmich, dnsLookup, appels, assetsParAlbum };
}

function creerContexteTest(
  base: BaseTemporaire['base'],
  horloge: () => Date,
  fetchImmich: FetchImmich,
  dnsLookupImmich: DnsLookupImmich,
): Contexte {
  return {
    base,
    env: envValide({ ATTROUPE_BASE_URL: 'https://attroupe.exemple.test' }),
    horloge,
    fetchImmich,
    dnsLookupImmich,
  } as unknown as Contexte;
}

describe('ClientImmich anti-SSRF et résilience réseau', () => {
  it('bloque un rebond DNS vers une IP privée ou 169.254.169.254', async () => {
    let appele = false;
    const client = new ClientImmich({
      allowPrivate: false,
      dnsLookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
      fetchImpl: async () => {
        appele = true;
        return new Response('{}', { status: 200 });
      },
    });
    const res = await client.testerConnexion('https://photos.exemple.fr/api', 'cle-1');
    expect(res.status).toBe('unreachable');
    expect(appele).toBe(false);

    const clientPrive = new ClientImmich({
      allowPrivate: true,
      dnsLookupImpl: async () => [{ address: '169.254.169.254', family: 4 }],
      fetchImpl: async () => {
        appele = true;
        return new Response('{}', { status: 200 });
      },
    });
    const resMeta = await clientPrive.testerConnexion('https://photos.exemple.fr/api', 'cle-1');
    expect(resMeta.status).toBe('unreachable');
    expect(appele).toBe(false);
  });

  it('ne réessaie pas sur 4xx mais réessaie une fois sur 5xx avec redirect manual', async () => {
    let essais401 = 0;
    const client401 = new ClientImmich({
      dnsLookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async (_url, init) => {
        essais401 += 1;
        expect(init?.redirect).toBe('manual');
        return new Response('Unauthorized', { status: 401 });
      },
    });
    const res401 = await client401.testerConnexion('https://photos.exemple.fr/api', 'mauvaise-cle');
    expect(res401.status).toBe('unauthorized');
    expect(essais401).toBe(1);

    let essais502 = 0;
    const client502 = new ClientImmich({
      dnsLookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () => {
        essais502 += 1;
        if (essais502 === 1) return new Response('Bad Gateway', { status: 502 });
        return new Response(JSON.stringify({ id: 'u1' }), { status: 200 });
      },
    });
    const res502 = await client502.testerConnexion('https://photos.exemple.fr/api', 'bonne-cle');
    expect(res502).toEqual({ status: 'ok', immich_user_id: 'u1' });
    expect(essais502).toBe(2);
  });
});

describe('ClientImmich : le délai ne borne que les en-têtes d’un média', () => {
  let serveur: Server;
  let baseUrl = '';

  beforeEach(async () => {
    serveur = createServer((req, res) => {
      if (req.url?.startsWith('/api/assets/lent/original') === true) {
        // En-têtes immédiats, puis 5 morceaux espacés de 150 ms : ~750 ms au total, bien au-delà du délai de 300 ms.
        res.writeHead(200, { 'content-type': 'video/mp4' });
        let envoyes = 0;
        const minuteur = setInterval(() => {
          res.write('0123456789');
          envoyes += 1;
          if (envoyes === 5) {
            clearInterval(minuteur);
            res.end();
          }
        }, 150);
        res.on('close', () => clearInterval(minuteur));
        return;
      }
      // En-têtes jamais envoyés : l'appel doit échouer sur le délai.
      res.on('close', () => undefined);
    });
    await new Promise<void>((resolve) => serveur.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}/api`;
  });

  afterEach(async () => {
    serveur.closeAllConnections();
    await new Promise<void>((resolve) => serveur.close(() => resolve()));
  });

  it('livre un corps entier même si le transfert dépasse le délai', async () => {
    const client = new ClientImmich({ allowPrivate: true, delaiMs: 300 });
    const media = await client.recupererMediaImmich(baseUrl, 'cle', 'lent', 'original');
    expect(media.status).toBe(200);
    if (media.body === null || media.body instanceof ArrayBuffer) throw new Error('flux attendu');
    const lecteur = media.body.getReader();
    const morceaux: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      morceaux.push(value);
    }
    expect(Buffer.concat(morceaux).toString()).toBe('0123456789'.repeat(5));
  });

  it('échoue toujours si les en-têtes n’arrivent pas dans le délai', async () => {
    const client = new ClientImmich({ allowPrivate: true, delaiMs: 200 });
    await expect(client.recupererMediaImmich(baseUrl, 'cle', 'muet', 'original')).rejects.toMatchObject({ code: 'injoignable' });
  });
});

describe('service Immich & Photos (unité)', () => {
  let t: BaseTemporaire;
  let d: DeuxGroupes;
  let maintenant: Date;
  let contexte: Contexte;
  let double: ReturnType<typeof creerDoubleImmich>;

  beforeEach(() => {
    t = baseTemporaire();
    d = deuxGroupes(t.base);
    maintenant = new Date('2027-04-01T12:00:00Z');
    double = creerDoubleImmich();
    contexte = creerContexteTest(t.base, () => maintenant, double.fetchImmich, double.dnsLookup);
  });
  afterEach(() => t.nettoyer());

  it('sans configuration Immich : fonctionnalites.photos est false et les routes albums répondent 409 immich.non_configure', async () => {
    expect(detailGroupe(d.scopeA).fonctionnalites.photos).toBe(false);
    expect(lireEtatImmich(d.scopeA)).toEqual({ configure: false });
    expect(() => listerAlbumsGroupe(contexte, d.scopeA)).toThrowError(ErreurHttp);
    try {
      listerAlbumsGroupe(contexte, d.scopeA);
    } catch (e) {
      expect(e).toBeInstanceOf(ErreurHttp);
      expect((e as ErreurHttp).statut).toBe(409);
      expect((e as ErreurHttp).cle).toBe('immich.non_configure');
    }
  });

  it('chiffre la clé au repos, ne l’expose jamais, active photos: true et relaie les URL signées', async () => {
    const etat = await configurerImmich(contexte, d.scopeA, {
      base_url: 'https://photos.exemple.fr/api/',
      api_key: 'super-cle-secrete-immich',
    });
    expect(etat).toMatchObject({
      configure: true,
      base_url: 'https://photos.exemple.fr/api',
      status: 'ok',
    });
    expect(JSON.stringify(etat)).not.toContain('super-cle-secrete-immich');
    expect(JSON.stringify(etat)).not.toContain('api_key_cipher');

    const brut = lireConfigImmich(d.scopeA);
    expect(brut?.api_key_cipher.toString('utf8')).not.toContain('super-cle-secrete-immich');

    expect(detailGroupe(d.scopeA).fonctionnalites.photos).toBe(true);

    const album = await creerAlbumGroupe(contexte, d.scopeA, { title: 'Week-end Jura' });
    expect(album.title).toBe('Week-end Jura');

    const { photos } = await televerserPhotosAlbum(contexte, d.scopeA, album.id, [
      { filename: 'lac.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([1, 2, 3, 4]) },
    ]);
    expect(photos).toHaveLength(1);
    const photo = photos[0];
    if (photo === undefined) throw new Error('Photo manquante.');
    expect(photo.thumbnail_url).toContain(`/media/${album.id}/${photo.immich_asset_id}/thumbnail?`);

    // Vérifie la signature HMAC de l'URL générée : Alice peut lire, Bob ne peut pas rejouer l'URL d'Alice.
    const url = new URL(photo.thumbnail_url, 'https://attroupe.exemple.test');
    const exp = url.searchParams.get('exp');
    const sig = url.searchParams.get('sig');
    if (exp === null || sig === null) throw new Error('Paramètres de signature manquants.');

    const porteeAlice = creerPorteeUtilisateur(t.base, d.a.userId);
    const mediaAlice = await servirMediaSigne(contexte, porteeAlice, {
      albumId: album.id,
      assetId: photo.immich_asset_id,
      taille: 'thumbnail',
      exp,
      sig,
    });
    expect(mediaAlice.status).toBe(200);

    const porteeBob = creerPorteeUtilisateur(t.base, d.b.userId);
    await expect(
      servirMediaSigne(contexte, porteeBob, {
        albumId: album.id,
        assetId: photo.immich_asset_id,
        taille: 'thumbnail',
        exp,
        sig,
      }),
    ).rejects.toMatchObject({ statut: 403, cle: 'media.signature_invalide' });

    // Retrait d'Alice de A : même avec sa propre URL signée valide, elle reçoit 404 media.introuvable.
    t.sql
      .prepare("UPDATE memberships SET status = 'removed', ended_at = '2027-04-01T12:00:00Z' WHERE group_id = ? AND user_id = ?")
      .run(d.a.groupId, d.a.userId);
    await expect(
      servirMediaSigne(contexte, porteeAlice, {
        albumId: album.id,
        assetId: photo.immich_asset_id,
        taille: 'thumbnail',
        exp,
        sig,
      }),
    ).rejects.toMatchObject({ statut: 404, cle: 'media.introuvable' });
  });

  it('gère le droit fin de suppression photo (auteur ou admin → ok, autre membre → 403) et le débranchement', async () => {
    await configurerImmich(contexte, d.scopeA, {
      base_url: 'https://photos.exemple.fr/api',
      api_key: 'cle-a',
    });
    const album = await creerAlbumGroupe(contexte, d.scopeA, { title: 'Soirée' });
    await televerserPhotosAlbum(contexte, d.scopeA, album.id, [
      { filename: 'a.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([1, 2, 3]) },
    ]);

    // Ajoute un simple membre Carole dans A
    const caroleId = '01900000-0000-7000-8000-000000000099';
    const memCarole = '01900000-0000-7000-8000-000000000199';
    t.sql
      .prepare(
        "INSERT INTO users (id, email, username, display_name, password_hash, email_verified_at, created_at, updated_at) VALUES (?, 'carole@exemple.test', 'carole_t', 'Carole', 'hash', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
      )
      .run(caroleId);
    t.sql
      .prepare(
        "INSERT INTO memberships (id, group_id, user_id, role, status, joined_at, created_at, updated_at) VALUES (?, ?, ?, 'member', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
      )
      .run(memCarole, d.a.groupId, caroleId);
    const scopeCarole = creerScope(t.base, caroleId, d.a.groupId);

    double.assetsParAlbum.set(album.immich_album_id, [
      { id: 'immich-asset-2', type: 'IMAGE', fileCreatedAt: '2027-04-01T12:00:00Z' },
    ]);
    const liste = await listerPhotosAlbum(contexte, scopeCarole, album.id, true);
    expect(liste.photos).toHaveLength(1);

    // Carole ne peut pas retirer la photo déposée par Alice (403 droit.photo_requis)
    const { photos: photosAvant } = await televerserPhotosAlbum(contexte, d.scopeA, album.id, [
      { filename: 'b.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([4, 5, 6]) },
    ]);
    const photoB = photosAvant[0];
    if (photoB === undefined) throw new Error('Photo B manquante.');
    await expect(retirerPhotoAlbum(contexte, scopeCarole, album.id, photoB.immich_asset_id)).rejects.toMatchObject({
      statut: 403,
      cle: 'droit.photo_requis',
    });

    // Alice (auteure / admin) peut la retirer
    await retirerPhotoAlbum(contexte, d.scopeA, album.id, photoB.immich_asset_id);

    // Test connexion & débranchement
    const testEtat = await testerConfigurationImmich(contexte, d.scopeA);
    expect(testEtat).toMatchObject({ configure: true, status: 'ok' });

    supprimerConfigurationImmich(d.scopeA);
    expect(detailGroupe(d.scopeA).fonctionnalites.photos).toBe(false);
  });
});
