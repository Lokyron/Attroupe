import { useRef, useState } from 'react';
import { aujourdhui, ajouterJours, moisVoisin } from '../agenda/dates';
import { lireTableauDeBord, type DonneesTableauDeBord } from '../api/tableau-de-bord';
import { fenetreCalendrier, type VueCalendrier } from '../pages/tableau/selecteurs';
import { useLecture, type EtatLecture } from './useLecture';

/**
 * Lecture de la fenêtre affichée par le calendrier, dépendante de `(vue, ancre)`. Elle ne nourrit QUE la grille ou
 * la liste d'agenda.
 *
 * Pendant le chargement d'une nouvelle fenêtre, la dernière réponse reste affichée (`donnees` n'est pas vidé) et
 * `etat` reste `pret` : la grille ne clignote pas. Si la relecture échoue, `erreur` est renseignée à côté de l'ancien
 * contenu. `etat` n'est `chargement` ou `erreur` que tant qu'aucune fenêtre n'a jamais été lue.
 */
export function useFenetreCalendrier(vue: VueCalendrier, ancre: string): {
  donnees: DonneesTableauDeBord | null;
  etat: EtatLecture;
  erreur: string | null;
  recharger: () => void;
  enCours: boolean;
} {
  const fenetre = fenetreCalendrier(vue, ancre);
  const lecture = useLecture(() => lireTableauDeBord(fenetre), [fenetre?.du, fenetre?.au]);
  const derniere = useRef<DonneesTableauDeBord | null>(null);
  if (lecture.donnees !== null) derniere.current = lecture.donnees;
  const donnees = lecture.donnees ?? derniere.current;
  return {
    donnees,
    etat: donnees !== null ? 'pret' : lecture.etat,
    erreur: lecture.erreur,
    recharger: lecture.recharger,
    enCours: lecture.etat === 'chargement',
  };
}

/** Jour d'ancrage du calendrier et navigation : période précédente / suivante (mois ou semaine selon la vue), aujourd'hui. */
export function useNavigationCalendrier(vue: VueCalendrier): {
  ancre: string;
  precedent: () => void;
  suivant: () => void;
  aujourdhui: () => void;
} {
  const [ancre, setAncre] = useState<string>(aujourdhui);
  return {
    ancre,
    precedent: () => setAncre(vue === 'mois' ? moisVoisin(ancre, -1) : ajouterJours(ancre, -7)),
    suivant: () => setAncre(vue === 'mois' ? moisVoisin(ancre, 1) : ajouterJours(ancre, 7)),
    aujourdhui: () => setAncre(aujourdhui()),
  };
}
