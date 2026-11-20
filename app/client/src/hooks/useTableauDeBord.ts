import { useMemo } from 'react';
import { lireTableauDeBord } from '../api/tableau-de-bord';
import { ajouterJours, aujourdhui } from '../agenda/dates';
import { useLecture } from './useLecture';

/** Horizon des widgets « à venir », aligné sur le `HORIZON_JOURS` du serveur. */
const HORIZON_JOURS = 90;

/**
 * Lecture du tableau de bord INDÉPENDANTE de la fenêtre du calendrier, lue une fois. Les KPI, les
 * événements à venir, les soldes, les photos et les groupes en dérivent ; naviguer dans le calendrier
 * ne les recharge ni ne les déplace (voir `useFenetreCalendrier` pour la grille).
 *
 * La fenêtre est passée EXPLICITEMENT alors qu'elle reproduit l'horizon par défaut du serveur, parce
 * que c'est sa présence, et non ses bornes, qui lève le plafond : sans elle le serveur rend au plus
 * 12 événements de groupe et 8 personnels TOUS GROUPES CONFONDUS, contre 200 avec
 * (`db/queries/tableau-de-bord.ts`, `MAX_EVENEMENTS_FENETRE`). Un compte à trois groupes actifs
 * verrait alors « Aucun événement » en filtrant sur le groupe le moins chargé, alors que la grille
 * du mois affiche ses événements juste à côté.
 */
export function useTableauDeBord() {
  const du = aujourdhui();
  const au = useMemo(() => ajouterJours(du, HORIZON_JOURS), [du]);
  return useLecture(() => lireTableauDeBord({ du, au }), [du, au]);
}
