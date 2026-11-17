import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Decor } from '../fixtures/comptes.js';
import { decor, groupe, personne, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';

describe('photos et intégration Immich (intégration HTTP)', () => {
  let d: Decor;
  let alice: Personne;
  let carole: Personne;
  let gA: GroupeAmorce;

  beforeEach(async () => {
    let compteur = 0;
    const fetchImmich = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const methode = (init?.method ?? 'GET').toUpperCase();
      const chemin = new URL(url).pathname.replace(/^\/api/, '');
      if (methode === 'GET' && chemin === '/users/me') {
        return new Response(JSON.stringify({ id: 'immich-user-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (methode === 'POST' && chemin === '/albums') {
        compteur += 1;
        return new Response(JSON.stringify({ id: `immich-alb-${compteur}` }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      if (methode === 'GET' && chemin.startsWith('/albums/')) {
        return new Response(JSON.stringify({ id: chemin.slice('/albums/'.length), assets: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (methode === 'POST' && chemin === '/assets') {
        compteur += 1;
        return new Response(JSON.stringify({ id: `immich-asset-${compteur}` }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      if ((methode === 'PUT' || methode === 'DELETE') && chemin.endsWith('/assets')) {
        return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (methode === 'GET' && chemin.startsWith('/assets/')) {
        return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    };
    const dnsLookupImmich = async () => [{ address: '93.184.216.34', family: 4 }] as const;

    d = decor({ fetchImmich, dnsLookupImmich });
    alice = await personne(d, 'alice_im');
    carole = await personne(d, 'carole_im');
    gA = await groupe(d, 'Groupe Photo', [
      { personne: alice, role: 'admin' },
      { personne: carole, role: 'member' },
    ]);
  });
  afterEach(() => d.nettoyer());

  it('parcours complet : sans config → 409, config admin, création album, upload, relai /media signé, débranchement', async () => {
    // Sans configuration : detailGroupe.fonctionnalites.photos === false et /albums → 409
    const avant = await carole.client.get(`/api/groupes/${gA.groupId}`);
    expect(avant.statut).toBe(200);
    expect((avant.corps['fonctionnalites'] as { photos: boolean }).photos).toBe(false);

    const albumsAvant = await carole.client.get(`/api/groupes/${gA.groupId}/albums`);
    expect(albumsAvant.statut).toBe(409);
    expect(albumsAvant.corps).toEqual({ error: 'immich.non_configure' });

    // Configuration par admin (Carole reçoit 403)
    const cfgCarole = await carole.client.put(`/api/groupes/${gA.groupId}/immich`, {
      base_url: 'https://immich.exemple.test/api',
      api_key: 'cle-secrete',
    });
    expect(cfgCarole.statut).toBe(403);

    const cfgAlice = await alice.client.put(`/api/groupes/${gA.groupId}/immich`, {
      base_url: 'https://immich.exemple.test/api',
      api_key: 'cle-secrete',
    });
    expect(cfgAlice.statut).toBe(200);
    expect(cfgAlice.corps['configure']).toBe(true);
    expect(cfgAlice.corps['status']).toBe('ok');
    expect(JSON.stringify(cfgAlice.corps)).not.toContain('cle-secrete');

    // Création album + upload photo + lecture des URL signées
    const album = await alice.client.post(`/api/groupes/${gA.groupId}/albums`, { title: 'Vacances' });
    expect(album.statut).toBe(201);
    const albumId = album.corps['id'] as string;

    const upload = await carole.client.post(`/api/groupes/${gA.groupId}/albums/${albumId}/photos`, {
      files: [{ filename: 'plage.jpg', mime_type: 'image/jpeg', content_base64: 'AQID' }],
    });
    expect(upload.statut).toBe(201);
    const photos = upload.corps['photos'] as Array<{ thumbnail_url: string }>;
    const premiere = photos[0];
    if (premiere === undefined) throw new Error('Photo manquante.');
    const urlCarole = premiere.thumbnail_url;

    // Carole lit sa vignette, Alice ne peut pas rejouer l'URL signée pour Carole
    const mediaCarole = await carole.client.get(urlCarole);
    expect(mediaCarole.statut).toBe(200);
    const rejeuAlice = await alice.client.get(urlCarole);
    expect(rejeuAlice.statut).toBe(403);
    expect(rejeuAlice.corps).toEqual({ error: 'media.signature_invalide' });

    // Débranchement
    const del = await alice.client.delete(`/api/groupes/${gA.groupId}/immich`);
    expect(del.statut).toBe(200);
    const apres = await alice.client.get(`/api/groupes/${gA.groupId}`);
    expect((apres.corps['fonctionnalites'] as { photos: boolean }).photos).toBe(false);
  });
});
