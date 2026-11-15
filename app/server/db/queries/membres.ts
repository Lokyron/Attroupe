import { z } from 'zod';
import { baseDeScope, type GroupScope } from '../scope.js';
import { preparer } from '../sql.js';

// Membres d'un groupe (lot 3). Une appartenance n'est JAMAIS supprimée (modèle §3.3, règle 6) : l'historique du
// groupe (dépenses, présences, messages) pend à cette ligne. Retirer ou partir, c'est passer `status` à `removed` /
// `left` et poser `ended_at` ; revenir, c'est réactiver la MÊME ligne (db/queries/invitations.ts), jamais en créer une seconde.
//
// Règle d'intégrité (ADR-0009) : un groupe a toujours au moins un administrateur ACTIF. Elle ne s'exprime pas en
// `CHECK`, elle est donc appliquée ici, dans la transaction même qui change le rôle ou le statut.

interface LigneAppartenance {
  readonly id: string;
  readonly role: 'admin' | 'member';
  readonly status: 'active' | 'removed' | 'left';
}

const ligneAppartenance = z.object({
  id: z.string(),
  role: z.enum(['admin', 'member']),
  status: z.enum(['active', 'removed', 'left']),
});

const ligneMembre = z.object({
  id: z.string(),
  role: z.enum(['admin', 'member']),
  status: z.enum(['active', 'removed', 'left']),
  nickname: z.string().nullable(),
  joined_at: z.string(),
  ended_at: z.string().nullable(),
  display_name: z.string(),
});

export type Membre = z.infer<typeof ligneMembre>;

/**
 * Membres actifs d'abord, puis anciens membres (retirés ou partis), du groupe du scope. Le nom affiché vient du
 * compte ; ni l'adresse e-mail ni le nom d'utilisateur ne sortent d'ici (la liste est destinée à tout le groupe).
 */
export function listerMembres(scope: GroupScope): Membre[] {
  return preparer(
    baseDeScope(scope),
    `SELECT m.id AS id, m.role AS role, m.status AS status, m.nickname AS nickname, m.joined_at AS joined_at,
       m.ended_at AS ended_at, u.display_name AS display_name
     FROM memberships AS m JOIN users AS u ON u.id = m.user_id
     WHERE m.group_id = ?
     ORDER BY CASE WHEN m.status = 'active' THEN 0 ELSE 1 END, u.display_name, m.id`,
  )
    .all(scope.groupId)
    .map((ligne) => ligneMembre.parse(ligne));
}

function administrateursActifs(scope: GroupScope): number {
  return scope.tous('memberships', [
    { colonne: 'role', operateur: '=', valeur: 'admin' },
    { colonne: 'status', operateur: '=', valeur: 'active' },
  ]).length;
}

/** Les invitations en attente émises par ce membre ne survivent pas à son départ : il ne peut plus faire entrer personne. */
function revoquerInvitationsEmises(scope: GroupScope, membreId: string, maintenant: string, role?: 'admin' | 'member'): void {
  const enAttente = scope.tous<{ id: string }>('invitations', [
    { colonne: 'invited_by_membership_id', operateur: '=', valeur: membreId },
    { colonne: 'status', operateur: '=', valeur: 'pending' },
    ...(role === undefined ? [] : [{ colonne: 'role', operateur: '=' as const, valeur: role }]),
  ]);
  for (const invitation of enAttente) {
    scope.modifier('invitations', invitation.id, { status: 'revoked', responded_at: maintenant });
  }
}

export type ResultatChangementRole = 'modifie' | 'introuvable' | 'inactif' | 'dernier_admin';

/**
 * Change le rôle d'un membre ACTIF du groupe. Rétrograder le dernier administrateur est refusé. Rétrograder un administrateur
 * révoque ses invitations en attente de rôle `admin` : sinon un complice les accepterait et deviendrait administrateur à sa place.
 */
export function changerRole(scope: GroupScope, membreId: string, role: 'admin' | 'member', maintenant: string): ResultatChangementRole {
  return scope.transaction(() => {
    const cible = lireAppartenance(scope, membreId);
    if (cible === undefined) return 'introuvable' as const;
    if (cible.status !== 'active') return 'inactif' as const;
    if (cible.role === role) return 'modifie' as const;
    if (cible.role === 'admin' && administrateursActifs(scope) <= 1) return 'dernier_admin' as const;
    scope.modifier('memberships', membreId, { role });
    if (cible.role === 'admin' && role === 'member') revoquerInvitationsEmises(scope, membreId, maintenant, 'admin');
    return 'modifie' as const;
  });
}

export type ResultatFinAppartenance = 'termine' | 'introuvable' | 'inactif' | 'dernier_admin' | 'soi_meme';

/** Un administrateur retire un AUTRE membre actif (`status = 'removed'`). Pour se retirer soi-même : `quitter`. */
export function retirerMembre(scope: GroupScope, membreId: string, maintenant: string): ResultatFinAppartenance {
  return scope.transaction(() => {
    const cible = lireAppartenance(scope, membreId);
    if (cible === undefined) return 'introuvable' as const;
    if (cible.id === scope.membershipId) return 'soi_meme' as const;
    if (cible.status !== 'active') return 'inactif' as const;
    if (cible.role === 'admin' && administrateursActifs(scope) <= 1) return 'dernier_admin' as const;
    terminer(scope, cible.id, 'removed', maintenant);
    return 'termine' as const;
  });
}

/** Départ volontaire (`status = 'left'`). Le dernier administrateur ne part pas : il désigne un successeur d'abord. */
export function quitter(scope: GroupScope, maintenant: string): ResultatFinAppartenance {
  return scope.transaction(() => {
    if (scope.role === 'admin' && administrateursActifs(scope) <= 1) return 'dernier_admin' as const;
    terminer(scope, scope.membershipId, 'left', maintenant);
    return 'termine' as const;
  });
}

function terminer(scope: GroupScope, membreId: string, statut: 'removed' | 'left', maintenant: string): void {
  scope.modifier('memberships', membreId, { status: statut, ended_at: maintenant });
  revoquerInvitationsEmises(scope, membreId, maintenant);
}

function lireAppartenance(scope: GroupScope, membreId: string): LigneAppartenance | undefined {
  const ligne = scope.un<unknown>('memberships', membreId);
  return ligne === undefined ? undefined : ligneAppartenance.parse(ligne);
}
