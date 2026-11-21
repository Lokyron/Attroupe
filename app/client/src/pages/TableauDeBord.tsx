import { useMemo, useState } from 'react';
import { aujourdhui } from '../agenda/dates';
import type { Moi } from '../api/groupes';
import { ChargementPage, SqueletteCarte } from '../components/ChargementPage';
import { Erreur } from '../components/Erreur';
import { IconeCamera, IconeGroupes } from '../components/Icones';
import { useFenetreCalendrier, useNavigationCalendrier } from '../hooks/useFenetreCalendrier';
import { useTableauDeBord } from '../hooks/useTableauDeBord';
import { t } from '../i18n';
import { etatActionsCreation } from '../lib/actions-creation';
import { BlocAFaire } from './tableau/BlocAFaire';
import { BlocSolde } from './tableau/BlocSolde';
import { CarteProchain } from './tableau/CarteProchain';
import { Pli } from './tableau/Pli';
import { WidgetAgenda } from './tableau/WidgetAgenda';
import { WidgetGroupes } from './tableau/WidgetGroupes';
import { WidgetPhotos } from './tableau/WidgetPhotos';
import {
  actionsAttendues,
  couleursParGroupe,
  elementsCalendrier,
  groupeDesPhotos,
  nonTermines,
  prochainEvenement,
  soldesParGroupe,
  type FiltreCalendrier,
  type VueCalendrier,
} from './tableau/selecteurs';

/**
 * Tableau de bord d'accueil de l'utilisateur connecté, pensé pour le téléphone. Ordre de lecture (= ordre du DOM) :
 * le prochain événement, ce qui attend une action (absent s'il n'y en a pas), sa semaine, son solde net par groupe,
 * puis le reste replié. Les créations (événement, dépense, liste, groupe) vivent dans la feuille « Créer » du bandeau du bas.
 * Deux lectures séparées : `useTableauDeBord` (prochain, à faire, soldes, photos, groupes) ne dépend pas du calendrier ;
 * `useFenetreCalendrier` ne nourrit que « Sa semaine ».
 */
export function TableauDeBord({ moi }: { moi: Moi }) {
  const [filtreCalendrier, setFiltreCalendrier] = useState<FiltreCalendrier>('tous');
  const [vueCalendrier, setVueCalendrier] = useState<VueCalendrier>('liste');
  const [jourSelectionne, setJourSelectionne] = useState<string | null>(null);
  const navigation = useNavigationCalendrier(vueCalendrier);
  const tableau = useTableauDeBord();
  const fenetre = useFenetreCalendrier(vueCalendrier, navigation.ancre);
  const donnees = tableau.donnees;

  const changerVue = (vue: VueCalendrier): void => {
    setVueCalendrier(vue);
    if (vue !== 'liste') setJourSelectionne(null);
  };

  const jourActuel = aujourdhui();
  // Tant que la lecture n'a pas abouti (ou a échoué), les groupes de `moi` tiennent lieu de repli.
  const groupesConnus = donnees?.groupes ?? moi.groupes;
  const couleurParGroupe = useMemo(() => couleursParGroupe(groupesConnus), [groupesConnus]);
  // Un seul groupe : l'événement se crée d'un geste ; plusieurs : c'est la feuille « Créer » qui laisse choisir.
  const lienCreation = useMemo(() => etatActionsCreation(groupesConnus, '')[0]?.lien ?? null, [groupesConnus]);

  // Tout ce qui suit dérive de la lecture indépendante de la fenêtre. Mémoïsé sur `donnees` (et non sur ses champs,
  // dont le repli `?? []` changerait à chaque rendu).
  const prochain = useMemo(
    () => (donnees === null ? null : prochainEvenement(elementsCalendrier(donnees, 'tous'), new Date(), jourActuel)),
    [donnees, jourActuel],
  );
  const aFaire = useMemo(
    () =>
      actionsAttendues(
        donnees === null ? [] : nonTermines(elementsCalendrier(donnees, 'tous'), new Date(), jourActuel),
        moi.invitations_en_attente,
        prochain,
      ),
    [donnees, jourActuel, moi.invitations_en_attente, prochain],
  );
  const soldes = useMemo(() => soldesParGroupe(donnees?.soldes ?? []), [donnees]);
  const groupePhotos = groupeDesPhotos(donnees?.groupes ?? [], []);
  const photos = donnees?.photos ?? [];

  // La seule dérivation qui suit la navigation : la grille / le ruban de la semaine.
  // Référence stable entre deux rendus : `WidgetAgenda` en dérive son regroupement par jour.
  const donneesFenetre = fenetre.donnees;
  const elementsAgenda = useMemo(
    () => (donneesFenetre === null ? [] : elementsCalendrier(donneesFenetre, filtreCalendrier)),
    [donneesFenetre, filtreCalendrier],
  );

  return (
    <div className="tableau-de-bord">
      <ChargementPage
        etat={tableau.etat}
        erreur={tableau.erreur}
        onReessayer={tableau.recharger}
        squelette={
          <>
            <SqueletteCarte />
            <SqueletteCarte />
          </>
        }
      >
        {/* Une relecture ratée garde l'écran intact : le message s'affiche à côté du contenu. */}
        {tableau.etat === 'pret' && <Erreur message={tableau.erreur} onReessayer={tableau.rafraichir} />}
        {donnees !== null && (
          <>
            <div className="tableau-haut">
              <CarteProchain
                prochain={prochain}
                jourActuel={jourActuel}
                couleurParGroupe={couleurParGroupe}
                lienCreation={lienCreation}
                aucunGroupe={donnees.groupes.length === 0}
              />
              <BlocAFaire actions={aFaire} />
            </div>

            <WidgetAgenda
              elements={elementsAgenda}
              lecture={fenetre}
              couleurParGroupe={couleurParGroupe}
              jourActuel={jourActuel}
              ancre={navigation.ancre}
              vue={vueCalendrier}
              onVue={changerVue}
              filtre={filtreCalendrier}
              onFiltre={setFiltreCalendrier}
              jourSelectionne={jourSelectionne}
              onJour={setJourSelectionne}
              onPrecedent={navigation.precedent}
              onAujourdhui={navigation.aujourdhui}
              onSuivant={navigation.suivant}
            />

            <BlocSolde soldes={soldes} />

            {(photos.length > 0 || donnees.groupes.length > 0) && (
              <div className="tableau-replie">
                {photos.length > 0 && (
                  <Pli titre={t('tableau.photos_titre')} icone={<IconeCamera className="widget-titre-icone icone-rose" />}>
                    <WidgetPhotos photos={photos} groupePhotosId={groupePhotos?.group_id ?? null} couleurParGroupe={couleurParGroupe} />
                  </Pli>
                )}
                {donnees.groupes.length > 0 && (
                  <Pli titre={t('tableau.groupes_titre')} icone={<IconeGroupes className="widget-titre-icone icone-ambre" />}>
                    <WidgetGroupes groupes={donnees.groupes} />
                  </Pli>
                )}
              </div>
            )}
          </>
        )}
      </ChargementPage>
    </div>
  );
}
