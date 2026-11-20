import { appeler, booleen, champ, ErreurApi, liste, nombre, nombreOuNul, texte, texteOuNul } from './client';

export type StatutImmich = 'ok' | 'unreachable' | 'unauthorized' | 'untested';

export type EtatImmich =
  | { readonly configure: false }
  | {
      readonly configure: true;
      readonly base_url: string;
      readonly api_key_fingerprint: string;
      readonly status: StatutImmich;
      readonly last_checked_at: string | null;
      readonly last_error: string | null;
    };

export interface Album {
  readonly id: string;
  readonly event_id: string | null;
  readonly title: string;
  readonly immich_album_id: string;
  readonly cover_immich_asset_id: string | null;
  readonly cover_url: string | null;
  readonly asset_count: number;
  readonly last_synced_at: string | null;
  readonly sync_status: 'ok' | 'pending' | 'error' | 'orphan';
  readonly created_at: string;
}

export interface PhotoAlbum {
  readonly album_id: string;
  readonly immich_asset_id: string;
  readonly kind: 'image' | 'video';
  readonly taken_at: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly duration_ms: number | null;
  readonly uploaded_by_membership_id: string | null;
  readonly thumbnail_url: string;
  readonly preview_url: string;
  readonly original_url: string;
}

function parserStatutImmich(v: unknown): StatutImmich {
  if (v === 'ok' || v === 'unreachable' || v === 'unauthorized' || v === 'untested') return v;
  throw new Error('Statut Immich inconnu.');
}

function parserEtatImmich(r: unknown): EtatImmich {
  if (!booleen(champ(r, 'configure'))) return { configure: false };
  return {
    configure: true,
    base_url: texte(champ(r, 'base_url')),
    api_key_fingerprint: texte(champ(r, 'api_key_fingerprint')),
    status: parserStatutImmich(champ(r, 'status')),
    last_checked_at: texteOuNul(champ(r, 'last_checked_at')),
    last_error: texteOuNul(champ(r, 'last_error')),
  };
}

function parserAlbum(a: unknown): Album {
  const sync = champ(a, 'sync_status');
  if (sync !== 'ok' && sync !== 'pending' && sync !== 'error' && sync !== 'orphan') {
    throw new Error('Statut de synchronisation inconnu.');
  }
  return {
    id: texte(champ(a, 'id')),
    event_id: texteOuNul(champ(a, 'event_id')),
    title: texte(champ(a, 'title')),
    immich_album_id: texte(champ(a, 'immich_album_id')),
    cover_immich_asset_id: texteOuNul(champ(a, 'cover_immich_asset_id')),
    cover_url: texteOuNul(champ(a, 'cover_url')),
    asset_count: nombre(champ(a, 'asset_count')),
    last_synced_at: texteOuNul(champ(a, 'last_synced_at')),
    sync_status: sync,
    created_at: texte(champ(a, 'created_at')),
  };
}

function parserPhoto(p: unknown): PhotoAlbum {
  const kind = champ(p, 'kind');
  if (kind !== 'image' && kind !== 'video') throw new Error('Type de média inconnu.');
  return {
    album_id: texte(champ(p, 'album_id')),
    immich_asset_id: texte(champ(p, 'immich_asset_id')),
    kind,
    taken_at: texteOuNul(champ(p, 'taken_at')),
    width: nombreOuNul(champ(p, 'width')),
    height: nombreOuNul(champ(p, 'height')),
    duration_ms: nombreOuNul(champ(p, 'duration_ms')),
    uploaded_by_membership_id: texteOuNul(champ(p, 'uploaded_by_membership_id')),
    thumbnail_url: texte(champ(p, 'thumbnail_url')),
    preview_url: texte(champ(p, 'preview_url')),
    original_url: texte(champ(p, 'original_url')),
  };
}

export async function lireConfigImmich(groupId: string): Promise<EtatImmich> {
  return parserEtatImmich(await appeler('GET', `/api/groupes/${encodeURIComponent(groupId)}/immich`));
}

export async function configurerImmich(groupId: string, base_url: string, api_key: string): Promise<EtatImmich> {
  return parserEtatImmich(await appeler('PUT', `/api/groupes/${encodeURIComponent(groupId)}/immich`, { base_url, api_key }));
}

export async function supprimerConfigImmich(groupId: string): Promise<void> {
  await appeler('DELETE', `/api/groupes/${encodeURIComponent(groupId)}/immich`);
}

export async function testerConfigImmich(groupId: string): Promise<EtatImmich> {
  return parserEtatImmich(await appeler('POST', `/api/groupes/${encodeURIComponent(groupId)}/immich/test`, {}));
}

export async function listerAlbums(groupId: string): Promise<Album[]> {
  const r = await appeler('GET', `/api/groupes/${encodeURIComponent(groupId)}/albums`);
  return liste(champ(r, 'albums')).map(parserAlbum);
}

export async function creerAlbum(groupId: string, title: string, eventId?: string | null): Promise<Album> {
  const r = await appeler('POST', `/api/groupes/${encodeURIComponent(groupId)}/albums`, {
    title,
    ...(eventId !== undefined ? { event_id: eventId } : {}),
  });
  return parserAlbum(r);
}

export async function renommerAlbum(groupId: string, albumId: string, title: string): Promise<Album> {
  const r = await appeler('PATCH', `/api/groupes/${encodeURIComponent(groupId)}/albums/${encodeURIComponent(albumId)}`, { title });
  return parserAlbum(r);
}

export async function supprimerAlbum(groupId: string, albumId: string): Promise<void> {
  await appeler('DELETE', `/api/groupes/${encodeURIComponent(groupId)}/albums/${encodeURIComponent(albumId)}`);
}

export async function listerPhotosAlbum(groupId: string, albumId: string, sync = false): Promise<{ album: Album; photos: PhotoAlbum[] }> {
  const query = sync ? '?sync=true' : '';
  const r = await appeler('GET', `/api/groupes/${encodeURIComponent(groupId)}/albums/${encodeURIComponent(albumId)}/photos${query}`);
  return {
    album: parserAlbum(champ(r, 'album')),
    photos: liste(champ(r, 'photos')).map(parserPhoto),
  };
}

export async function televerserPhotosAlbum(groupId: string, albumId: string, fichiers: FileList | readonly File[], signal?: AbortSignal): Promise<PhotoAlbum[]> {
  const formData = new FormData();
  for (const fichier of Array.from(fichiers)) {
    formData.append('files', fichier, fichier.name);
  }
  const reponse = await fetch(`/api/groupes/${encodeURIComponent(groupId)}/albums/${encodeURIComponent(albumId)}/photos`, {
    method: 'POST',
    credentials: 'same-origin',
    body: formData,
    ...(signal !== undefined ? { signal } : {}),
  });
  const json: unknown = await reponse.json().catch(() => null);
  if (!reponse.ok) {
    const cle = typeof json === 'object' && json !== null && 'error' in json && typeof (json as Record<string, unknown>)['error'] === 'string'
      ? ((json as Record<string, unknown>)['error'] as string)
      : 'erreur.interne';
    throw new ErreurApi(reponse.status, cle, json);
  }
  return liste(champ(json, 'photos')).map(parserPhoto);
}

export async function retirerPhotoAlbum(groupId: string, albumId: string, assetId: string): Promise<void> {
  await appeler(
    'DELETE',
    `/api/groupes/${encodeURIComponent(groupId)}/albums/${encodeURIComponent(albumId)}/photos/${encodeURIComponent(assetId)}`,
  );
}
