import { appeler, booleen, champ, liste, nombre, nombreOuNul, texte, texteOuNul } from './client';

// Les formes de l'API de l'agenda (architecture §6), relues champ par champ à l'arrivée.

export type ReponsePresence = 'yes' | 'maybe' | 'no';

export interface Evenement {
  id: string;
  title: string;
  description: string | null;
  location_name: string | null;
  location_address: string | null;
  all_day: boolean;
  starts_at: string;
  ends_at: string | null;
  time_zone: string;
  arrival_note: string | null;
  host_membership_id: string | null;
  capacity: number | null;
  status: 'draft' | 'published' | 'cancelled';
  source_date_poll_id: string | null;
}

export interface MaPresence {
  status: ReponsePresence;
  guests_count: number;
  comment: string | null;
}

export interface Organisateur {
  membership_id: string;
  display_name: string;
}

export interface DetailEvenement extends Evenement {
  thread_id: string | null;
  auteur: Organisateur;
  organisateurs: Organisateur[];
  peut_modifier: boolean;
  ma_presence: MaPresence | null;
}

export interface ReponseMembre {
  membership_id: string;
  display_name: string;
  status: ReponsePresence;
  guests_count: number;
  comment: string | null;
}

export interface Presences {
  compteurs: { yes: number; maybe: number; no: number; attendus: number; sans_reponse: number };
  reponses: ReponseMembre[];
  sans_reponse: Array<{ membership_id: string; display_name: string }>;
}

/** Champs que le formulaire écrit (création) ; en modification, n'importe quel sous-ensemble. */
export interface ChampsEvenement {
  title: string;
  description: string | null;
  location_name: string | null;
  location_address: string | null;
  all_day: boolean;
  starts_at: string;
  ends_at: string | null;
  time_zone: string;
  arrival_note: string | null;
  capacity: number | null;
}

function reponsePresence(valeur: unknown): ReponsePresence {
  if (valeur !== 'yes' && valeur !== 'maybe' && valeur !== 'no') throw new Error('Réponse de présence inconnue.');
  return valeur;
}

function evenement(e: unknown): Evenement {
  const status = champ(e, 'status');
  if (status !== 'draft' && status !== 'published' && status !== 'cancelled') throw new Error("Statut d'événement inconnu.");
  return {
    id: texte(champ(e, 'id')),
    title: texte(champ(e, 'title')),
    description: texteOuNul(champ(e, 'description')),
    location_name: texteOuNul(champ(e, 'location_name')),
    location_address: texteOuNul(champ(e, 'location_address')),
    all_day: booleen(champ(e, 'all_day')),
    starts_at: texte(champ(e, 'starts_at')),
    ends_at: texteOuNul(champ(e, 'ends_at')),
    time_zone: texte(champ(e, 'time_zone')),
    arrival_note: texteOuNul(champ(e, 'arrival_note')),
    host_membership_id: texteOuNul(champ(e, 'host_membership_id')),
    capacity: nombreOuNul(champ(e, 'capacity')),
    status,
    source_date_poll_id: texteOuNul(champ(e, 'source_date_poll_id')),
  };
}

function maPresence(p: unknown): MaPresence | null {
  if (p === null) return null;
  return { status: reponsePresence(champ(p, 'status')), guests_count: nombre(champ(p, 'guests_count')), comment: texteOuNul(champ(p, 'comment')) };
}

function detail(e: unknown): DetailEvenement {
  return {
    ...evenement(e),
    thread_id: texteOuNul(champ(e, 'thread_id')),
    auteur: { membership_id: texte(champ(champ(e, 'auteur'), 'membership_id')), display_name: texte(champ(champ(e, 'auteur'), 'display_name')) },
    organisateurs: liste(champ(e, 'organisateurs')).map((o) => ({ membership_id: texte(champ(o, 'membership_id')), display_name: texte(champ(o, 'display_name')) })),
    peut_modifier: booleen(champ(e, 'peut_modifier')),
    ma_presence: maPresence(champ(e, 'ma_presence')),
  };
}

const base = (groupId: string): string => `/api/groupes/${encodeURIComponent(groupId)}/evenements`;
const unEvenement = (groupId: string, id: string): string => `${base(groupId)}/${encodeURIComponent(id)}`;

export async function listerEvenements(groupId: string, fenetre: { du: string; au?: string }): Promise<Evenement[]> {
  const requete = `?du=${encodeURIComponent(fenetre.du)}${fenetre.au === undefined ? '' : `&au=${encodeURIComponent(fenetre.au)}`}`;
  return liste(champ(await appeler('GET', `${base(groupId)}${requete}`), 'evenements')).map(evenement);
}

export async function lireEvenement(groupId: string, id: string): Promise<DetailEvenement> {
  return detail(await appeler('GET', unEvenement(groupId, id)));
}

export async function creerEvenement(groupId: string, champs: ChampsEvenement): Promise<DetailEvenement> {
  return detail(await appeler('POST', base(groupId), champs));
}

export async function modifierEvenement(groupId: string, id: string, champs: Partial<ChampsEvenement>): Promise<DetailEvenement> {
  return detail(await appeler('PATCH', unEvenement(groupId, id), champs));
}

export async function annulerEvenement(groupId: string, id: string): Promise<DetailEvenement> {
  return detail(await appeler('DELETE', unEvenement(groupId, id)));
}

export async function repondre(groupId: string, id: string, reponse: MaPresence): Promise<DetailEvenement> {
  return detail(await appeler('PUT', `${unEvenement(groupId, id)}/ma-presence`, reponse));
}

export async function lirePresences(groupId: string, id: string): Promise<Presences> {
  const r = await appeler('GET', `${unEvenement(groupId, id)}/presences`);
  const c = champ(r, 'compteurs');
  return {
    compteurs: {
      yes: nombre(champ(c, 'yes')),
      maybe: nombre(champ(c, 'maybe')),
      no: nombre(champ(c, 'no')),
      attendus: nombre(champ(c, 'attendus')),
      sans_reponse: nombre(champ(c, 'sans_reponse')),
    },
    reponses: liste(champ(r, 'reponses')).map((x) => ({
      membership_id: texte(champ(x, 'membership_id')),
      display_name: texte(champ(x, 'display_name')),
      status: reponsePresence(champ(x, 'status')),
      guests_count: nombre(champ(x, 'guests_count')),
      comment: texteOuNul(champ(x, 'comment')),
    })),
    sans_reponse: liste(champ(r, 'sans_reponse')).map((x) => ({ membership_id: texte(champ(x, 'membership_id')), display_name: texte(champ(x, 'display_name')) })),
  };
}

export async function ajouterOrganisateur(groupId: string, id: string, membreId: string): Promise<DetailEvenement> {
  return detail(await appeler('POST', `${unEvenement(groupId, id)}/organisateurs/${encodeURIComponent(membreId)}`, {}));
}

export async function retirerOrganisateur(groupId: string, id: string, membreId: string): Promise<DetailEvenement> {
  return detail(await appeler('DELETE', `${unEvenement(groupId, id)}/organisateurs/${encodeURIComponent(membreId)}`));
}
