import type { PorteeUtilisateur } from '../db/portee-utilisateur.js';
import {
  creerCreneauPersonnel,
  definirPartagesCreneau,
  lireCreneauPersonnel,
  listerCreneauxPersonnels,
  listerDisponibilitesGroupe,
  modifierCreneauPersonnel,
  modifierMaVisibiliteDefaut,
  supprimerCreneauPersonnel,
  type ChampsCreneauPersonnel,
  type CreneauPersonnelAvecPartages,
  type DisponibiliteMembre,
  type ModificationCreneauPersonnel,
  type VisibilitePartage,
} from '../db/queries/agenda-personnel.js';
import type { GroupScope } from '../db/scope.js';
import { champsHoraireInvalides } from '../domain/evenements.js';
import { ErreurHttp } from '../http/erreurs.js';

// Cas d'usage de l'agenda personnel et du partage de disponibilités (lot 8, modèle §3.6, architecture §6 et §10).
// Cloisonnement strict :
//  - un créneau personnel appartient à un compte (`PorteeUtilisateur`) : l'identifiant d'un autre compte renvoie 404 `agenda.introuvable` ;
//  - partager vers un groupe où le compte n'est pas membre actif renvoie 404 `groupe.introuvable`, sans rien écrire ;
//  - les disponibilités lues dans un groupe (`GroupScope`) ne sélectionnent jamais les textes privés quand la visibilité est `'busy'`.

export type CreneauPersonnelPublic = Omit<CreneauPersonnelAvecPartages, 'all_day'> & { readonly all_day: boolean };

export type DisponibilitePublique =
  | (Omit<Extract<DisponibiliteMembre, { visibility: 'busy' }>, 'all_day'> & { readonly all_day: boolean })
  | (Omit<Extract<DisponibiliteMembre, { visibility: 'details' }>, 'all_day'> & { readonly all_day: boolean });

function publierCreneau(creneau: CreneauPersonnelAvecPartages): CreneauPersonnelPublic {
  return { ...creneau, all_day: creneau.all_day === 1 };
}

function publierDisponibilite(dispo: DisponibiliteMembre): DisponibilitePublique {
  return { ...dispo, all_day: dispo.all_day === 1 };
}

function trouverCreneau(portee: PorteeUtilisateur, creneauId: string): CreneauPersonnelAvecPartages {
  const creneau = lireCreneauPersonnel(portee, creneauId);
  if (creneau === undefined) throw new ErreurHttp(404, 'agenda.introuvable');
  return creneau;
}

export function listerMonAgenda(
  portee: PorteeUtilisateur,
  fenetre?: { readonly du?: string | undefined; readonly au?: string | undefined },
): CreneauPersonnelPublic[] {
  return listerCreneauxPersonnels(portee, fenetre).map(publierCreneau);
}

export function creerDansMonAgenda(
  portee: PorteeUtilisateur,
  champs: ChampsCreneauPersonnel,
): CreneauPersonnelPublic {
  return publierCreneau(creerCreneauPersonnel(portee, champs));
}

export function modifierDansMonAgenda(
  portee: PorteeUtilisateur,
  creneauId: string,
  champs: ModificationCreneauPersonnel,
): CreneauPersonnelPublic {
  const existant = trouverCreneau(portee, creneauId);
  if (existant.calendar_source_id !== null) throw new ErreurHttp(409, 'agenda.creneau_importe');
  const horaire = {
    all_day: champs.all_day ?? existant.all_day === 1,
    starts_at: champs.starts_at ?? existant.starts_at,
    ends_at: champs.ends_at === undefined ? existant.ends_at : champs.ends_at,
  };
  const invalides = champsHoraireInvalides(horaire);
  if (invalides.length > 0) throw new ErreurHttp(400, 'requete.invalide', undefined, invalides);
  if (!modifierCreneauPersonnel(portee, existant.id, champs)) throw new ErreurHttp(404, 'agenda.introuvable');
  return publierCreneau(trouverCreneau(portee, existant.id));
}

export function supprimerDeMonAgenda(portee: PorteeUtilisateur, creneauId: string): void {
  // Un créneau importé renaîtrait à la synchronisation suivante : on supprime la source, pas le créneau.
  if (trouverCreneau(portee, creneauId).calendar_source_id !== null) throw new ErreurHttp(409, 'agenda.creneau_importe');
  if (!supprimerCreneauPersonnel(portee, creneauId)) throw new ErreurHttp(404, 'agenda.introuvable');
}

export function definirPartagesDansMonAgenda(
  portee: PorteeUtilisateur,
  creneauId: string,
  partages: ReadonlyArray<{ readonly group_id: string; readonly visibility: VisibilitePartage }>,
): CreneauPersonnelPublic {
  // Un créneau importé n'a aucun détail à montrer : la base le refuse (déclencheur), on répond proprement avant plutôt qu'une SqliteError.
  if (trouverCreneau(portee, creneauId).calendar_source_id !== null && partages.some((p) => p.visibility === 'details')) {
    throw new ErreurHttp(409, 'agenda.import_sans_details');
  }
  const resultat = definirPartagesCreneau(portee, creneauId, partages);
  if (resultat === 'creneau_introuvable') throw new ErreurHttp(404, 'agenda.introuvable');
  if (resultat === 'groupe_introuvable') throw new ErreurHttp(404, 'groupe.introuvable');
  return publierCreneau(trouverCreneau(portee, creneauId));
}

export function changerMaVisibiliteDefaut(
  scope: GroupScope,
  visibility: VisibilitePartage,
): { readonly default_personal_visibility: VisibilitePartage } {
  modifierMaVisibiliteDefaut(scope, visibility);
  return { default_personal_visibility: visibility };
}

export function disponibilitesDuGroupe(
  scope: GroupScope,
  fenetre: { readonly du: string; readonly au?: string | undefined },
): DisponibilitePublique[] {
  return listerDisponibilitesGroupe(scope, fenetre).map(publierDisponibilite);
}
