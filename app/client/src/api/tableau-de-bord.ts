import { appeler, booleen, champ, liste, nombre, role, texte, texteOuNul } from './client';
import type { Role } from './groupes';

export type StatutPresenceTableau = 'yes' | 'maybe' | 'no' | null;

export interface GroupeTableauDeBord {
  readonly group_id: string;
  readonly name: string;
  readonly role: Role;
  readonly photos_actives: boolean;
}

export interface EvenementTableauDeBord {
  readonly id: string;
  readonly group_id: string;
  readonly group_name: string;
  readonly title: string;
  readonly starts_at: string;
  readonly ends_at: string | null;
  readonly all_day: boolean;
  readonly time_zone: string;
  readonly location_name: string | null;
  readonly mon_statut: StatutPresenceTableau;
}

export interface EvenementPersoTableauDeBord {
  readonly id: string;
  readonly title: string;
  readonly starts_at: string;
  readonly ends_at: string | null;
  readonly all_day: boolean;
  readonly time_zone: string;
  readonly location_name: string | null;
}

export interface DepenseTableauDeBord {
  readonly id: string;
  readonly group_id: string;
  readonly group_name: string;
  readonly label: string;
  readonly amount_minor: number;
  readonly currency_code: string;
  readonly payer_name: string;
  readonly spent_on: string;
}

export interface SoldeTableauDeBord {
  readonly group_id: string;
  readonly group_name: string;
  readonly currency_code: string;
  readonly net_minor: number;
}

export interface PhotoTableauDeBord {
  readonly group_id: string;
  readonly group_name: string;
  readonly album_id: string;
  readonly album_title: string;
  readonly immich_asset_id: string;
  readonly thumbnail_url: string;
}

export interface DonneesTableauDeBord {
  readonly groupes: readonly GroupeTableauDeBord[];
  readonly evenements: readonly EvenementTableauDeBord[];
  readonly evenements_perso: readonly EvenementPersoTableauDeBord[];
  readonly depenses: readonly DepenseTableauDeBord[];
  readonly soldes: readonly SoldeTableauDeBord[];
  readonly photos: readonly PhotoTableauDeBord[];
}

function parserStatutPresence(v: unknown): StatutPresenceTableau {
  if (v === 'yes' || v === 'maybe' || v === 'no') return v;
  if (v === null) return null;
  throw new Error('Réponse inattendue : statut de présence inconnu.');
}

function lireDateDepense(d: unknown): string {
  if (typeof d === 'object' && d !== null && 'spent_on' in d) {
    return texte(champ(d, 'spent_on'));
  }
  return texte(champ(d, 'spent_at'));
}

function parserAllDay(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 0) return v === 1;
  throw new Error('Réponse inattendue : all_day invalide.');
}

function lireFuseau(o: unknown): string {
  if (typeof o === 'object' && o !== null && 'time_zone' in o) {
    return texteOuNul(champ(o, 'time_zone')) ?? 'Europe/Paris';
  }
  return 'Europe/Paris';
}

/** Charge les données agrégées du tableau de bord connecté. */
export async function lireTableauDeBord(fenetre?: { du: string; au: string }): Promise<DonneesTableauDeBord> {
  const params = fenetre === undefined ? '' : `?${new URLSearchParams({ du: fenetre.du, au: fenetre.au }).toString()}`;
  const r = await appeler('GET', `/api/moi/tableau-de-bord${params}`);
  return {
    groupes: liste(champ(r, 'groupes')).map((g) => ({
      group_id: texte(champ(g, 'group_id')),
      name: texte(champ(g, 'name')),
      role: role(champ(g, 'role')),
      photos_actives: booleen(champ(g, 'photos_actives')),
    })),
    evenements: liste(champ(r, 'evenements')).map((e) => ({
      id: texte(champ(e, 'id')),
      group_id: texte(champ(e, 'group_id')),
      group_name: texte(champ(e, 'group_name')),
      title: texte(champ(e, 'title')),
      starts_at: texte(champ(e, 'starts_at')),
      ends_at: texteOuNul(champ(e, 'ends_at')),
      all_day: parserAllDay(champ(e, 'all_day')),
      time_zone: lireFuseau(e),
      location_name: texteOuNul(champ(e, 'location_name')),
      mon_statut: parserStatutPresence(champ(e, 'ma_presence')),
    })),
    evenements_perso: liste(champ(r, 'evenements_perso')).map((e) => ({
      id: texte(champ(e, 'id')),
      title: texte(champ(e, 'title')),
      starts_at: texte(champ(e, 'starts_at')),
      ends_at: texteOuNul(champ(e, 'ends_at')),
      all_day: parserAllDay(champ(e, 'all_day')),
      time_zone: lireFuseau(e),
      location_name: texteOuNul(champ(e, 'location_name')),
    })),
    depenses: liste(champ(r, 'depenses')).map((d) => ({
      id: texte(champ(d, 'id')),
      group_id: texte(champ(d, 'group_id')),
      group_name: texte(champ(d, 'group_name')),
      label: texte(champ(d, 'label')),
      amount_minor: nombre(champ(d, 'amount_minor')),
      currency_code: texte(champ(d, 'currency_code')),
      payer_name: texte(champ(d, 'payer_name')),
      spent_on: lireDateDepense(d),
    })),
    soldes: liste(champ(r, 'soldes')).map((s) => ({
      group_id: texte(champ(s, 'group_id')),
      group_name: texte(champ(s, 'group_name')),
      currency_code: texte(champ(s, 'currency_code')),
      net_minor: nombre(champ(s, 'net_minor')),
    })),
    photos: liste(champ(r, 'photos')).map((p) => ({
      group_id: texte(champ(p, 'group_id')),
      group_name: texte(champ(p, 'group_name')),
      album_id: texte(champ(p, 'album_id')),
      album_title: texte(champ(p, 'album_title')),
      immich_asset_id: texte(champ(p, 'immich_asset_id')),
      thumbnail_url: texte(champ(p, 'thumbnail_url')),
    })),
  };
}
