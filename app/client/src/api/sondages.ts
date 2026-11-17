import { appeler, booleen, champ, liste, nombre, texte, texteOuNul } from './client';
import type { DetailEvenement } from './evenements';

// Les formes de l'API des sondages de dates (lot 7), relues champ par champ à l'arrivée.

export type ValeurVote = 'yes' | 'maybe' | 'no';
export type StatutSondage = 'open' | 'closed' | 'converted' | 'cancelled';

export interface AuteurSondage {
  membership_id: string;
  display_name: string;
}

export interface VoteSondage {
  membership_id: string;
  display_name: string;
  value: ValeurVote;
}

export interface CompteursOption {
  yes: number;
  maybe: number;
  no: number;
  score: number;
}

export interface OptionSondage {
  id: string;
  date_poll_id: string;
  all_day: boolean;
  starts_at: string;
  ends_at: string | null;
  position: number;
  created_at: string;
  votes: VoteSondage[];
  mon_vote: ValeurVote | null;
  compteurs: CompteursOption;
}

export interface ResumeSondage {
  id: string;
  title: string;
  description: string | null;
  status: StatutSondage;
  closes_at: string | null;
  resulting_event_id: string | null;
  created_by_membership_id: string;
  created_at: string;
  updated_at: string;
  auteur: AuteurSondage;
  options_count: number;
}

export interface DetailSondage {
  id: string;
  title: string;
  description: string | null;
  status: StatutSondage;
  closes_at: string | null;
  resulting_event_id: string | null;
  created_by_membership_id: string;
  created_at: string;
  updated_at: string;
  auteur: AuteurSondage;
  options: OptionSondage[];
  option_gagnante_id: string | null;
}

export interface NouvelleOptionSondage {
  all_day: boolean;
  starts_at: string;
  ends_at: string | null;
}

function valeurVote(v: unknown): ValeurVote {
  if (v !== 'yes' && v !== 'maybe' && v !== 'no') throw new Error('Vote de sondage inconnu.');
  return v;
}

function statutSondage(s: unknown): StatutSondage {
  if (s !== 'open' && s !== 'closed' && s !== 'converted' && s !== 'cancelled') throw new Error('Statut de sondage inconnu.');
  return s;
}

function auteur(a: unknown): AuteurSondage {
  return {
    membership_id: texte(champ(a, 'membership_id')),
    display_name: texte(champ(a, 'display_name')),
  };
}

function option(o: unknown): OptionSondage {
  const monVoteBrut = champ(o, 'mon_vote');
  const c = champ(o, 'compteurs');
  return {
    id: texte(champ(o, 'id')),
    date_poll_id: texte(champ(o, 'date_poll_id')),
    all_day: booleen(champ(o, 'all_day')),
    starts_at: texte(champ(o, 'starts_at')),
    ends_at: texteOuNul(champ(o, 'ends_at')),
    position: nombre(champ(o, 'position')),
    created_at: texte(champ(o, 'created_at')),
    votes: liste(champ(o, 'votes')).map((v) => ({
      membership_id: texte(champ(v, 'membership_id')),
      display_name: texte(champ(v, 'display_name')),
      value: valeurVote(champ(v, 'value')),
    })),
    mon_vote: monVoteBrut === null ? null : valeurVote(monVoteBrut),
    compteurs: {
      yes: nombre(champ(c, 'yes')),
      maybe: nombre(champ(c, 'maybe')),
      no: nombre(champ(c, 'no')),
      score: nombre(champ(c, 'score')),
    },
  };
}

function resume(s: unknown): ResumeSondage {
  return {
    id: texte(champ(s, 'id')),
    title: texte(champ(s, 'title')),
    description: texteOuNul(champ(s, 'description')),
    status: statutSondage(champ(s, 'status')),
    closes_at: texteOuNul(champ(s, 'closes_at')),
    resulting_event_id: texteOuNul(champ(s, 'resulting_event_id')),
    created_by_membership_id: texte(champ(s, 'created_by_membership_id')),
    created_at: texte(champ(s, 'created_at')),
    updated_at: texte(champ(s, 'updated_at')),
    auteur: auteur(champ(s, 'auteur')),
    options_count: nombre(champ(s, 'options_count')),
  };
}

function detail(s: unknown): DetailSondage {
  return {
    id: texte(champ(s, 'id')),
    title: texte(champ(s, 'title')),
    description: texteOuNul(champ(s, 'description')),
    status: statutSondage(champ(s, 'status')),
    closes_at: texteOuNul(champ(s, 'closes_at')),
    resulting_event_id: texteOuNul(champ(s, 'resulting_event_id')),
    created_by_membership_id: texte(champ(s, 'created_by_membership_id')),
    created_at: texte(champ(s, 'created_at')),
    updated_at: texte(champ(s, 'updated_at')),
    auteur: auteur(champ(s, 'auteur')),
    options: liste(champ(s, 'options')).map(option),
    option_gagnante_id: texteOuNul(champ(s, 'option_gagnante_id')),
  };
}

const base = (groupId: string): string => `/api/groupes/${encodeURIComponent(groupId)}/sondages`;
const unSondage = (groupId: string, sondageId: string): string => `${base(groupId)}/${encodeURIComponent(sondageId)}`;
const uneOption = (groupId: string, sondageId: string, optionId: string): string =>
  `${unSondage(groupId, sondageId)}/options/${encodeURIComponent(optionId)}`;

export async function listerSondages(groupId: string): Promise<ResumeSondage[]> {
  return liste(champ(await appeler('GET', base(groupId)), 'sondages')).map(resume);
}

export async function lireSondage(groupId: string, sondageId: string): Promise<DetailSondage> {
  return detail(await appeler('GET', unSondage(groupId, sondageId)));
}

export async function creerSondage(
  groupId: string,
  champs: {
    title: string;
    description: string | null;
    closes_at: string | null;
    options: NouvelleOptionSondage[];
  },
): Promise<DetailSondage> {
  return detail(await appeler('POST', base(groupId), champs));
}

export async function modifierSondage(
  groupId: string,
  sondageId: string,
  champs: Partial<{ title: string; description: string | null; closes_at: string | null; status: 'open' | 'closed' }>,
): Promise<DetailSondage> {
  return detail(await appeler('PATCH', unSondage(groupId, sondageId), champs));
}

export async function annulerSondage(groupId: string, sondageId: string): Promise<DetailSondage> {
  return detail(await appeler('DELETE', unSondage(groupId, sondageId)));
}

export async function ajouterOptionSondage(groupId: string, sondageId: string, opt: NouvelleOptionSondage): Promise<DetailSondage> {
  return detail(await appeler('POST', `${unSondage(groupId, sondageId)}/options`, opt));
}

export async function retirerOptionSondage(groupId: string, sondageId: string, optionId: string): Promise<DetailSondage> {
  return detail(await appeler('DELETE', uneOption(groupId, sondageId, optionId)));
}

export async function voterOptionSondage(
  groupId: string,
  sondageId: string,
  optionId: string,
  value: ValeurVote,
): Promise<DetailSondage> {
  return detail(await appeler('PUT', `${uneOption(groupId, sondageId, optionId)}/mon-vote`, { value }));
}

export async function convertirSondage(
  groupId: string,
  sondageId: string,
  champs: { option_id?: string; time_zone?: string; location_name?: string | null; description?: string | null } = {},
): Promise<{ sondage: DetailSondage; evenementId: DetailEvenement['id'] }> {
  const r = await appeler('POST', `${unSondage(groupId, sondageId)}/conversion`, champs);
  return {
    sondage: detail(champ(r, 'sondage')),
    evenementId: texte(champ(champ(r, 'evenement'), 'id')),
  };
}
