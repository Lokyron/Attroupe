import { appeler, booleen, champ, liste, texte, texteOuNul } from './client';

// Les formes de l'API d'agenda personnel et de disponibilités (lot 8, architecture §6), relues champ par champ.

export type VisibilitePartage = 'none' | 'busy' | 'details';
export type VisibiliteActive = 'busy' | 'details';

export interface PartageCreneau {
  group_id: string;
  group_name: string;
  visibility: VisibiliteActive;
}

export interface CreneauPersonnel {
  id: string;
  title: string;
  description: string | null;
  location_name: string | null;
  all_day: boolean;
  starts_at: string;
  ends_at: string | null;
  time_zone: string;
  /** Non nul : créneau IMPORTÉ d'un agenda externe (ADR-0013). Lecture seule, et ses textes ne sortent
   *  jamais vers un groupe — ils sont chiffrés en base et ne sont déchiffrés que pour leur propriétaire. */
  calendar_source_id: string | null;
  partages: PartageCreneau[];
}

export interface ChampsCreneauPersonnel {
  title: string;
  description: string | null;
  location_name: string | null;
  all_day: boolean;
  starts_at: string;
  ends_at: string | null;
  time_zone: string;
}

export interface DisponibiliteMembre {
  id: string;
  membership_id: string;
  display_name: string;
  visibility: VisibiliteActive;
  all_day: boolean;
  starts_at: string;
  ends_at: string | null;
  time_zone: string;
  title: string | null;
  description: string | null;
  location_name: string | null;
}

export function visibilitePartage(valeur: unknown): VisibilitePartage {
  if (valeur !== 'none' && valeur !== 'busy' && valeur !== 'details') throw new Error('Visibilité de partage inconnue.');
  return valeur;
}

function visibiliteActive(valeur: unknown): VisibiliteActive {
  if (valeur !== 'busy' && valeur !== 'details') throw new Error('Visibilité active inconnue.');
  return valeur;
}

function partageCreneau(p: unknown): PartageCreneau {
  return {
    group_id: texte(champ(p, 'group_id')),
    group_name: texte(champ(p, 'group_name')),
    visibility: visibiliteActive(champ(p, 'visibility')),
  };
}

function creneauPersonnel(c: unknown): CreneauPersonnel {
  return {
    id: texte(champ(c, 'id')),
    title: texte(champ(c, 'title')),
    description: texteOuNul(champ(c, 'description')),
    location_name: texteOuNul(champ(c, 'location_name')),
    all_day: booleen(champ(c, 'all_day')),
    starts_at: texte(champ(c, 'starts_at')),
    ends_at: texteOuNul(champ(c, 'ends_at')),
    time_zone: texte(champ(c, 'time_zone')),
    calendar_source_id: texteOuNul(champ(c, 'calendar_source_id')),
    partages: liste(champ(c, 'partages')).map(partageCreneau),
  };
}

function disponibiliteMembre(d: unknown): DisponibiliteMembre {
  return {
    id: texte(champ(d, 'id')),
    membership_id: texte(champ(d, 'membership_id')),
    display_name: texte(champ(d, 'display_name')),
    visibility: visibiliteActive(champ(d, 'visibility')),
    all_day: booleen(champ(d, 'all_day')),
    starts_at: texte(champ(d, 'starts_at')),
    ends_at: texteOuNul(champ(d, 'ends_at')),
    time_zone: texte(champ(d, 'time_zone')),
    title: texteOuNul(champ(d, 'title')),
    description: texteOuNul(champ(d, 'description')),
    location_name: texteOuNul(champ(d, 'location_name')),
  };
}

export async function listerMonAgenda(fenetre?: { du?: string; au?: string }): Promise<CreneauPersonnel[]> {
  const params = new URLSearchParams();
  if (fenetre?.du !== undefined) params.set('du', fenetre.du);
  if (fenetre?.au !== undefined) params.set('au', fenetre.au);
  const qs = params.toString();
  const r = await appeler('GET', `/api/moi/agenda${qs === '' ? '' : `?${qs}`}`);
  return liste(champ(r, 'creneaux')).map(creneauPersonnel);
}

export async function creerCreneauPersonnel(champs: ChampsCreneauPersonnel): Promise<CreneauPersonnel> {
  return creneauPersonnel(await appeler('POST', '/api/moi/agenda', champs));
}

export async function modifierCreneauPersonnel(id: string, champs: Partial<ChampsCreneauPersonnel>): Promise<CreneauPersonnel> {
  return creneauPersonnel(await appeler('PATCH', `/api/moi/agenda/${encodeURIComponent(id)}`, champs));
}

export async function supprimerCreneauPersonnel(id: string): Promise<void> {
  await appeler('DELETE', `/api/moi/agenda/${encodeURIComponent(id)}`);
}

export async function definirPartagesCreneau(
  id: string,
  partages: ReadonlyArray<{ group_id: string; visibility: VisibilitePartage }>,
): Promise<CreneauPersonnel> {
  return creneauPersonnel(await appeler('PUT', `/api/moi/agenda/${encodeURIComponent(id)}/partages`, { partages }));
}

export async function changerMaVisibiliteDefaut(groupId: string, visibility: VisibilitePartage): Promise<VisibilitePartage> {
  const r = await appeler('PUT', `/api/groupes/${encodeURIComponent(groupId)}/ma-visibilite`, { visibility });
  return visibilitePartage(champ(r, 'default_personal_visibility'));
}

export async function listerDisponibilitesGroupe(
  groupId: string,
  fenetre: { du: string; au?: string },
): Promise<DisponibiliteMembre[]> {
  const requete = `?du=${encodeURIComponent(fenetre.du)}${fenetre.au === undefined ? '' : `&au=${encodeURIComponent(fenetre.au)}`}`;
  const r = await appeler('GET', `/api/groupes/${encodeURIComponent(groupId)}/disponibilites${requete}`);
  return liste(champ(r, 'disponibilites')).map(disponibiliteMembre);
}
