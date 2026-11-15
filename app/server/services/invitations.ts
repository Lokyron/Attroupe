import {
  accepterInvitationRecue,
  accepterParJeton as accepterParJetonEnBase,
  apercuParJeton as apercuParJetonEnBase,
  mesInvitations as mesInvitationsEnBase,
  refuserInvitationRecue,
  type ApercuInvitation,
  type InvitationRecue,
} from '../db/queries/invitations.js';
import { versInstant } from '../domain/instant.js';
import { empreinteJeton } from '../domain/jetons.js';
import type { Contexte } from '../http/contexte.js';
import { ErreurHttp } from '../http/erreurs.js';
import type { Authentification } from '../http/middleware/session.js';

// Invitations REÇUES (lot 3). Ici, aucune appartenance n'existe encore : tout passe par la `PorteeUtilisateur` du compte
// (invitation adressée à CE compte) ou par le secret d'un lien. Le cas d'usage traduit les issues de db/queries en erreurs HTTP.

export function mesInvitations(contexte: Contexte, auth: Authentification): InvitationRecue[] {
  return mesInvitationsEnBase(auth.portee, versInstant(contexte.horloge()));
}

export function accepter(contexte: Contexte, auth: Authentification, invitationId: string): void {
  const resultat = accepterInvitationRecue(auth.portee, invitationId, versInstant(contexte.horloge()));
  if (resultat === 'introuvable') throw new ErreurHttp(404, 'invitation.introuvable');
  if (resultat === 'deja_membre') throw new ErreurHttp(409, 'membre.deja');
  if (resultat === 'indisponible') throw new ErreurHttp(409, 'invitation.indisponible');
}

export function refuser(contexte: Contexte, auth: Authentification, invitationId: string): void {
  if (refuserInvitationRecue(auth.portee, invitationId, versInstant(contexte.horloge())) !== 'refusee') {
    throw new ErreurHttp(404, 'invitation.introuvable');
  }
}

/** Les liens d'invitation sont `410 Gone` quand ils ont servi ou sont morts : « ce lien a été révoqué » plutôt que « inconnu » (modèle §4.4). */
const CLE_ETAT: Readonly<Record<'revoquee' | 'expiree' | 'utilisee', string>> = {
  revoquee: 'invitation.revoquee',
  expiree: 'invitation.expiree',
  utilisee: 'invitation.deja_utilisee',
};

export function apercu(contexte: Contexte, jeton: string): ApercuInvitation {
  const apercu = apercuParJetonEnBase(contexte.base, empreinteJeton(jeton), versInstant(contexte.horloge()));
  if (apercu === undefined) throw new ErreurHttp(404, 'invitation.introuvable');
  if (apercu.etat !== 'en_attente') throw new ErreurHttp(410, CLE_ETAT[apercu.etat]);
  return apercu;
}

export function accepterParJeton(contexte: Contexte, auth: Authentification, jeton: string): void {
  const resultat = accepterParJetonEnBase(auth.portee, empreinteJeton(jeton), versInstant(contexte.horloge()));
  if (resultat === 'acceptee') return;
  if (resultat === 'introuvable') throw new ErreurHttp(404, 'invitation.introuvable');
  if (resultat === 'deja_membre') throw new ErreurHttp(409, 'membre.deja');
  if (resultat === 'adresse_non_verifiee') throw new ErreurHttp(403, 'invitation.adresse_non_verifiee');
  if (resultat === 'en_attente') throw new ErreurHttp(409, 'invitation.indisponible');
  throw new ErreurHttp(410, CLE_ETAT[resultat]);
}
