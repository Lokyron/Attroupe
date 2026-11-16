import { ErreurHttp } from '../http/erreurs.js';
import type { Contexte } from '../http/contexte.js';
import {
  ajouterOrganisateur as ajouterOrganisateurEnBase,
  auteurDe,
  annulerEvenement as annulerEvenementEnBase,
  creerEvenement as creerEvenementEnBase,
  filDeEvenement,
  lireEvenement,
  lirePresences,
  listerEvenements as listerEvenementsEnBase,
  listerOrganisateurs,
  maPresence,
  modifierEvenement as modifierEvenementEnBase,
  peutModifierEvenement,
  repondre,
  retirerOrganisateur as retirerOrganisateurEnBase,
  verifierReferences,
  type ChampsEvenement,
  type Evenement,
  type ModificationEvenement,
  type Organisateur,
  type Presence,
  type Presences,
} from '../db/queries/evenements.js';
import type { GroupScope } from '../db/scope.js';
import { champsHoraireInvalides } from '../domain/evenements.js';
import { versInstant } from '../domain/instant.js';

// Cas d'usage de l'agenda du groupe (lot 4). Deux vérifications, jamais confondues (architecture §4) :
//  1. le cloisonnement : un événement qui n'est pas de CE groupe n'existe pas → 404 `evenement.introuvable` ;
//  2. le droit : un événement de mon groupe que je ne peux pas modifier → 403 `droit.organisateur_requis`.
// L'ordre est toujours : trouver (404), puis autoriser (403).

/** L'événement tel que l'API le rend : `all_day` booléen, aucune colonne réservée V2, aucune colonne de purge. */
export type EvenementPublic = Omit<Evenement, 'all_day'> & { readonly all_day: boolean };

export interface DetailEvenement extends EvenementPublic {
  readonly thread_id: string | null;
  /** Organisateur principal : l'auteur (il peut modifier sans être co-organisateur). */
  readonly auteur: Organisateur;
  readonly organisateurs: Organisateur[];
  readonly peut_modifier: boolean;
  readonly ma_presence: Presence | null;
}

function publier(evenement: Evenement): EvenementPublic {
  return { ...evenement, all_day: evenement.all_day === 1 };
}

function trouver(scope: GroupScope, evenementId: string): Evenement {
  const evenement = lireEvenement(scope, evenementId);
  if (evenement === undefined) throw new ErreurHttp(404, 'evenement.introuvable');
  return evenement;
}

function trouverModifiable(scope: GroupScope, evenementId: string): Evenement {
  const evenement = trouver(scope, evenementId);
  if (!peutModifierEvenement(scope, evenement)) throw new ErreurHttp(403, 'droit.organisateur_requis');
  return evenement;
}

function refuserReference(scope: GroupScope, champs: Parameters<typeof verifierReferences>[1]): void {
  const probleme = verifierReferences(scope, champs);
  if (probleme === 'hote_introuvable') throw new ErreurHttp(404, 'membre.introuvable');
  if (probleme === 'hote_inactif') throw new ErreurHttp(409, 'membre.inactif');
  if (probleme === 'devise_inconnue') throw new ErreurHttp(400, 'evenement.devise_inconnue');
}

export function listerEvenements(scope: GroupScope, fenetre: { du?: string | undefined; au?: string | undefined }): EvenementPublic[] {
  return listerEvenementsEnBase(scope, fenetre).map(publier);
}

export function detailEvenement(scope: GroupScope, evenementId: string): DetailEvenement {
  const evenement = trouver(scope, evenementId);
  return {
    ...publier(evenement),
    thread_id: filDeEvenement(scope, evenement.id) ?? null,
    auteur: auteurDe(scope, evenement),
    organisateurs: listerOrganisateurs(scope, evenement.id),
    peut_modifier: peutModifierEvenement(scope, evenement),
    ma_presence: maPresence(scope, evenement.id) ?? null,
  };
}

export function creerEvenement(scope: GroupScope, champs: ChampsEvenement): DetailEvenement {
  refuserReference(scope, champs);
  return detailEvenement(scope, creerEvenementEnBase(scope, champs).id);
}

export function modifierEvenement(scope: GroupScope, evenementId: string, champs: ModificationEvenement): DetailEvenement {
  const evenement = trouverModifiable(scope, evenementId);
  // L'horaire se juge sur l'événement fusionné : passer en « journée entière » sans nouvelle date est une erreur 400, pas un 500.
  const horaire = {
    all_day: champs.all_day ?? evenement.all_day === 1,
    starts_at: champs.starts_at ?? evenement.starts_at,
    ends_at: champs.ends_at === undefined ? evenement.ends_at : champs.ends_at,
  };
  const invalides = champsHoraireInvalides(horaire);
  if (invalides.length > 0) throw new ErreurHttp(400, 'requete.invalide', undefined, invalides);
  refuserReference(scope, champs);
  if (!modifierEvenementEnBase(scope, evenement.id, champs)) throw new ErreurHttp(404, 'evenement.introuvable');
  return detailEvenement(scope, evenement.id);
}

/** DELETE = annulation (`status = 'cancelled'`), idempotente. L'événement reste lisible. */
export function annulerEvenement(scope: GroupScope, evenementId: string): DetailEvenement {
  const evenement = trouverModifiable(scope, evenementId);
  if (evenement.status !== 'cancelled' && !annulerEvenementEnBase(scope, evenement.id)) throw new ErreurHttp(404, 'evenement.introuvable');
  return detailEvenement(scope, evenement.id);
}

/** MA réponse, jamais celle d'un autre. Un événement annulé n'en reçoit plus. `capacity` est informatif : il ne bloque rien. */
export function repondrePresence(
  contexte: Contexte,
  scope: GroupScope,
  evenementId: string,
  reponse: { status: 'yes' | 'maybe' | 'no'; guests_count: number; comment: string | null },
): DetailEvenement {
  const evenement = trouver(scope, evenementId);
  if (evenement.status === 'cancelled') throw new ErreurHttp(409, 'evenement.annule');
  repondre(scope, evenement.id, reponse, versInstant(contexte.horloge()));
  return detailEvenement(scope, evenement.id);
}

export function presencesEvenement(scope: GroupScope, evenementId: string): Presences {
  return lirePresences(scope, trouver(scope, evenementId).id);
}

export function ajouterOrganisateur(contexte: Contexte, scope: GroupScope, evenementId: string, membreId: string): DetailEvenement {
  const evenement = trouverModifiable(scope, evenementId);
  const resultat = ajouterOrganisateurEnBase(scope, evenement.id, membreId, versInstant(contexte.horloge()));
  if (resultat === 'membre_introuvable') throw new ErreurHttp(404, 'membre.introuvable');
  if (resultat === 'membre_inactif') throw new ErreurHttp(409, 'membre.inactif');
  return detailEvenement(scope, evenement.id);
}

export function retirerOrganisateur(scope: GroupScope, evenementId: string, membreId: string): DetailEvenement {
  const evenement = trouverModifiable(scope, evenementId);
  if (retirerOrganisateurEnBase(scope, evenement.id, membreId) === 'membre_introuvable') throw new ErreurHttp(404, 'membre.introuvable');
  return detailEvenement(scope, evenement.id);
}
