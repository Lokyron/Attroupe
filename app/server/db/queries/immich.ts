import { z } from 'zod';
import type { Base } from '../base.js';
import type { PorteeUtilisateur } from '../portee-utilisateur.js';
import { baseDeScope, creerScope, ErreurAppartenance, type GroupScope } from '../scope.js';
import { preparer } from '../sql.js';
import { mesGroupes } from './transverse.js';
import type { AssetImmich } from '../../services/immich-client.js';

// Configuration Immich, albums et médias d'un groupe (modèle §3.11).
// Tout passe par `GroupScope` (ou par `mesGroupes(portee)` + `creerScope` pour le relai `/media`).

const ligneConfigImmich = z.object({
  group_id: z.string(),
  base_url: z.string(),
  api_key_cipher: z.instanceof(Buffer),
  api_key_nonce: z.instanceof(Buffer),
  api_key_fingerprint: z.string(),
  immich_user_id: z.string().nullable(),
  status: z.enum(['ok', 'unreachable', 'unauthorized', 'untested']),
  last_checked_at: z.string().nullable(),
  last_error: z.string().nullable(),
  configured_by_membership_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ConfigImmich = z.infer<typeof ligneConfigImmich>;

const ligneAlbum = z.object({
  id: z.string(),
  group_id: z.string(),
  event_id: z.string().nullable(),
  title: z.string(),
  immich_album_id: z.string(),
  cover_immich_asset_id: z.string().nullable(),
  asset_count: z.number(),
  last_synced_at: z.string().nullable(),
  sync_status: z.enum(['ok', 'pending', 'error', 'orphan']),
  created_by_membership_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Album = z.infer<typeof ligneAlbum>;

const ligneAssetAlbum = z.object({
  album_id: z.string(),
  group_id: z.string(),
  immich_asset_id: z.string(),
  kind: z.enum(['image', 'video']),
  taken_at: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  duration_ms: z.number().nullable(),
  uploaded_by_membership_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  removed_at: z.string().nullable(),
});

export type AssetAlbum = z.infer<typeof ligneAssetAlbum>;

export function lireConfigImmich(scope: GroupScope): ConfigImmich | undefined {
  const brut = scope.tous<Record<string, unknown>>('group_immich_configs')[0];
  if (brut === undefined) return undefined;
  return ligneConfigImmich.parse(brut);
}

export function enregistrerConfigImmich(
  scope: GroupScope,
  entree: {
    base_url: string;
    api_key_cipher: Buffer;
    api_key_nonce: Buffer;
    api_key_fingerprint: string;
    immich_user_id: string | null;
    status: 'ok' | 'unreachable' | 'unauthorized' | 'untested';
    last_checked_at: string | null;
    last_error: string | null;
  },
): ConfigImmich {
  scope.upsert('group_immich_configs', entree);
  const enregistree = lireConfigImmich(scope);
  if (enregistree === undefined) throw new Error('Configuration Immich introuvable après enregistrement.');
  return enregistree;
}

export function mettreAJourStatutImmich(
  scope: GroupScope,
  maj: {
    status: 'ok' | 'unreachable' | 'unauthorized' | 'untested';
    last_checked_at: string;
    last_error: string | null;
    immich_user_id?: string | null;
  },
): ConfigImmich | undefined {
  const modifie = scope.modifierPar('group_immich_configs', {}, {
    status: maj.status,
    last_checked_at: maj.last_checked_at,
    last_error: maj.last_error,
    ...(maj.immich_user_id !== undefined ? { immich_user_id: maj.immich_user_id } : {}),
  });
  if (!modifie) return undefined;
  return lireConfigImmich(scope);
}

export function supprimerConfigImmich(scope: GroupScope): boolean {
  const res = preparer(baseDeScope(scope), 'DELETE FROM group_immich_configs WHERE group_id = ?').run(scope.groupId);
  return res.changes > 0;
}

export function listerAlbums(scope: GroupScope): Album[] {
  return scope
    .tous<Record<string, unknown>>('albums', [], {
      ordre: [
        { colonne: 'created_at', sens: 'DESC' },
        { colonne: 'id', sens: 'DESC' },
      ],
    })
    .map((ligne) => ligneAlbum.parse(ligne));
}

export function lireAlbum(scope: GroupScope, albumId: string): Album | undefined {
  const brut = scope.un<Record<string, unknown>>('albums', albumId);
  if (brut === undefined) return undefined;
  return ligneAlbum.parse(brut);
}

export function lireAlbumParEvenement(scope: GroupScope, eventId: string): Album | undefined {
  const brut = scope.tous<Record<string, unknown>>('albums', [{ colonne: 'event_id', operateur: '=', valeur: eventId }])[0];
  if (brut === undefined) return undefined;
  return ligneAlbum.parse(brut);
}

export function creerAlbum(
  scope: GroupScope,
  entree: {
    title: string;
    event_id: string | null;
    immich_album_id: string;
  },
): Album {
  const id = scope.inserer('albums', {
    title: entree.title,
    event_id: entree.event_id,
    immich_album_id: entree.immich_album_id,
    cover_immich_asset_id: null,
    asset_count: 0,
    last_synced_at: null,
    sync_status: 'pending',
  });
  const cree = lireAlbum(scope, id);
  if (cree === undefined) throw new Error('Album introuvable après insertion.');
  return cree;
}

export function modifierAlbum(
  scope: GroupScope,
  albumId: string,
  champs: {
    title?: string | undefined;
    cover_immich_asset_id?: string | null | undefined;
    sync_status?: 'ok' | 'pending' | 'error' | 'orphan' | undefined;
    last_synced_at?: string | null | undefined;
  },
): Album | undefined {
  const valeurs: Record<string, string | null> = {};
  if (champs.title !== undefined) valeurs['title'] = champs.title;
  if (champs.cover_immich_asset_id !== undefined) valeurs['cover_immich_asset_id'] = champs.cover_immich_asset_id;
  if (champs.sync_status !== undefined) valeurs['sync_status'] = champs.sync_status;
  if (champs.last_synced_at !== undefined) valeurs['last_synced_at'] = champs.last_synced_at;
  if (Object.keys(valeurs).length === 0) return lireAlbum(scope, albumId);
  const ok = scope.modifier('albums', albumId, valeurs);
  if (!ok) return undefined;
  return lireAlbum(scope, albumId);
}

export function supprimerAlbum(scope: GroupScope, albumId: string): boolean {
  return scope.supprimerDoux('albums', albumId);
}

export function listerAssetsAlbum(scope: GroupScope, albumId: string): AssetAlbum[] {
  return scope
    .tous<Record<string, unknown>>(
      'album_assets',
      [
        { colonne: 'album_id', operateur: '=', valeur: albumId },
        { colonne: 'removed_at', operateur: 'IS NULL' },
      ],
      {
        ordre: [
          { colonne: 'taken_at', sens: 'DESC' },
          { colonne: 'created_at', sens: 'DESC' },
        ],
      },
    )
    .map((ligne) => ligneAssetAlbum.parse(ligne));
}

export function lireAssetAlbum(scope: GroupScope, albumId: string, immichAssetId: string): AssetAlbum | undefined {
  const brut = scope.tous<Record<string, unknown>>('album_assets', [
    { colonne: 'album_id', operateur: '=', valeur: albumId },
    { colonne: 'immich_asset_id', operateur: '=', valeur: immichAssetId },
    { colonne: 'removed_at', operateur: 'IS NULL' },
  ])[0];
  if (brut === undefined) return undefined;
  return ligneAssetAlbum.parse(brut);
}

function parserDureeMs(duree: string | null): number | null {
  if (duree === null) return null;
  const match = duree.trim().match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!match) return null;
  const heures = Number(match[1]);
  const minutes = Number(match[2]);
  const secondes = Number(match[3]);
  const frac = match[4] ? Number(`0.${match[4]}`) : 0;
  return Math.round((heures * 3600 + minutes * 60 + secondes + frac) * 1000);
}

export function synchroniserAssetsAlbum(
  scope: GroupScope,
  albumId: string,
  assetsImmich: readonly AssetImmich[],
  maintenant: string,
): AssetAlbum[] {
  return scope.transaction(() => {
    const existants = scope
      .tous<Record<string, unknown>>('album_assets', [{ colonne: 'album_id', operateur: '=', valeur: albumId }])
      .map((l) => ligneAssetAlbum.parse(l));
    const parId = new Map(existants.map((e) => [e.immich_asset_id, e]));
    const presentsIds = new Set(assetsImmich.map((a) => a.id));

    for (const asset of assetsImmich) {
      const valeursCommunes = {
        kind: asset.type === 'VIDEO' ? 'video' : 'image',
        taken_at: asset.exifInfo?.dateTimeOriginal ?? asset.fileCreatedAt ?? null,
        width: asset.exifInfo?.exifImageWidth ?? null,
        height: asset.exifInfo?.exifImageHeight ?? null,
        duration_ms: parserDureeMs(asset.duration),
        removed_at: null,
      } as const;

      if (parId.has(asset.id)) {
        scope.modifierPar('album_assets', { album_id: albumId, immich_asset_id: asset.id }, valeursCommunes);
      } else {
        scope.upsert('album_assets', {
          album_id: albumId,
          immich_asset_id: asset.id,
          ...valeursCommunes,
          uploaded_by_membership_id: null,
        });
      }
    }

    for (const existant of existants) {
      if (!presentsIds.has(existant.immich_asset_id) && existant.removed_at === null) {
        scope.modifierPar('album_assets', { album_id: albumId, immich_asset_id: existant.immich_asset_id }, { removed_at: maintenant });
      }
    }

    const couvertureActuelle = lireAlbum(scope, albumId)?.cover_immich_asset_id ?? null;
    const couvertureValide = couvertureActuelle !== null && presentsIds.has(couvertureActuelle)
      ? couvertureActuelle
      : (assetsImmich[0]?.id ?? null);

    scope.modifier('albums', albumId, {
      asset_count: assetsImmich.length,
      last_synced_at: maintenant,
      sync_status: 'ok',
      cover_immich_asset_id: couvertureValide,
    });

    return listerAssetsAlbum(scope, albumId);
  });
}

export function enregistrerAssetAjoute(
  scope: GroupScope,
  albumId: string,
  entree: {
    immich_asset_id: string;
    kind: 'image' | 'video';
    taken_at: string | null;
    width: number | null;
    height: number | null;
    duration_ms: number | null;
  },
): AssetAlbum {
  return scope.transaction(() => {
    scope.upsert('album_assets', {
      album_id: albumId,
      immich_asset_id: entree.immich_asset_id,
      kind: entree.kind,
      taken_at: entree.taken_at,
      width: entree.width,
      height: entree.height,
      duration_ms: entree.duration_ms,
      uploaded_by_membership_id: scope.membershipId,
      removed_at: null,
    });
    const actifs = listerAssetsAlbum(scope, albumId);
    const album = lireAlbum(scope, albumId);
    scope.modifier('albums', albumId, {
      asset_count: actifs.length,
      ...(album?.cover_immich_asset_id == null ? { cover_immich_asset_id: entree.immich_asset_id } : {}),
    });
    const enregistre = lireAssetAlbum(scope, albumId, entree.immich_asset_id);
    if (enregistre === undefined) throw new Error('Asset introuvable après insertion.');
    return enregistre;
  });
}

export function retirerAssetAlbum(
  scope: GroupScope,
  albumId: string,
  immichAssetId: string,
  maintenant: string,
): boolean {
  return scope.transaction(() => {
    const ok = scope.modifierPar('album_assets', { album_id: albumId, immich_asset_id: immichAssetId }, { removed_at: maintenant });
    if (!ok) return false;
    const actifs = listerAssetsAlbum(scope, albumId);
    const album = lireAlbum(scope, albumId);
    scope.modifier('albums', albumId, {
      asset_count: actifs.length,
      ...(album?.cover_immich_asset_id === immichAssetId
        ? { cover_immich_asset_id: actifs[0]?.immich_asset_id ?? null }
        : {}),
    });
    return true;
  });
}

/**
 * Résout un média pour la route `/media/:albumId/:assetId/:taille` sans contourner le GroupScope :
 * parcourt uniquement les groupes où l'utilisateur est membre actif, ouvre leur `GroupScope`,
 * et renvoie la configuration Immich, l'album et l'asset si tout est actif et présent.
 */
export function resoudreMediaPourUtilisateur(
  base: Base,
  portee: PorteeUtilisateur,
  albumId: string,
  immichAssetId: string,
): { config: ConfigImmich; album: Album; asset: AssetAlbum } | undefined {
  const groupes = mesGroupes(portee);
  for (const g of groupes) {
    let scope: GroupScope;
    try {
      scope = creerScope(base, portee.userId, g.group_id);
    } catch (erreur) {
      if (erreur instanceof ErreurAppartenance) continue;
      throw erreur;
    }
    if (scope.groupe() === undefined) continue;
    const config = lireConfigImmich(scope);
    if (config === undefined) continue;
    const album = lireAlbum(scope, albumId);
    if (album === undefined) continue;
    const asset = lireAssetAlbum(scope, albumId, immichAssetId);
    if (asset === undefined) continue;
    return { config, album, asset };
  }
  return undefined;
}
