import { useMemo, useState, type ReactNode } from 'react';
import { aujourdhui } from '../agenda/dates';
import type { Moi } from '../api/groupes';
import { ChargementPage, SqueletteCarte } from '../components/ChargementPage';
import { Erreur } from '../components/Erreur';
import { IconeCalendrierPlus, IconeListe, IconePlus } from '../components/Icones';
import { useFenetreCalendrier, useNavigationCalendrier } from '../hooks/useFenetreCalendrier';
import { useTableauDeBord } from '../hooks/useTableauDeBord';
import { t, type CleTexte } from '../i18n';
import { BarreKpis } from './tableau/BarreKpis';
import { WidgetAgenda } from './tableau/WidgetAgenda';
import { WidgetDepenses } from './tableau/WidgetDepenses';
import { WidgetEvenementsAVenir } from './tableau/WidgetEvenementsAVenir';
import { WidgetGroupes } from './tableau/WidgetGroupes';
import { WidgetPhotos } from './tableau/WidgetPhotos';
import {
  couleursParGroupe,
  elementsCalendrier,
  evenementsAVenir,
  filtrerParGroupe,
  groupeCible as choisirGroupeCible,
  groupeDesDepenses,
  groupeDesPhotos,
  nombreAVenirDuMois,
  resumerSoldes,
  type FiltreCalendrier,
  type VueCalendrier,
} from './tableau/selecteurs';

function vueInitialeCalendrier(): VueCalendrier {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(min-width: 640px)').matches ? 'mois' : 'liste';
  }
  return 'liste';
}

/**
 * Tableau de bord d'accueil de l'utilisateur connecté. Deux lectures séparées : `useTableauDeBord` (KPI, à venir,
 * soldes, photos, groupes) ne dépend pas du calendrier ; `useFenetreCalendrier` ne nourrit que l'agenda.
 */
export function TableauDeBord({ moi, onNouveauGroupe }: { moi: Moi; onNouveauGroupe?: () => void }) {
  const [filtreGroupe, setFiltreGroupe] = useState<string>('');
  const [filtreCalendrier, setFiltreCalendrier] = useState<FiltreCalendrier>('tous');
  const [vueCalendrier, setVueCalendrier] = useState<VueCalendrier>(vueInitialeCalendrier);
  const [jourMobileSelectionne, setJourMobileSelectionne] = useState<string | null>(null);
  const navigation = useNavigationCalendrier(vueCalendrier);
  const tableau = useTableauDeBord();
  const fenetre = useFenetreCalendrier(vueCalendrier, navigation.ancre);
  const donnees = tableau.donnees;

  const changerVue = (vue: VueCalendrier): void => {
    setVueCalendrier(vue);
    if (vue !== 'liste') setJourMobileSelectionne(null);
  };

  const jourActuel = aujourdhui();
  // Tant que la lecture n'a pas abouti (ou a échoué), les groupes de `moi` tiennent lieu de repli.
  const groupesConnus = donnees?.groupes ?? moi.groupes;
  const couleurParGroupe = useMemo(() => couleursParGroupe(groupesConnus), [groupesConnus]);
  const groupeCible = useMemo(() => choisirGroupeCible(groupesConnus, filtreGroupe), [groupesConnus, filtreGroupe]);
  const idAideActions = 'aide-actions-groupe';
  const aideActions =
    groupesConnus.length === 0 ? t('tableau.groupes_vide') : t('tableau.choisir_groupe_aide');

  const actionCiblee = (suffixe: string, cle: CleTexte, icone: ReactNode, classe: string): ReactNode => {
    const libelle = t(cle);
    if (groupeCible === null) {
      return (
        <button type="button" className={classe} aria-disabled="true" aria-describedby={idAideActions}>
          {icone}
          <span>{libelle}</span>
        </button>
      );
    }
    const nomComplet = `${libelle} · ${groupeCible.name}`;
    return (
      <a href={`#/groupe/${encodeURIComponent(groupeCible.group_id)}/${suffixe}`} className={classe} title={nomComplet} aria-label={nomComplet}>
        {icone}
        <span>{libelle}</span>
      </a>
    );
  };

  // Tout ce qui suit dérive de la lecture indépendante de la fenêtre.
  // Mémoïsé sur `donnees` (et non sur ses champs, dont le repli `?? []` changerait à chaque rendu) et sur les filtres.
  const groupesVisibles = useMemo(() => filtrerParGroupe(donnees?.groupes ?? [], filtreGroupe), [donnees, filtreGroupe]);
  const aVenir = useMemo(
    () => (donnees === null ? [] : evenementsAVenir(elementsCalendrier(donnees, filtreGroupe, filtreCalendrier), jourActuel)),
    [donnees, filtreGroupe, filtreCalendrier, jourActuel],
  );
  const soldes = useMemo(() => filtrerParGroupe(donnees?.soldes ?? [], filtreGroupe), [donnees, filtreGroupe]);
  const photos = useMemo(() => filtrerParGroupe(donnees?.photos ?? [], filtreGroupe), [donnees, filtreGroupe]);
  const depenses = useMemo(() => filtrerParGroupe(donnees?.depenses ?? [], filtreGroupe), [donnees, filtreGroupe]);
  const resumeSoldes = useMemo(() => resumerSoldes(soldes), [soldes]);
  const groupeDepensesId = groupeDesDepenses(depenses, soldes, groupeCible, groupesConnus);
  const groupePhotos = groupeDesPhotos(groupesVisibles, donnees?.groupes ?? []);

  // La seule dérivation qui suit la navigation : la grille / liste d'agenda.
  // Référence stable entre deux rendus : `WidgetAgenda` en dérive son regroupement par jour.
  const donneesFenetre = fenetre.donnees;
  const elementsAgenda = useMemo(
    () => (donneesFenetre === null ? [] : elementsCalendrier(donneesFenetre, filtreGroupe, filtreCalendrier)),
    [donneesFenetre, filtreGroupe, filtreCalendrier],
  );

  return (
    <div className="tableau-de-bord">
      <section className="dashboard-entete">
        <div className="dashboard-entete-gauche">
          <h2>{t('tableau.vue_ensemble')}</h2>
          <p className="discret">{t('tableau.sous_titre_sync')}</p>
        </div>

        <div className="dashboard-entete-droite">
          <select
            className="filtre-groupe-local"
            aria-label={t('tableau.filtrer_groupe')}
            value={filtreGroupe}
            onChange={(e) => setFiltreGroupe(e.target.value)}
          >
            <option value="">{t('tableau.filtre_tous_groupes')}</option>
            {moi.groupes.map((g) => (
              <option key={g.group_id} value={g.group_id}>
                {g.name}
              </option>
            ))}
          </select>

          <div className="actions-rapides">
            {actionCiblee(
              'depenses',
              'tableau.action_depense',
              <IconePlus className="icone-action icone-emeraude" />,
              'bouton action-rapide',
            )}
            {actionCiblee(
              'listes',
              'tableau.action_liste',
              <IconeListe className="icone-action icone-ambre" />,
              'bouton action-rapide',
            )}
            {actionCiblee(
              'evenement-nouveau',
              'tableau.action_evenement',
              <IconeCalendrierPlus className="icone-action" />,
              'bouton bouton-primaire action-rapide',
            )}
            {onNouveauGroupe !== undefined ? (
              <button type="button" className="bouton action-rapide" onClick={onNouveauGroupe}>
                <IconePlus className="icone-action" />
                <span>{t('tableau.action_groupe')}</span>
              </button>
            ) : (
              <a href="#/nouveau" className="bouton action-rapide">
                <IconePlus className="icone-action" />
                <span>{t('tableau.action_groupe')}</span>
              </a>
            )}
          </div>
          {groupeCible === null && (
            <p id={idAideActions} className="discret">
              {aideActions}
            </p>
          )}
        </div>
      </section>

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
            <BarreKpis
              prochainEvenement={aVenir[0] ?? null}
              jourActuel={jourActuel}
              groupeCibleId={groupeCible?.group_id ?? null}
              resumeSoldes={resumeSoldes}
              groupeDepensesId={groupeDepensesId}
              nbGroupes={donnees.groupes.length}
              invitationsEnAttente={moi.invitations_en_attente}
              nbEvenementsMois={nombreAVenirDuMois(aVenir, jourActuel)}
              nbPhotos={photos.length}
              titrePremierAlbum={photos[0]?.album_title ?? null}
              groupePhotosId={groupePhotos?.group_id ?? null}
            />

            <div className="grille-bento">
              <div className="bento-colonne-gauche">
                <WidgetAgenda
                  elements={elementsAgenda}
                  lecture={fenetre}
                  groupesVisibles={groupesVisibles}
                  couleurParGroupe={couleurParGroupe}
                  jourActuel={jourActuel}
                  ancre={navigation.ancre}
                  vue={vueCalendrier}
                  onVue={changerVue}
                  filtre={filtreCalendrier}
                  onFiltre={setFiltreCalendrier}
                  jourSelectionne={jourMobileSelectionne}
                  onJour={setJourMobileSelectionne}
                  onPrecedent={navigation.precedent}
                  onAujourdhui={navigation.aujourdhui}
                  onSuivant={navigation.suivant}
                />
                <WidgetPhotos
                  photos={photos}
                  groupePhotosId={groupePhotos?.group_id ?? null}
                  couleurParGroupe={couleurParGroupe}
                />
              </div>

              <div className="bento-colonne-droite">
                <WidgetEvenementsAVenir
                  evenements={aVenir}
                  couleurParGroupe={couleurParGroupe}
                  onToutVoir={() => {
                    setJourMobileSelectionne(null);
                    setVueCalendrier('liste');
                  }}
                />
                <WidgetDepenses soldes={soldes} depenses={depenses} groupeDepensesId={groupeDepensesId} />
                <WidgetGroupes groupes={groupesVisibles} />
              </div>
            </div>
          </>
        )}
      </ChargementPage>
    </div>
  );
}
