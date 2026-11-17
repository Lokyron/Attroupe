import { createHash } from 'node:crypto';
import type { PorteeUtilisateur } from '../db/portee-utilisateur.js';
import { lireEvenement } from '../db/queries/evenements.js';
import {
  creerAlbum,
  enregistrerAssetAjoute,
  enregistrerConfigImmich,
  lireAlbum,
  lireAlbumParEvenement,
  lireAssetAlbum,
  lireConfigImmich,
  listerAlbums,
  listerAssetsAlbum,
  mettreAJourStatutImmich,
  modifierAlbum,
  resoudreMediaPourUtilisateur,
  retirerAssetAlbum,
  supprimerAlbum,
  supprimerConfigImmich,
  synchroniserAssetsAlbum,
  type Album,
  type AssetAlbum,
  type ConfigImmich,
} from '../db/queries/immich.js';
import type { GroupScope } from '../db/scope.js';
import {
  chiffrerCleImmich,
  construireUrlMediaSignee,
  dechiffrerCleImmich,
  validerUrlImmich,
  verifierSignatureMedia,
} from '../domain/immich.js';
import { versInstant } from '../domain/instant.js';
import type { Contexte } from '../http/contexte.js';
import { ErreurHttp } from '../http/erreurs.js';
import { ClientImmich, ErreurClientImmich, type MediaImmich } from './immich-client.js';

// Service Immich / Photos (lot 11, architecture §6, §7.2, ADR-0003).
// - La clé d'API Immich n'est jamais renvoyée en clair ni sous forme chiffrée : seule son empreinte courte est exposée.
// - Sans configuration Immich pour le groupe, toutes les opérations d'albums/photos répondent 409 `immich.non_configure`.

const DELAI_RESYNC_MS = 5 * 60 * 1000;

export type EtatImmichPublic =
  | { readonly configure: false }
  | {
      readonly configure: true;
      readonly base_url: string;
      readonly api_key_fingerprint: string;
      readonly status: 'ok' | 'unreachable' | 'unauthorized' | 'untested';
      readonly last_checked_at: string | null;
      readonly last_error: string | null;
    };

export interface PhotoSignee extends AssetAlbum {
  readonly thumbnail_url: string;
  readonly preview_url: string;
  readonly original_url: string;
}

export interface AlbumAvecCouverture extends Album {
  readonly cover_url: string | null;
}

export interface FichierTeleverse {
  readonly filename: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}

function clientImmichDe(contexte: Contexte): ClientImmich {
  return new ClientImmich({
    allowPrivate: contexte.env.ATTROUPE_IMMICH_ALLOW_PRIVATE,
    ...(contexte.fetchImmich !== undefined ? { fetchImpl: contexte.fetchImmich } : {}),
    ...(contexte.dnsLookupImmich !== undefined ? { dnsLookupImpl: contexte.dnsLookupImmich } : {}),
  });
}

function versEtatPublic(config: ConfigImmich | undefined): EtatImmichPublic {
  if (config === undefined) return { configure: false };
  return {
    configure: true,
    base_url: config.base_url,
    api_key_fingerprint: config.api_key_fingerprint,
    status: config.status,
    last_checked_at: config.last_checked_at,
    last_error: config.last_error,
  };
}

function exigerConfigImmich(scope: GroupScope): ConfigImmich {
  const config = lireConfigImmich(scope);
  if (config === undefined) throw new ErreurHttp(409, 'immich.non_configure');
  return config;
}

function dechiffrerCle(contexte: Contexte, config: ConfigImmich): string {
  return dechiffrerCleImmich(config.api_key_cipher, config.api_key_nonce, contexte.env.ATTROUPE_ENCRYPTION_KEY);
}

function enrichirAlbum(contexte: Contexte, scope: GroupScope, album: Album): AlbumAvecCouverture {
  const cover_url =
    album.cover_immich_asset_id !== null
      ? construireUrlMediaSignee(
          {
            albumId: album.id,
            assetId: album.cover_immich_asset_id,
            taille: 'thumbnail',
            userId: scope.userId,
            maintenant: contexte.horloge(),
          },
          contexte.env.ATTROUPE_SIGNED_URL_SECRET,
        )
      : null;
  return { ...album, cover_url };
}

function enrichirPhoto(contexte: Contexte, scope: GroupScope, albumId: string, asset: AssetAlbum): PhotoSignee {
  const maintenant = contexte.horloge();
  const secret = contexte.env.ATTROUPE_SIGNED_URL_SECRET;
  return {
    ...asset,
    thumbnail_url: construireUrlMediaSignee(
      { albumId, assetId: asset.immich_asset_id, taille: 'thumbnail', userId: scope.userId, maintenant },
      secret,
    ),
    preview_url: construireUrlMediaSignee(
      { albumId, assetId: asset.immich_asset_id, taille: 'preview', userId: scope.userId, maintenant },
      secret,
    ),
    original_url: construireUrlMediaSignee(
      { albumId, assetId: asset.immich_asset_id, taille: 'original', userId: scope.userId, maintenant },
      secret,
    ),
  };
}

export function lireEtatImmich(scope: GroupScope): EtatImmichPublic {
  return versEtatPublic(lireConfigImmich(scope));
}

export async function configurerImmich(
  contexte: Contexte,
  scope: GroupScope,
  entree: { base_url: string; api_key: string },
): Promise<EtatImmichPublic> {
  const validation = validerUrlImmich(entree.base_url, contexte.env.ATTROUPE_IMMICH_ALLOW_PRIVATE);
  if (!validation.valide) {
    throw new ErreurHttp(400, 'immich.url_invalide');
  }

  const chiffree = chiffrerCleImmich(entree.api_key, contexte.env.ATTROUPE_ENCRYPTION_KEY);
  const client = clientImmichDe(contexte);
  const test = await client.testerConnexion(validation.urlNormalisee, entree.api_key);
  const maintenant = versInstant(contexte.horloge());

  const enregistree = enregistrerConfigImmich(scope, {
    base_url: validation.urlNormalisee,
    api_key_cipher: chiffree.cipher,
    api_key_nonce: chiffree.nonce,
    api_key_fingerprint: chiffree.fingerprint,
    immich_user_id: test.status === 'ok' ? test.immich_user_id : null,
    status: test.status,
    last_checked_at: maintenant,
    last_error: test.status === 'ok' ? null : test.error,
  });

  return versEtatPublic(enregistree);
}

export function supprimerConfigurationImmich(scope: GroupScope): void {
  supprimerConfigImmich(scope);
}

export async function testerConfigurationImmich(contexte: Contexte, scope: GroupScope): Promise<EtatImmichPublic> {
  const config = exigerConfigImmich(scope);
  const apiKey = dechiffrerCle(contexte, config);
  const client = clientImmichDe(contexte);
  const test = await client.testerConnexion(config.base_url, apiKey);
  const maintenant = versInstant(contexte.horloge());

  const maj = mettreAJourStatutImmich(scope, {
    status: test.status,
    last_checked_at: maintenant,
    last_error: test.status === 'ok' ? null : test.error,
    ...(test.status === 'ok' && test.immich_user_id !== null ? { immich_user_id: test.immich_user_id } : {}),
  });

  return versEtatPublic(maj ?? config);
}

export function listerAlbumsGroupe(contexte: Contexte, scope: GroupScope): AlbumAvecCouverture[] {
  exigerConfigImmich(scope);
  return listerAlbums(scope).map((a) => enrichirAlbum(contexte, scope, a));
}

export async function creerAlbumGroupe(
  contexte: Contexte,
  scope: GroupScope,
  entree: { title: string; event_id?: string | null | undefined },
): Promise<AlbumAvecCouverture> {
  const config = exigerConfigImmich(scope);
  const eventId = entree.event_id ?? null;

  if (eventId !== null) {
    const evenement = lireEvenement(scope, eventId);
    if (evenement === undefined) throw new ErreurHttp(404, 'evenement.introuvable');
    const existant = lireAlbumParEvenement(scope, eventId);
    if (existant !== undefined) throw new ErreurHttp(409, 'album.evenement_deja_lie');
  }

  const apiKey = dechiffrerCle(contexte, config);
  const client = clientImmichDe(contexte);
  let immichAlbum: { id: string };
  try {
    immichAlbum = await client.creerAlbumImmich(config.base_url, apiKey, entree.title);
  } catch (erreur) {
    if (erreur instanceof ErreurClientImmich && erreur.code === 'non_autorise') {
      throw new ErreurHttp(502, 'immich.non_autorise');
    }
    throw new ErreurHttp(502, 'immich.injoignable');
  }

  try {
    const cree = creerAlbum(scope, {
      title: entree.title,
      event_id: eventId,
      immich_album_id: immichAlbum.id,
    });
    return enrichirAlbum(contexte, scope, cree);
  } catch (erreur) {
    if (erreur instanceof Error && 'code' in erreur && erreur.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new ErreurHttp(409, 'album.evenement_deja_lie');
    }
    throw erreur;
  }
}

export function lireDetailAlbumGroupe(contexte: Contexte, scope: GroupScope, albumId: string): AlbumAvecCouverture {
  exigerConfigImmich(scope);
  const album = lireAlbum(scope, albumId);
  if (album === undefined) throw new ErreurHttp(404, 'album.introuvable');
  return enrichirAlbum(contexte, scope, album);
}

export function modifierAlbumGroupe(
  contexte: Contexte,
  scope: GroupScope,
  albumId: string,
  champs: { title?: string | undefined; cover_immich_asset_id?: string | null | undefined },
): AlbumAvecCouverture {
  exigerConfigImmich(scope);
  const album = lireAlbum(scope, albumId);
  if (album === undefined) throw new ErreurHttp(404, 'album.introuvable');
  if (champs.cover_immich_asset_id !== undefined && champs.cover_immich_asset_id !== null) {
    const asset = lireAssetAlbum(scope, albumId, champs.cover_immich_asset_id);
    if (asset === undefined) throw new ErreurHttp(404, 'photo.introuvable');
  }
  const modifie = modifierAlbum(scope, albumId, champs);
  if (modifie === undefined) throw new ErreurHttp(404, 'album.introuvable');
  return enrichirAlbum(contexte, scope, modifie);
}

export function supprimerAlbumGroupe(scope: GroupScope, albumId: string): void {
  exigerConfigImmich(scope);
  if (!supprimerAlbum(scope, albumId)) throw new ErreurHttp(404, 'album.introuvable');
}

export async function listerPhotosAlbum(
  contexte: Contexte,
  scope: GroupScope,
  albumId: string,
  forcerSync = false,
): Promise<{ album: AlbumAvecCouverture; photos: PhotoSignee[] }> {
  const config = exigerConfigImmich(scope);
  let album = lireAlbum(scope, albumId);
  if (album === undefined) throw new ErreurHttp(404, 'album.introuvable');

  const maintenantDate = contexte.horloge();
  const maintenant = versInstant(maintenantDate);
  const dernierSyncMs = album.last_synced_at !== null ? Date.parse(album.last_synced_at) : Number.NaN;
  const doitSynchroniser =
    forcerSync || Number.isNaN(dernierSyncMs) || maintenantDate.getTime() - dernierSyncMs > DELAI_RESYNC_MS;

  if (doitSynchroniser) {
    const apiKey = dechiffrerCle(contexte, config);
    const client = clientImmichDe(contexte);
    try {
      const assetsImmich = await client.listerAssetsAlbumImmich(config.base_url, apiKey, album.immich_album_id);
      synchroniserAssetsAlbum(scope, albumId, assetsImmich, maintenant);
      album = lireAlbum(scope, albumId) ?? album;
    } catch {
      // Tolérant : si Immich est momentanément injoignable, on garde le cache local et on marque sync_status='error'.
      album = modifierAlbum(scope, albumId, { sync_status: 'error' }) ?? album;
    }
  }

  const assets = listerAssetsAlbum(scope, albumId);
  return {
    album: enrichirAlbum(contexte, scope, album),
    photos: assets.map((a) => enrichirPhoto(contexte, scope, albumId, a)),
  };
}

export async function televerserPhotosAlbum(
  contexte: Contexte,
  scope: GroupScope,
  albumId: string,
  fichiers: readonly FichierTeleverse[],
): Promise<{ photos: PhotoSignee[] }> {
  const config = exigerConfigImmich(scope);
  const album = lireAlbum(scope, albumId);
  if (album === undefined) throw new ErreurHttp(404, 'album.introuvable');
  if (fichiers.length === 0) throw new ErreurHttp(400, 'requete.invalide');

  const apiKey = dechiffrerCle(contexte, config);
  const client = clientImmichDe(contexte);
  const fileCreatedAt = versInstant(contexte.horloge());
  const ajoutees: PhotoSignee[] = [];

  for (const fichier of fichiers) {
    const sha1 = createHash('sha1').update(fichier.buffer).digest('hex');
    let res: { id: string };
    try {
      res = await client.televerserAssetImmich(config.base_url, apiKey, album.immich_album_id, {
        buffer: fichier.buffer,
        filename: fichier.filename,
        mimeType: fichier.mimeType,
        fileCreatedAt,
        sha1,
      });
    } catch (erreur) {
      if (erreur instanceof ErreurClientImmich && erreur.code === 'non_autorise') {
        throw new ErreurHttp(502, 'immich.non_autorise');
      }
      throw new ErreurHttp(502, 'immich.injoignable');
    }

    const enregistre = enregistrerAssetAjoute(scope, albumId, {
      immich_asset_id: res.id,
      kind: fichier.mimeType.startsWith('video/') ? 'video' : 'image',
      taken_at: fileCreatedAt,
      width: null,
      height: null,
      duration_ms: null,
    });
    ajoutees.push(enrichirPhoto(contexte, scope, albumId, enregistre));
  }

  return { photos: ajoutees };
}

export async function retirerPhotoAlbum(
  contexte: Contexte,
  scope: GroupScope,
  albumId: string,
  assetId: string,
): Promise<void> {
  const config = exigerConfigImmich(scope);
  const album = lireAlbum(scope, albumId);
  if (album === undefined) throw new ErreurHttp(404, 'album.introuvable');
  const asset = lireAssetAlbum(scope, albumId, assetId);
  if (asset === undefined) throw new ErreurHttp(404, 'photo.introuvable');

  if (asset.uploaded_by_membership_id !== scope.membershipId && scope.role !== 'admin') {
    throw new ErreurHttp(403, 'droit.photo_requis');
  }

  const apiKey = dechiffrerCle(contexte, config);
  const client = clientImmichDe(contexte);
  try {
    await client.retirerAssetAlbumImmich(config.base_url, apiKey, album.immich_album_id, assetId);
  } catch (erreur) {
    if (erreur instanceof ErreurClientImmich && erreur.code === 'non_autorise') {
      throw new ErreurHttp(502, 'immich.non_autorise');
    }
    throw new ErreurHttp(502, 'immich.injoignable');
  }

  retirerAssetAlbum(scope, albumId, assetId, versInstant(contexte.horloge()));
}

export async function servirMediaSigne(
  contexte: Contexte,
  portee: PorteeUtilisateur,
  params: { albumId: string; assetId: string; taille: string; exp: string; sig: string },
): Promise<MediaImmich> {
  const verif = verifierSignatureMedia(
    {
      albumId: params.albumId,
      assetId: params.assetId,
      taille: params.taille,
      userId: portee.userId,
      exp: params.exp,
      sig: params.sig,
      maintenant: contexte.horloge(),
    },
    contexte.env.ATTROUPE_SIGNED_URL_SECRET,
  );
  if (!verif.valide) {
    throw new ErreurHttp(403, verif.raison === 'expiree' ? 'media.expiree' : 'media.signature_invalide');
  }

  const resolu = resoudreMediaPourUtilisateur(contexte.base, portee, params.albumId, params.assetId);
  if (resolu === undefined) {
    throw new ErreurHttp(404, 'media.introuvable');
  }

  const apiKey = dechiffrerCle(contexte, resolu.config);
  const client = clientImmichDe(contexte);
  try {
    return await client.recupererMediaImmich(resolu.config.base_url, apiKey, params.assetId, verif.taille);
  } catch (erreur) {
    if (erreur instanceof ErreurClientImmich && erreur.code === 'non_autorise') {
      throw new ErreurHttp(502, 'immich.non_autorise');
    }
    throw new ErreurHttp(502, 'immich.injoignable');
  }
}
