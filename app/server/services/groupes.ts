import type { Authentification } from '../http/middleware/session.js';
import { ErreurHttp } from '../http/erreurs.js';
import type { Contexte } from '../http/contexte.js';
import { creerGroupe, lireGroupe, modifierGroupe as modifierGroupeEnBase, type Groupe } from '../db/queries/groupes.js';
import { inviterParEmail, inviterParNomUtilisateur, revoquerInvitation as revoquerInvitationEnBase } from '../db/queries/invitations.js';
import { changerRole as changerRoleEnBase, quitter as quitterEnBase, retirerMembre as retirerMembreEnBase } from '../db/queries/membres.js';
import { lireProfil } from '../db/queries/comptes.js';
import type { GroupScope } from '../db/scope.js';
import { plus, versInstant } from '../domain/instant.js';
import { DUREE_INVITATION_MS, emailInvitation } from './emails.js';

// Cas d'usage du groupe, des membres et des invitations émises (lot 3). Chaque fonction reçoit le `GroupScope` posé par
// `exigerAppartenance` : jamais d'identifiant de groupe en paramètre. Les droits (administrateur) sont posés sur les routes
// par `exigerAdminGroupe` ; les règles d'intégrité (ADR-0009) sont appliquées dans db/queries/membres.ts, dans la
// transaction même de l'écriture.

export interface DetailGroupe extends Groupe {
  readonly id: string;
  readonly mon_role: 'admin' | 'member';
  readonly mon_appartenance_id: string;
}

export function detailGroupe(scope: GroupScope): DetailGroupe {
  const groupe = lireGroupe(scope);
  // Le groupe a été vu par exigerAppartenance quelques instants plus tôt ; s'il disparaît entre-temps, il n'existe plus pour l'appelant.
  if (groupe === undefined) throw new ErreurHttp(404, 'groupe.introuvable');
  return { id: scope.groupId, ...groupe, mon_role: scope.role, mon_appartenance_id: scope.membershipId };
}

export function modifierGroupe(
  contexte: Contexte,
  scope: GroupScope,
  champs: { name?: string | undefined; default_currency_code?: string | undefined; time_zone?: string | undefined },
): DetailGroupe {
  const resultat = modifierGroupeEnBase(scope, champs, versInstant(contexte.horloge()));
  if (resultat === 'devise_inconnue') throw new ErreurHttp(400, 'groupe.devise_inconnue');
  if (resultat === 'introuvable') throw new ErreurHttp(404, 'groupe.introuvable');
  return detailGroupe(scope);
}

/** Crée un groupe dont l'appelant devient administrateur. Un compte peut en avoir plusieurs. */
export function creerNouveauGroupe(
  contexte: Contexte,
  auth: Authentification,
  corps: { name: string; default_currency_code: string; time_zone: string },
): { id: string; name: string; mon_role: 'admin' } {
  const resultat = creerGroupe(auth.portee, corps, versInstant(contexte.horloge()));
  if (resultat === 'devise_inconnue') throw new ErreurHttp(400, 'groupe.devise_inconnue');
  return { id: resultat.groupId, name: corps.name, mon_role: 'admin' };
}

export function changerRole(contexte: Contexte, scope: GroupScope, membreId: string, role: 'admin' | 'member'): void {
  const resultat = changerRoleEnBase(scope, membreId, role, versInstant(contexte.horloge()));
  if (resultat === 'introuvable') throw new ErreurHttp(404, 'membre.introuvable');
  if (resultat === 'inactif') throw new ErreurHttp(409, 'membre.inactif');
  if (resultat === 'dernier_admin') throw new ErreurHttp(409, 'groupe.dernier_admin');
}

export function retirerMembre(contexte: Contexte, scope: GroupScope, membreId: string): void {
  const resultat = retirerMembreEnBase(scope, membreId, versInstant(contexte.horloge()));
  if (resultat === 'introuvable') throw new ErreurHttp(404, 'membre.introuvable');
  if (resultat === 'soi_meme') throw new ErreurHttp(409, 'membre.retrait_de_soi');
  if (resultat === 'inactif') throw new ErreurHttp(409, 'membre.inactif');
  if (resultat === 'dernier_admin') throw new ErreurHttp(409, 'groupe.dernier_admin');
  // Fermeture ACTIVE de ses flux temps réel dans CE groupe. Le filet reste la revérification avant chaque envoi (services/temps-reel.ts).
  contexte.diffuseur.fermerMembre(scope, membreId);
}

export function quitter(contexte: Contexte, scope: GroupScope): void {
  const resultat = quitterEnBase(scope, versInstant(contexte.horloge()));
  if (resultat === 'dernier_admin') throw new ErreurHttp(409, 'groupe.dernier_admin');
  contexte.diffuseur.fermerMembre(scope, scope.membershipId);
}

export type CorpsInvitation =
  | { readonly email: string; readonly role: 'admin' | 'member'; readonly message: string | null }
  | { readonly username: string; readonly role: 'admin' | 'member'; readonly message: string | null };

/**
 * Émet une invitation. La réponse est la même que l'invitation ait été créée ou non (nom inconnu, déjà membre, déjà invité…) :
 * l'émission ne sert pas à sonder l'annuaire. L'administrateur voit le résultat dans la liste des invitations émises.
 */
export function inviter(contexte: Contexte, auth: Authentification, scope: GroupScope, corps: CorpsInvitation): void {
  const maintenant = contexte.horloge();
  const expireLe = versInstant(plus(maintenant, DUREE_INVITATION_MS));
  if ('email' in corps) {
    const groupe = detailGroupe(scope);
    const invitant = lireProfil(auth.portee).display_name;
    inviterParEmail(
      scope,
      {
        email: corps.email,
        role: corps.role,
        message: corps.message,
        expireLe,
        fabriquerEmail: (invitationId) =>
          emailInvitation({ to: corps.email, invitant, groupe: groupe.name, groupeId: scope.groupId, message: corps.message }, invitationId),
      },
      versInstant(maintenant),
    );
    return;
  }
  inviterParNomUtilisateur(scope, { username: corps.username, role: corps.role, message: corps.message, expireLe }, versInstant(maintenant));
}

export function revoquerInvitation(contexte: Contexte, scope: GroupScope, invitationId: string): void {
  const resultat = revoquerInvitationEnBase(scope, invitationId, versInstant(contexte.horloge()));
  if (resultat === 'introuvable') throw new ErreurHttp(404, 'invitation.introuvable');
  if (resultat === 'non_en_attente') throw new ErreurHttp(409, 'invitation.non_en_attente');
}
