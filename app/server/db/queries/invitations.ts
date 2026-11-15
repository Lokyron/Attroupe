import { z } from 'zod';
import { egalTempsConstant } from '../../domain/jetons.js';
import type { Base } from '../base.js';
import { nouvelIdentifiant } from '../identifiant.js';
import { baseDe, type PorteeUtilisateur } from '../portee-utilisateur.js';
import { baseDeScope, type GroupScope } from '../scope.js';
import { executerEnTransaction, preparer } from '../sql.js';
import { enfilerEmail, type EmailAEnfiler } from './transverse.js';

// Invitations ÉMISES par un groupe (lot 3). Toutes prennent un `GroupScope` : l'invitation appartient au groupe du scope, une
// invitation d'un autre groupe n'existe pas pour l'appelant (404, jamais 403).
//
// Deux voies, une seule règle : AUCUNE adhésion d'office. Inviter crée une ligne `pending` ; seul l'invité l'accepte.
//  - par e-mail : le jeton d'acceptation vit dans l'e-mail seul. Comme pour la vérification d'adresse (lot 2), la file ne porte
//    que l'identifiant de la ligne ; le jeton est tiré à l'ENVOI (`armerInvitationEnvoi`), la base n'en garde que l'empreinte.
//    La ligne naît « inerte » (`token_hash` NULL) : rien ne peut l'accepter par lien avant que l'e-mail soit parti ;
//  - par nom d'utilisateur EXACT : pas de recherche, pas de liste, pas de complétion. Le résultat ne dit pas si le nom existe
//    (`ignoree` couvre aussi « déjà membre » et « déjà invité ») : l'émission n'est pas un oracle d'annuaire.

export type ResultatEmission = 'emise' | 'ignoree';

const ligneIdentifiant = z.object({ id: z.string() });

/** Les invitations dont l'échéance est passée quittent l'état `pending` : l'index unique « une invitation en attente par cible » ne doit pas les retenir. */
function expirerPerimees(scope: GroupScope, maintenant: string): void {
  const perimees = scope.tous<{ id: string }>('invitations', [
    { colonne: 'status', operateur: '=', valeur: 'pending' },
    { colonne: 'expires_at', operateur: '<=', valeur: maintenant },
  ]);
  for (const invitation of perimees) scope.modifier('invitations', invitation.id, { status: 'expired', responded_at: maintenant });
}

export interface EmissionParEmail {
  readonly email: string;
  readonly role: 'admin' | 'member';
  readonly message: string | null;
  readonly expireLe: string;
  /** E-mail à mettre en file ; ne reçoit que l'identifiant de la ligne d'invitation (jamais de jeton). */
  readonly fabriquerEmail: (invitationId: string) => EmailAEnfiler;
}

/** Invite une adresse e-mail. Une invitation déjà en attente pour cette adresse dans ce groupe n'en crée pas de seconde (pas de harcèlement). */
export function inviterParEmail(scope: GroupScope, emission: EmissionParEmail, maintenant: string): ResultatEmission {
  const base = baseDeScope(scope);
  return scope.transaction(() => {
    expirerPerimees(scope, maintenant);
    const existante = preparer(base, "SELECT id FROM invitations WHERE group_id = ? AND status = 'pending' AND lower(email) = lower(?)").get(
      scope.groupId,
      emission.email,
    );
    if (existante !== undefined) return 'ignoree' as const;
    const id = scope.inserer('invitations', {
      kind: 'email',
      email: emission.email,
      role: emission.role,
      message: emission.message,
      expires_at: emission.expireLe,
    });
    enfilerEmail(base, emission.fabriquerEmail(id), maintenant);
    return 'emise' as const;
  });
}

export interface EmissionParNomUtilisateur {
  readonly username: string;
  readonly role: 'admin' | 'member';
  readonly message: string | null;
  readonly expireLe: string;
}

/**
 * Invite le compte dont le nom d'utilisateur est EXACTEMENT celui-ci (insensible à la casse, comme l'unicité du nom).
 * Crée une invitation à ACCEPTER ; jamais une appartenance. Nom inconnu, compte désactivé, déjà membre, déjà invité : `ignoree`.
 */
export function inviterParNomUtilisateur(scope: GroupScope, emission: EmissionParNomUtilisateur, maintenant: string): ResultatEmission {
  const base = baseDeScope(scope);
  return scope.transaction(() => {
    const cible = preparer(
      base,
      'SELECT id FROM users WHERE lower(username) = lower(?) AND disabled_at IS NULL AND anonymized_at IS NULL',
    ).get(emission.username);
    if (cible === undefined) return 'ignoree' as const;
    const cibleId = ligneIdentifiant.parse(cible).id;
    expirerPerimees(scope, maintenant);
    const dejaMembre = scope.tous('memberships', [
      { colonne: 'user_id', operateur: '=', valeur: cibleId },
      { colonne: 'status', operateur: '=', valeur: 'active' },
    ]);
    if (dejaMembre.length > 0) return 'ignoree' as const;
    const dejaInvite = scope.tous('invitations', [
      { colonne: 'target_user_id', operateur: '=', valeur: cibleId },
      { colonne: 'status', operateur: '=', valeur: 'pending' },
    ]);
    if (dejaInvite.length > 0) return 'ignoree' as const;
    scope.inserer('invitations', {
      kind: 'existing_user',
      target_user_id: cibleId,
      role: emission.role,
      message: emission.message,
      expires_at: emission.expireLe,
    });
    return 'emise' as const;
  });
}

const ligneEmise = z.object({
  id: z.string(),
  kind: z.enum(['email', 'existing_user']),
  email: z.string().nullable(),
  username: z.string().nullable(),
  role: z.enum(['admin', 'member']),
  status: z.enum(['pending', 'accepted', 'declined', 'revoked', 'expired']),
  message: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
  responded_at: z.string().nullable(),
  invited_by_name: z.string(),
});

export type InvitationEmise = z.infer<typeof ligneEmise>;

const MAX_EMISES = 200;

/** Les invitations de CE groupe, les plus récentes d'abord. Le jeton (même haché) n'en sort jamais. */
export function listerInvitationsEmises(scope: GroupScope, maintenant: string): InvitationEmise[] {
  return preparer(
    baseDeScope(scope),
    `SELECT i.id AS id, i.kind AS kind, i.email AS email, u.username AS username, i.role AS role, i.status AS status,
       i.message AS message, i.created_at AS created_at, i.expires_at AS expires_at, i.responded_at AS responded_at,
       inviteur.display_name AS invited_by_name
     FROM invitations AS i
     JOIN memberships AS m ON m.id = i.invited_by_membership_id AND m.group_id = i.group_id
     JOIN users AS inviteur ON inviteur.id = m.user_id
     LEFT JOIN users AS u ON u.id = i.target_user_id
     WHERE i.group_id = ?
     ORDER BY i.created_at DESC, i.id
     LIMIT ${String(MAX_EMISES)}`,
  )
    .all(scope.groupId)
    .map((ligne) => ligneEmise.parse(ligne))
    // Une invitation en attente dont l'échéance est passée s'affiche expirée, sans attendre la prochaine émission qui l'écrira.
    .map((i) => (i.status === 'pending' && i.expires_at <= maintenant ? { ...i, status: 'expired' as const } : i));
}

export type ResultatRevocation = 'revoquee' | 'introuvable' | 'non_en_attente';

/** Révoque une invitation de CE groupe. Une invitation d'un autre groupe est introuvable, comme une invitation inconnue. */
export function revoquerInvitation(scope: GroupScope, invitationId: string, maintenant: string): ResultatRevocation {
  return scope.transaction(() => {
    const invitation = scope.un<{ status: string }>('invitations', invitationId);
    if (invitation === undefined) return 'introuvable' as const;
    if (invitation.status !== 'pending') return 'non_en_attente' as const;
    scope.modifier('invitations', invitationId, { status: 'revoked', responded_at: maintenant });
    return 'revoquee' as const;
  });
}

/**
 * À l'envoi de l'e-mail : donne son jeton à l'invitation (empreinte + échéance qui part de MAINTENANT). Faux — et l'e-mail ne
 * doit pas partir — si l'invitation n'est plus en attente (révoquée, acceptée, expirée) ou si la demande est trop ancienne.
 * Appelée par le service d'envoi avec les identifiants relus de la file (jamais d'une requête HTTP) : comme `armerJetonEnvoi`
 * (lot 2), elle prend la base ; le filtre de groupe est lié, avec le groupe que l'e-mail porte.
 */
export function armerInvitationEnvoi(
  base: Base,
  invitationId: string,
  groupId: string,
  empreinte: string,
  expireLe: string,
  creeApres: string,
): boolean {
  return (
    preparer(
      base,
      `UPDATE invitations SET token_hash = ?, expires_at = ?
       WHERE id = ? AND group_id = ? AND kind = 'email' AND status = 'pending' AND created_at > ?`,
    ).run(empreinte, expireLe, invitationId, groupId, creeApres).changes === 1
  );
}

// --- Invitations REÇUES -------------------------------------------------------------------------------------------------
// Le destinataire n'est pas (encore) membre : il n'a aucun GroupScope. Une invitation est par nature une ressource
// inter-groupes ; la garde du SQL brut (db/sql.ts, exceptions n° 2 et 3) admet donc deux preuves d'accès à la place de
// `group_id` : `target_user_id = ?` (invitation adressée à CE compte) et `token_hash = ?` (le secret du lien).
//
// Toute fonction d'ici relit l'invitation avec l'une de ces preuves AU MOMENT d'agir : elle ne reçoit jamais d'invitation
// déjà lue, ni de groupe en paramètre. Le `group_id` qui sert aux écritures vient de la ligne ainsi prouvée.
//
// Seules les invitations `existing_user` s'affichent dans « mes invitations » : une invitation par e-mail n'a d'autre
// preuve d'accès que son lien (la rattacher à un compte par son adresse exigerait un filtre sur l'adresse, que la garde
// n'admet pas — et qui est justement la fuite à éviter). Le lien exige en plus une adresse VÉRIFIÉE et identique.

export interface InvitationRecue {
  readonly id: string;
  readonly group_name: string;
  readonly invited_by_name: string;
  readonly role: 'admin' | 'member';
  readonly message: string | null;
  readonly created_at: string;
  readonly expires_at: string;
}

const ligneRecue = z.object({
  id: z.string(),
  id_groupe: z.string(),
  role: z.enum(['admin', 'member']),
  message: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
  invited_by_name: z.string(),
});

const SELECT_RECUE = `SELECT i.id AS id, i.group_id AS id_groupe, i.role AS role, i.message AS message, i.created_at AS created_at,
       i.expires_at AS expires_at, u.display_name AS invited_by_name
     FROM invitations AS i
     JOIN memberships AS m ON m.id = i.invited_by_membership_id AND m.group_id = i.group_id
     JOIN users AS u ON u.id = m.user_id`;

/** Nom d'un groupe NON supprimé, par l'identifiant lu sur une invitation prouvée. `undefined` : groupe supprimé. */
function nomDuGroupe(base: Base, groupId: string): string | undefined {
  const ligne = preparer(base, 'SELECT g.name AS name FROM groups AS g WHERE g.id = ? AND g.deleted_at IS NULL').get(groupId);
  return ligne === undefined ? undefined : z.object({ name: z.string() }).parse(ligne).name;
}

/** Mes invitations en attente et non échues (adressées à CE compte par son nom d'utilisateur), les plus récentes d'abord. */
export function mesInvitations(portee: PorteeUtilisateur, maintenant: string): InvitationRecue[] {
  const base = baseDe(portee);
  const lignes = preparer(
    base,
    `${SELECT_RECUE}
     WHERE i.target_user_id = ? AND i.status = 'pending' AND i.expires_at > ?
     ORDER BY i.created_at DESC, i.id`,
  )
    .all(portee.userId, maintenant)
    .map((l) => ligneRecue.parse(l));
  const recues: InvitationRecue[] = [];
  for (const { id_groupe, ...reste } of lignes) {
    const nom = nomDuGroupe(base, id_groupe);
    if (nom !== undefined) recues.push({ ...reste, group_name: nom });
  }
  return recues;
}

export type ResultatReponse = 'acceptee' | 'refusee' | 'introuvable' | 'deja_membre' | 'indisponible';

interface InvitationProuvee {
  readonly id: string;
  readonly id_groupe: string;
  readonly role: 'admin' | 'member';
  readonly status: string;
  readonly expires_at: string;
}

const ligneProuvee = z.object({
  id: z.string(),
  id_groupe: z.string(),
  role: z.enum(['admin', 'member']),
  status: z.string(),
  expires_at: z.string(),
});

/**
 * Crée l'appartenance (ou réactive la MÊME ligne d'un ancien membre : `UNIQUE (group_id, user_id)`, jamais de doublon, l'historique
 * retrouve son auteur) et marque l'invitation acceptée, dans la transaction de l'appelant.
 */
function entrer(base: Base, portee: PorteeUtilisateur, invitation: InvitationProuvee, maintenant: string): 'acceptee' | 'deja_membre' | 'indisponible' {
  if (nomDuGroupe(base, invitation.id_groupe) === undefined) return 'indisponible';
  const existante = preparer(base, 'SELECT id, status FROM memberships WHERE group_id = ? AND user_id = ?').get(invitation.id_groupe, portee.userId);
  let membershipId: string;
  if (existante === undefined) {
    membershipId = nouvelIdentifiant();
    preparer(
      base,
      `INSERT INTO memberships (id, group_id, user_id, role, status, joined_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(membershipId, invitation.id_groupe, portee.userId, invitation.role, maintenant, maintenant, maintenant);
  } else {
    const ligne = z.object({ id: z.string(), status: z.string() }).parse(existante);
    if (ligne.status === 'active') return 'deja_membre';
    membershipId = ligne.id;
    preparer(
      base,
      `UPDATE memberships SET status = 'active', ended_at = NULL, role = ?, joined_at = ?, updated_at = ?
       WHERE id = ? AND group_id = ? AND user_id = ?`,
    ).run(invitation.role, maintenant, maintenant, membershipId, invitation.id_groupe, portee.userId);
  }
  const marquee = preparer(
    base,
    `UPDATE invitations SET status = 'accepted', responded_at = ?, resulting_membership_id = ?
     WHERE id = ? AND group_id = ? AND status = 'pending'`,
  ).run(maintenant, membershipId, invitation.id, invitation.id_groupe);
  // Prise par une réponse simultanée entre la lecture et l'écriture : la transaction de l'appelant est annulée.
  if (marquee.changes !== 1) throw new ErreurReponseConcurrente();
  return 'acceptee';
}

class ErreurReponseConcurrente extends Error {}

/** Accepte une invitation ADRESSÉE À CE COMPTE. Une invitation d'un autre compte est introuvable (404), comme une invitation inconnue. */
export function accepterInvitationRecue(portee: PorteeUtilisateur, invitationId: string, maintenant: string): ResultatReponse {
  const base = baseDe(portee);
  try {
    return executerEnTransaction(base, () => {
      const ligne = preparer(
        base,
        `SELECT i.id AS id, i.group_id AS id_groupe, i.role AS role, i.status AS status, i.expires_at AS expires_at
         FROM invitations AS i WHERE i.target_user_id = ? AND i.id = ?`,
      ).get(portee.userId, invitationId);
      if (ligne === undefined) return 'introuvable' as const;
      const invitation = ligneProuvee.parse(ligne);
      if (invitation.status !== 'pending' || invitation.expires_at <= maintenant) return 'introuvable' as const;
      return entrer(base, portee, invitation, maintenant);
    });
  } catch (erreur) {
    if (erreur instanceof ErreurReponseConcurrente) return 'indisponible';
    throw erreur;
  }
}

/** Refuse une invitation ADRESSÉE À CE COMPTE. */
export function refuserInvitationRecue(portee: PorteeUtilisateur, invitationId: string, maintenant: string): ResultatReponse {
  const refusee = preparer(
    baseDe(portee),
    `UPDATE invitations SET status = 'declined', responded_at = ?
     WHERE id = ? AND target_user_id = ? AND status = 'pending' AND expires_at > ?`,
  ).run(maintenant, invitationId, portee.userId, maintenant);
  return refusee.changes === 1 ? 'refusee' : 'introuvable';
}

// --- Par lien (jeton) ---------------------------------------------------------------------------------------------------

export type EtatLien = 'en_attente' | 'revoquee' | 'expiree' | 'utilisee';

export interface ApercuInvitation {
  readonly etat: EtatLien;
  readonly group_name: string;
  readonly invited_by_name: string;
  readonly role: 'admin' | 'member';
  readonly expires_at: string;
}

const ligneLien = ligneProuvee.extend({ token_hash: z.string(), invited_by_name: z.string(), email: z.string().nullable() });

type LienLu = z.infer<typeof ligneLien> & { readonly group_name: string };

function lireParJeton(base: Base, empreinte: string): LienLu | undefined {
  const ligne = preparer(
    base,
    `SELECT i.id AS id, i.group_id AS id_groupe, i.role AS role, i.status AS status, i.expires_at AS expires_at,
       i.token_hash AS token_hash, i.email AS email, u.display_name AS invited_by_name
     FROM invitations AS i
     JOIN memberships AS m ON m.id = i.invited_by_membership_id AND m.group_id = i.group_id
     JOIN users AS u ON u.id = m.user_id
     WHERE i.token_hash = ?`,
  ).get(empreinte);
  if (ligne === undefined) return undefined;
  const lue = ligneLien.parse(ligne);
  if (!egalTempsConstant(lue.token_hash, empreinte)) return undefined;
  const nom = nomDuGroupe(base, lue.id_groupe);
  return nom === undefined ? undefined : { ...lue, group_name: nom };
}

function etatDuLien(lue: LienLu, maintenant: string): EtatLien {
  if (lue.status === 'revoked') return 'revoquee';
  if (lue.status === 'accepted' || lue.status === 'declined') return 'utilisee';
  if (lue.status === 'expired' || lue.expires_at <= maintenant) return 'expiree';
  return 'en_attente';
}

/** Aperçu d'une invitation par son lien (sans session) : nom du groupe, qui invite. `undefined` : lien inconnu. */
export function apercuParJeton(base: Base, empreinte: string, maintenant: string): ApercuInvitation | undefined {
  const lue = lireParJeton(base, empreinte);
  if (lue === undefined) return undefined;
  return { etat: etatDuLien(lue, maintenant), group_name: lue.group_name, invited_by_name: lue.invited_by_name, role: lue.role, expires_at: lue.expires_at };
}

export type ResultatLien = 'acceptee' | 'deja_membre' | 'introuvable' | 'adresse_non_verifiee' | EtatLien;

/**
 * Accepte une invitation par son lien. Le lien seul ne suffit pas : le compte doit avoir une adresse VÉRIFIÉE (`email_verified_at`
 * non nul, sinon quelqu'un qui inscrit l'adresse d'un autre avant lui récupérerait ses invitations) ET identique à celle invitée.
 * Une adresse différente répond `introuvable` : le lien n'est pas pour ce compte, rien de plus.
 */
export function accepterParJeton(portee: PorteeUtilisateur, empreinte: string, maintenant: string): ResultatLien {
  const base = baseDe(portee);
  try {
    return executerEnTransaction(base, () => {
      const lue = lireParJeton(base, empreinte);
      if (lue === undefined || lue.email === null) return 'introuvable' as const;
      const compte = z
        .object({ email: z.string(), email_verified_at: z.string().nullable() })
        .parse(preparer(base, 'SELECT email, email_verified_at FROM users WHERE id = ?').get(portee.userId));
      if (compte.email.toLowerCase() !== lue.email.toLowerCase()) return 'introuvable' as const;
      if (compte.email_verified_at === null) return 'adresse_non_verifiee' as const;
      const etat = etatDuLien(lue, maintenant);
      if (etat !== 'en_attente') return etat;
      const resultat = entrer(base, portee, lue, maintenant);
      return resultat === 'indisponible' ? ('introuvable' as const) : resultat;
    });
  } catch (erreur) {
    if (erreur instanceof ErreurReponseConcurrente) return 'utilisee';
    throw erreur;
  }
}
