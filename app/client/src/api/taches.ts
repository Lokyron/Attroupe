import { appeler, champ, liste, texte, texteOuNul } from './client';

// Les formes de l'API des tâches d'événement (architecture §6), relues champ par champ à l'arrivée.

export type StatutTache = 'todo' | 'doing' | 'done' | 'dropped';

export interface Tache {
  id: string;
  title: string;
  event_id: string | null;
  status: StatutTache;
  assignee_membership_id: string | null;
  assignee_name: string | null;
}

function statut(valeur: unknown): StatutTache {
  if (valeur !== 'todo' && valeur !== 'doing' && valeur !== 'done' && valeur !== 'dropped') throw new Error('Statut de tâche inconnu.');
  return valeur;
}

function tache(x: unknown): Tache {
  return {
    id: texte(champ(x, 'id')),
    title: texte(champ(x, 'title')),
    event_id: texteOuNul(champ(x, 'event_id')),
    status: statut(champ(x, 'status')),
    assignee_membership_id: texteOuNul(champ(x, 'assignee_membership_id')),
    assignee_name: texteOuNul(champ(x, 'assignee_name')),
  };
}

const base = (groupId: string): string => `/api/groupes/${encodeURIComponent(groupId)}/taches`;
const uneTache = (groupId: string, id: string): string => `${base(groupId)}/${encodeURIComponent(id)}`;

export async function listerTaches(groupId: string, evenementId: string): Promise<Tache[]> {
  return liste(champ(await appeler('GET', `${base(groupId)}?event_id=${encodeURIComponent(evenementId)}`), 'taches')).map(tache);
}

export async function creerTache(groupId: string, title: string, evenementId: string): Promise<Tache> {
  return tache(await appeler('POST', base(groupId), { title, event_id: evenementId }));
}

export async function changerStatut(groupId: string, id: string, nouveau: StatutTache): Promise<Tache> {
  return tache(await appeler('PATCH', uneTache(groupId, id), { status: nouveau }));
}

export async function supprimerTache(groupId: string, id: string): Promise<void> {
  await appeler('DELETE', uneTache(groupId, id));
}

/** `membreId` : son appartenance (« je m'en occupe »), celle d'un autre membre actif (« désigner »), ou `null` (libérer). */
export async function assigner(groupId: string, id: string, membreId: string | null): Promise<Tache> {
  return tache(await appeler('PUT', `${uneTache(groupId, id)}/assignation`, { assignee_membership_id: membreId }));
}
