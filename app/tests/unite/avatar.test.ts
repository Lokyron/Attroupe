import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decoderBase64Avatar,
  enregistrerAvatarUtilisateur,
  lireAvatarUtilisateur,
  supprimerAvatarUtilisateur,
  TAILLE_MAX_AVATAR,
  validerAvatar,
} from '../../server/db/queries/avatar.js';
import { lireProfil } from '../../server/db/queries/comptes.js';
import { listerMembres } from '../../server/db/queries/membres.js';
import { creerPorteeUtilisateur } from '../../server/db/portee-utilisateur.js';
import { creerScope } from '../../server/db/scope.js';
import { brut } from '../fixtures/brut.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';

const PNG_VALIDE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG_VALIDE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP_VALIDE = Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'latin1'), Buffer.from([0x56, 0x50, 0x38, 0x20])]);

describe('photo de profil utilisateur (unité)', () => {
  let t: BaseTemporaire;
  let d: DeuxGroupes;

  beforeEach(() => {
    t = baseTemporaire();
    d = deuxGroupes(t.base);
  });

  afterEach(() => {
    t.nettoyer();
  });

  it('valide les magic bytes JPEG, PNG et WEBP', () => {
    expect(validerAvatar('image/png', PNG_VALIDE)).toBe('ok');
    expect(validerAvatar('image/jpeg', JPEG_VALIDE)).toBe('ok');
    expect(validerAvatar('image/webp', WEBP_VALIDE)).toBe('ok');
  });

  it('rejette les faux fichiers, SVG, buffers vides et fichiers trop volumineux', () => {
    expect(validerAvatar('image/svg+xml', Buffer.from('<svg></svg>'))).toBe('mime_invalide');
    expect(validerAvatar('image/png', Buffer.from('<svg></svg>'))).toBe('contenu_invalide');
    expect(validerAvatar('image/png', JPEG_VALIDE)).toBe('contenu_invalide');
    expect(validerAvatar('image/jpeg', PNG_VALIDE)).toBe('contenu_invalide');
    expect(validerAvatar('image/webp', Buffer.from('RIFF0000XXXX'))).toBe('contenu_invalide');
    expect(validerAvatar('image/png', Buffer.alloc(0))).toBe('contenu_invalide');

    const tropGros = Buffer.concat([PNG_VALIDE, Buffer.alloc(TAILLE_MAX_AVATAR + 1 - PNG_VALIDE.length)]);
    expect(validerAvatar('image/png', tropGros)).toBe('trop_volumineux');
  });

  it('décode le base64 valide et rejette le base64 invalide', () => {
    const b64 = PNG_VALIDE.toString('base64');
    expect(decoderBase64Avatar(b64)?.equals(PNG_VALIDE)).toBe(true);
    expect(decoderBase64Avatar('pas!du!base64')).toBeNull();
    expect(decoderBase64Avatar('')).toBeNull();
  });

  it('enregistre, lit, expose avatar_url dans lireProfil et listerMembres, puis supprime', () => {
    const porteeAlice = creerPorteeUtilisateur(t.base, d.a.userId);
    const scopeA = creerScope(t.base, d.a.userId, d.a.groupId);

    expect(lireAvatarUtilisateur(porteeAlice, d.a.userId)).toBeNull();
    expect(lireProfil(porteeAlice).avatar_url).toBeNull();
    expect(listerMembres(scopeA).find((m) => m.id === d.a.membershipId)?.avatar_url).toBeNull();

    const maintenant = '2026-11-17T12:00:00Z';
    const url = enregistrerAvatarUtilisateur(porteeAlice, 'image/png', PNG_VALIDE, maintenant);
    expect(url).toBe(`/api/utilisateurs/${encodeURIComponent(d.a.userId)}/avatar?v=${encodeURIComponent(maintenant)}`);

    const lu = lireAvatarUtilisateur(porteeAlice, d.a.userId);
    expect(lu).not.toBeNull();
    expect(lu?.mime).toBe('image/png');
    expect(lu?.data.equals(PNG_VALIDE)).toBe(true);
    expect(lu?.updated_at).toBe(maintenant);

    expect(lireProfil(porteeAlice).avatar_url).toBe(url);
    expect(listerMembres(scopeA).find((m) => m.id === d.a.membershipId)?.avatar_url).toBe(url);

    supprimerAvatarUtilisateur(porteeAlice, '2026-11-17T12:05:00Z');
    expect(lireAvatarUtilisateur(porteeAlice, d.a.userId)).toBeNull();
    expect(lireProfil(porteeAlice).avatar_url).toBeNull();
  });

  it('ne livre l’avatar qu’à soi-même ou à un compte partageant un groupe actif', () => {
    const porteeAlice = creerPorteeUtilisateur(t.base, d.a.userId);
    const porteeBob = creerPorteeUtilisateur(t.base, d.b.userId);
    enregistrerAvatarUtilisateur(porteeAlice, 'image/png', PNG_VALIDE, '2026-11-17T12:00:00Z');
    enregistrerAvatarUtilisateur(porteeBob, 'image/png', PNG_VALIDE, '2026-11-17T12:00:00Z');

    // Soi-même : toujours.
    expect(lireAvatarUtilisateur(porteeAlice, d.a.userId)).not.toBeNull();
    // Aucun groupe commun : indiscernable d'une absence.
    expect(lireAvatarUtilisateur(porteeAlice, d.b.userId)).toBeNull();
    expect(lireAvatarUtilisateur(porteeBob, d.a.userId)).toBeNull();

    // Bob rejoint le groupe A : il voit désormais Alice.
    brut(t.base)
      .prepare(
        `INSERT INTO memberships (id, group_id, user_id, role, joined_at, created_at, updated_at) VALUES ('mBA', ?, ?, 'member', ?, ?, ?)`,
      )
      .run(d.a.groupId, d.b.userId, '2026-11-17T12:00:00Z', '2026-11-17T12:00:00Z', '2026-11-17T12:00:00Z');
    expect(lireAvatarUtilisateur(porteeBob, d.a.userId)).not.toBeNull();

    // Il quitte le groupe : l'accès tombe aussitôt.
    brut(t.base).prepare(`UPDATE memberships SET status = 'left', ended_at = ? WHERE id = 'mBA'`).run('2026-11-17T13:00:00Z');
    expect(lireAvatarUtilisateur(porteeBob, d.a.userId)).toBeNull();
  });
});
