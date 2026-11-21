// Adaptateur de la page agenda d'un groupe vers la grille de la semaine : événements du groupe et créneaux de
// disponibilité des membres deviennent des `EntreeGrille`. Les types d'entrée sont structurels et minimaux (comme
// `pages/tableau/selecteurs.ts`) : `Evenement` et `DisponibiliteMembre` (api/) les satisfont.
import type { EntreeGrille } from './grille-semaine.js';

interface EvenementEntree {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly all_day: boolean;
  readonly starts_at: string;
  readonly ends_at: string | null;
  readonly time_zone: string;
}

interface DisponibiliteEntree {
  readonly id: string;
  readonly membership_id: string;
  readonly display_name: string;
  readonly visibility: 'busy' | 'details';
  readonly title: string | null;
  readonly all_day: boolean;
  readonly starts_at: string;
  readonly ends_at: string | null;
  readonly time_zone: string;
}

/** Ce que l'appelant fournit : l'adresse d'un événement et les textes des créneaux (l'adaptateur ne lit pas fr.json). */
export interface OutilsGroupe {
  readonly lienEvenement: (id: string) => string;
  readonly titreOccupe: (nom: string) => string;
  readonly titreDetails: (nom: string, titre: string) => string;
}

export function entreesDepuisGroupe(
  evenements: readonly EvenementEntree[],
  disponibilites: readonly DisponibiliteEntree[],
  { lienEvenement, titreOccupe, titreDetails }: OutilsGroupe,
): EntreeGrille[] {
  const evts = evenements.map(
    (e): EntreeGrille => ({
      cle: `evenement-${e.id}`,
      titre: e.title,
      lien: lienEvenement(e.id),
      genre: 'evenement',
      couleur: 'indigo',
      annule: e.status === 'cancelled',
      all_day: e.all_day,
      starts_at: e.starts_at,
      ends_at: e.ends_at,
      time_zone: e.time_zone,
    }),
  );
  const occupes = disponibilites.map(
    (d): EntreeGrille => ({
      cle: `occupe-${d.id}-${d.membership_id}`,
      titre:
        d.visibility === 'details' && d.title !== null
          ? titreDetails(d.display_name, d.title)
          : titreOccupe(d.display_name),
      lien: null,
      genre: 'occupe',
      couleur: 'indigo',
      annule: false,
      all_day: d.all_day,
      starts_at: d.starts_at,
      ends_at: d.ends_at,
      time_zone: d.time_zone,
    }),
  );
  return [...evts, ...occupes];
}
