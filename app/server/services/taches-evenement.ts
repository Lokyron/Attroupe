import { listerMembres } from '../db/queries/membres.js';
import {
  assigner as assignerEnBase,
  creerTache as creerTacheEnBase,
  lireTache,
  listerTaches as listerTachesEnBase,
  modifierTache as modifierTacheEnBase,
  supprimerTache as supprimerTacheEnBase,
  type ChampsNouvelleTache,
  type ModificationTache,
  type Tache,
} from '../db/queries/taches.js';
import type { GroupScope } from '../db/scope.js';
import { versInstant } from '../domain/instant.js';
import type { Contexte } from '../http/contexte.js';
import { ErreurHttp } from '../http/erreurs.js';
import { verifierEvenement } from './listes.js';

// Cas d'usage des tâches d'événement (lot 6). Même séparation que partout : une tâche (ou un événement, ou un membre) qui n'est pas de CE
// groupe n'existe pas → 404 ; un droit manquant (réassigner la tâche de quelqu'un d'autre) → 403 `droit.assignation_requise` ; l'ordre est
// toujours « trouver, puis autoriser ». Le service s'appelle `taches-evenement` : `services/taches.ts` est déjà le planificateur du processus.

/** La tâche telle que l'API la rend : l'assigné nommé. */
export interface TachePublique extends Tache {
  readonly assignee_name: string | null;
}

function publier(tache: Tache, noms: ReadonlyMap<string, string>): TachePublique {
  return { ...tache, assignee_name: tache.assignee_membership_id === null ? null : (noms.get(tache.assignee_membership_id) ?? '') };
}

function noms(scope: GroupScope): Map<string, string> {
  return new Map(listerMembres(scope).map((m) => [m.id, m.display_name]));
}

function trouver(scope: GroupScope, tacheId: string): Tache {
  const tache = lireTache(scope, tacheId);
  if (tache === undefined) throw new ErreurHttp(404, 'tache.introuvable');
  return tache;
}

export function listerTaches(scope: GroupScope, evenementId?: string): TachePublique[] {
  if (evenementId !== undefined) verifierEvenement(scope, evenementId);
  const nomsMembres = noms(scope);
  return listerTachesEnBase(scope, evenementId).map((t) => publier(t, nomsMembres));
}

export function lireUneTache(scope: GroupScope, tacheId: string): TachePublique {
  return publier(trouver(scope, tacheId), noms(scope));
}

function diffuser(contexte: Contexte, scope: GroupScope, verbe: string, tache: Pick<Tache, 'id' | 'event_id'>): void {
  contexte.diffuseur.diffuser(scope, { type: `tache.${verbe}`, ressource: 'tache', id: tache.id, parent_id: tache.event_id });
}

export function creerTache(contexte: Contexte, scope: GroupScope, champs: ChampsNouvelleTache): TachePublique {
  if (champs.event_id !== null) verifierEvenement(scope, champs.event_id);
  const tache = trouver(scope, creerTacheEnBase(scope, champs));
  diffuser(contexte, scope, 'creee', tache);
  return publier(tache, noms(scope));
}

export function modifierTache(contexte: Contexte, scope: GroupScope, tacheId: string, champs: ModificationTache): TachePublique {
  const avant = trouver(scope, tacheId);
  if (champs.event_id !== undefined && champs.event_id !== null) verifierEvenement(scope, champs.event_id);
  if (!modifierTacheEnBase(scope, avant.id, champs, versInstant(contexte.horloge()))) throw new ErreurHttp(404, 'tache.introuvable');
  const apres = trouver(scope, avant.id);
  diffuser(contexte, scope, 'modifiee', apres);
  // Une tâche déplacée d'un événement à un autre : l'ancien parent doit aussi recharger.
  if (avant.event_id !== apres.event_id) diffuser(contexte, scope, 'modifiee', avant);
  return publier(apres, noms(scope));
}

export function supprimerTache(contexte: Contexte, scope: GroupScope, tacheId: string): void {
  const tache = trouver(scope, tacheId);
  if (!supprimerTacheEnBase(scope, tache.id)) throw new ErreurHttp(404, 'tache.introuvable');
  diffuser(contexte, scope, 'supprimee', tache);
}

/** « Je m'en occupe » (mon appartenance), « désigner quelqu'un » (la sienne) ou libérer (`null`). Voir `peutReassigner` pour le droit. */
export function assignerTache(contexte: Contexte, scope: GroupScope, tacheId: string, cibleId: string | null): TachePublique {
  const resultat = assignerEnBase(scope, tacheId, cibleId);
  if (resultat.etat === 'introuvable') throw new ErreurHttp(404, 'tache.introuvable');
  if (resultat.etat === 'interdit') throw new ErreurHttp(403, 'droit.assignation_requise');
  if (resultat.etat === 'membre_introuvable') throw new ErreurHttp(404, 'membre.introuvable');
  if (resultat.etat === 'membre_inactif') throw new ErreurHttp(409, 'membre.inactif');
  if (resultat.etat === 'deja_assignee') {
    const nomsMembres = noms(scope);
    const par = resultat.par === null ? null : { membership_id: resultat.par, display_name: nomsMembres.get(resultat.par) ?? '' };
    throw new ErreurHttp(409, 'tache.deja_assignee', undefined, undefined, { assignee: par });
  }
  const tache = trouver(scope, tacheId);
  if (resultat.change) diffuser(contexte, scope, 'assignee', tache);
  return publier(tache, noms(scope));
}
