import { z } from 'zod';
import type { GroupScope } from '../scope.js';
import { PAS_POSITION } from './listes.js';

// Tâches d'événement (lot 6, table `event_tasks`) : le « qui apporte quoi ». Toutes les fonctions prennent un `GroupScope`.
// L'invariant `(status = 'done') = (done_at IS NOT NULL)` est tenu ICI : `status` et `done_at` s'écrivent toujours ensemble.

export const STATUTS = ['todo', 'doing', 'done', 'dropped'] as const;
export type StatutTache = (typeof STATUTS)[number];

const ligneTache = z.object({
  id: z.string(),
  event_id: z.string().nullable(),
  title: z.string(),
  details: z.string().nullable(),
  assignee_membership_id: z.string().nullable(),
  due_at: z.string().nullable(),
  status: z.enum(STATUTS),
  done_at: z.string().nullable(),
  position: z.number().int(),
  created_by_membership_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Tache = z.infer<typeof ligneTache>;

/** Une tâche de CE groupe, ou `undefined` (404 `tache.introuvable` : la tâche d'un autre groupe est introuvable). */
export function lireTache(scope: GroupScope, tacheId: string): Tache | undefined {
  const ligne = scope.un<unknown>('event_tasks', tacheId);
  return ligne === undefined ? undefined : ligneTache.parse(ligne);
}

/** Les tâches du groupe dans l'ordre de la liste (position, puis identifiant) ; `eventId` restreint à celles d'un événement. */
export function listerTaches(scope: GroupScope, eventId?: string): Tache[] {
  const filtres = eventId === undefined ? [] : [{ colonne: 'event_id', operateur: '=' as const, valeur: eventId }];
  return scope.tous<unknown>('event_tasks', filtres, { ordre: [{ colonne: 'position' }, { colonne: 'id' }] }).map((ligne) => ligneTache.parse(ligne));
}

export interface ChampsNouvelleTache {
  readonly title: string;
  readonly details: string | null;
  readonly event_id: string | null;
  readonly due_at: string | null;
}

/** Crée en fin de liste, sans assignation, `status = 'todo'`. */
export function creerTache(scope: GroupScope, champs: ChampsNouvelleTache): string {
  return scope.transaction(() => {
    const derniere = listerTaches(scope).at(-1);
    return scope.inserer('event_tasks', {
      title: champs.title,
      details: champs.details,
      event_id: champs.event_id,
      due_at: champs.due_at,
      status: 'todo',
      position: derniere === undefined ? PAS_POSITION : derniere.position + PAS_POSITION,
    });
  });
}

export type ModificationTache = { readonly [K in 'title' | 'details' | 'event_id' | 'due_at' | 'status']?: (K extends 'status' ? StatutTache : string | null) | undefined };

/**
 * Modifie les champs fournis. Le passage à `done` pose `done_at` (et le garde si la tâche l'était déjà) ; toute autre valeur de `status`
 * l'efface : le CHECK du schéma n'a jamais à refuser.
 */
export function modifierTache(scope: GroupScope, tacheId: string, champs: ModificationTache, maintenant: string): boolean {
  return scope.transaction(() => {
    const actuelle = lireTache(scope, tacheId);
    if (actuelle === undefined) return false;
    const valeurs: Record<string, string | null> = {};
    for (const [cle, valeur] of Object.entries(champs)) if (valeur !== undefined) valeurs[cle] = valeur;
    if (champs.status !== undefined) valeurs['done_at'] = champs.status === 'done' ? (actuelle.status === 'done' ? actuelle.done_at : maintenant) : null;
    return scope.modifier('event_tasks', tacheId, valeurs);
  });
}

export function supprimerTache(scope: GroupScope, tacheId: string): boolean {
  return scope.supprimerDoux('event_tasks', tacheId);
}

export type ResultatAssignation =
  | { readonly etat: 'ok'; readonly change: boolean }
  | { readonly etat: 'introuvable' }
  | { readonly etat: 'membre_introuvable' }
  | { readonly etat: 'membre_inactif' }
  /** Le droit manque : la tâche est à quelqu'un d'autre. */
  | { readonly etat: 'interdit' }
  /** Perdu une course : la tâche a été assignée entre-temps. `par` est le nouvel assigné. */
  | { readonly etat: 'deja_assignee'; readonly par: string | null };

/**
 * Qui peut changer l'assignation d'une tâche qui n'est PAS libre (la spec ne tranche pas ; décision du lot 6) : l'assigné actuel (il passe
 * la main ou se désiste), l'auteur de la tâche, ou un administrateur du groupe. Une tâche libre : n'importe quel membre actif.
 * Un simple membre ne « vole » donc pas la tâche de quelqu'un d'autre : 403, jamais 404 (la tâche est bien dans son groupe).
 */
export function peutReassigner(scope: GroupScope, tache: Pick<Tache, 'assignee_membership_id' | 'created_by_membership_id'>): boolean {
  return (
    tache.assignee_membership_id === null ||
    tache.assignee_membership_id === scope.membershipId ||
    tache.created_by_membership_id === scope.membershipId ||
    scope.role === 'admin'
  );
}

/**
 * Assigne la tâche à `cibleId` (un membre ACTIF de CE groupe, y compris soi : « je m'en occupe »), ou la libère (`null`). L'ordre est
 * « trouver (404), autoriser (403), puis juger la cible (404 / 409) » comme partout. L'écriture est conditionnelle à l'assigné que l'on a
 * vu : si une autre écriture est passée entre-temps, elle échoue (`deja_assignee`) au lieu d'écraser.
 */
export function assigner(scope: GroupScope, tacheId: string, cibleId: string | null): ResultatAssignation {
  return scope.transaction(() => {
    const tache = lireTache(scope, tacheId);
    if (tache === undefined) return { etat: 'introuvable' } as const;
    if (tache.assignee_membership_id === cibleId) return { etat: 'ok', change: false } as const;
    if (!peutReassigner(scope, tache)) return { etat: 'interdit' } as const;
    if (cibleId !== null) {
      const cible = scope.un<{ status: string }>('memberships', cibleId);
      if (cible === undefined) return { etat: 'membre_introuvable' } as const;
      if (cible.status !== 'active') return { etat: 'membre_inactif' } as const;
    }
    const vu = tache.assignee_membership_id;
    const passe = scope.modifier('event_tasks', tache.id, { assignee_membership_id: cibleId }, [
      vu === null ? { colonne: 'assignee_membership_id', operateur: 'IS NULL' } : { colonne: 'assignee_membership_id', operateur: '=', valeur: vu },
    ]);
    if (passe) return { etat: 'ok', change: true } as const;
    const actuelle = lireTache(scope, tacheId);
    if (actuelle === undefined) return { etat: 'introuvable' } as const;
    return { etat: 'deja_assignee', par: actuelle.assignee_membership_id } as const;
  });
}
