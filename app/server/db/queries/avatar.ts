import { z } from 'zod';
import { baseDe, type PorteeUtilisateur } from '../portee-utilisateur.js';
import { preparer } from '../sql.js';
import { mesGroupes } from './transverse.js';

export const MIMES_AVATAR = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type MimeAvatar = (typeof MIMES_AVATAR)[number];

/** Taille maximale d'un avatar : 1 Mo (1 048 576 octets). */
export const TAILLE_MAX_AVATAR = 1_048_576;

const ENTETE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type ResultatValidationAvatar = 'ok' | 'mime_invalide' | 'trop_volumineux' | 'contenu_invalide';

export interface AvatarUtilisateur {
  readonly mime: MimeAvatar;
  readonly data: Buffer;
  readonly updated_at: string;
}

/** Construit l'URL publique authentifiée d'un avatar utilisateur, ou `null` s'il n'en a pas. */
export function urlAvatar(userId: string, updatedAt: string | null): string | null {
  if (updatedAt === null) return null;
  return `/api/utilisateurs/${encodeURIComponent(userId)}/avatar?v=${encodeURIComponent(updatedAt)}`;
}

/** Vérifie le type MIME déclaré, la taille maximale et les magic bytes réels du buffer. */
export function validerAvatar(mime: string, data: Buffer): ResultatValidationAvatar {
  if (!MIMES_AVATAR.includes(mime as MimeAvatar)) return 'mime_invalide';
  if (data.length === 0) return 'contenu_invalide';
  if (data.length > TAILLE_MAX_AVATAR) return 'trop_volumineux';

  if (mime === 'image/jpeg') {
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff ? 'ok' : 'contenu_invalide';
  }
  if (mime === 'image/png') {
    return data.length >= 8 && data.subarray(0, 8).equals(ENTETE_PNG) ? 'ok' : 'contenu_invalide';
  }
  // image/webp : conteneur RIFF....WEBP
  return data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
    ? 'ok'
    : 'contenu_invalide';
}

/** Décode une chaîne base64 (sans préfixe data URL) en Buffer, ou `null` si invalide. */
export function decoderBase64Avatar(dataBase64: string): Buffer | null {
  const nettoye = dataBase64.replace(/\s+/g, '');
  if (nettoye.length === 0 || nettoye.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(nettoye)) return null;
  const buf = Buffer.from(nettoye, 'base64');
  return buf.length > 0 ? buf : null;
}

/** Enregistre la photo de profil de l'utilisateur connecté et retourne son URL versionnée. */
export function enregistrerAvatarUtilisateur(
  portee: PorteeUtilisateur,
  mime: MimeAvatar,
  data: Buffer,
  maintenant: string,
): string {
  const validation = validerAvatar(mime, data);
  if (validation !== 'ok') {
    throw new Error(`Avatar invalide : ${validation}`);
  }
  preparer(
    baseDe(portee),
    'UPDATE users SET avatar_mime = ?, avatar_data = ?, avatar_updated_at = ?, updated_at = ? WHERE id = ?',
  ).run(mime, data, maintenant, maintenant, portee.userId);
  return urlAvatar(portee.userId, maintenant) as string;
}

/** Supprime la photo de profil de l'utilisateur connecté. */
export function supprimerAvatarUtilisateur(portee: PorteeUtilisateur, maintenant: string): void {
  preparer(
    baseDe(portee),
    'UPDATE users SET avatar_mime = NULL, avatar_data = NULL, avatar_updated_at = NULL, updated_at = ? WHERE id = ?',
  ).run(maintenant, portee.userId);
}

const ligneAvatar = z.object({
  avatar_mime: z.enum(MIMES_AVATAR).nullable(),
  avatar_data: z.instanceof(Uint8Array).nullable(),
  avatar_updated_at: z.string().nullable(),
});

/**
 * Lit la photo de profil d'un compte actif, ou `null` s'il n'en a pas, s'il est désactivé, ou si
 * l'appelant n'a pas le droit de la voir : on ne l'autorise que pour sa propre photo ou celle d'un
 * compte qui partage avec lui un groupe où les deux appartenances sont actives (ADR-0006 : pas
 * d'annuaire, et le refus est indiscernable d'une absence, d'où un 404 côté route).
 */
export function lireAvatarUtilisateur(portee: PorteeUtilisateur, userId: string): AvatarUtilisateur | null {
  const base = baseDe(portee);
  // Le verrou SQL exige un filtre « group_id = ? » sur memberships et interdit « OR » : on parcourt donc
  // les groupes actifs de l'appelant et on cherche l'autre compte dans chacun.
  if (userId !== portee.userId) {
    const partage = mesGroupes(portee).some(
      (groupe) =>
        preparer(base, "SELECT 1 FROM memberships WHERE group_id = ? AND user_id = ? AND status = 'active'").get(groupe.group_id, userId) !==
        undefined,
    );
    if (!partage) return null;
  }
  const brut = preparer(
    base,
    'SELECT avatar_mime, avatar_data, avatar_updated_at FROM users WHERE id = ? AND disabled_at IS NULL AND anonymized_at IS NULL',
  ).get(userId);
  if (brut === undefined) return null;
  const ligne = ligneAvatar.parse(brut);
  if (ligne.avatar_mime === null || ligne.avatar_data === null || ligne.avatar_updated_at === null) {
    return null;
  }
  const data = Buffer.isBuffer(ligne.avatar_data) ? ligne.avatar_data : Buffer.from(ligne.avatar_data);
  return {
    mime: ligne.avatar_mime,
    data,
    updated_at: ligne.avatar_updated_at,
  };
}
