import { useMemo } from 'react';
import { joursDeSemaine } from '../../agenda/dates';
import { libelleJour, libelleMois } from '../../agenda/format';
import { ChargementPage, SqueletteListe } from '../../components/ChargementPage';
import { Erreur } from '../../components/Erreur';
import { GrilleSemaine } from '../../components/GrilleSemaine';
import type { EtatLecture } from '../../hooks/useLecture';
import { t } from '../../i18n';
import { cleAccord } from '../../lib/pluriel';
import { BarreOutilsCalendrier } from './BarreOutilsCalendrier';
import { libellePastilleCalendrier } from './formats';
import { GrilleMois } from './GrilleMois';
import { ListeAgenda } from './ListeAgenda';
import { RubanHebdoMobile } from './RubanHebdoMobile';
import {
  compterSurJours,
  entreesGrilleDepuisElements,
  grouperParJour,
  type CouleurGroupe,
  type ElementCalendrier,
  type FiltreCalendrier,
  type VueCalendrier,
} from './selecteurs';

/**
 * Sa semaine. `elements` vient de la lecture de la FENÊTRE (`useFenetreCalendrier`) : c'est le seul bloc du tableau de
 * bord qui suit la navigation. `lecture` décrit l'état de cette lecture, pas celui de la page.
 * Vue « liste » (celle d'arrivée) : le ruban des sept jours, qui montre les événements du jour touché. De là, on ouvre la
 * grille horaire de la semaine ou le mois ; ces deux vues portent la barre d'outils (source, vue, navigation).
 */
export function WidgetAgenda({
  elements,
  lecture,
  couleurParGroupe,
  jourActuel,
  ancre,
  vue,
  onVue,
  filtre,
  onFiltre,
  jourSelectionne,
  onJour,
  onPrecedent,
  onAujourdhui,
  onSuivant,
}: {
  elements: readonly ElementCalendrier[];
  lecture: { etat: EtatLecture; erreur: string | null; recharger: () => void; enCours: boolean };
  couleurParGroupe: ReadonlyMap<string, CouleurGroupe>;
  jourActuel: string;
  ancre: string;
  vue: VueCalendrier;
  onVue: (vue: VueCalendrier) => void;
  filtre: FiltreCalendrier;
  onFiltre: (filtre: FiltreCalendrier) => void;
  jourSelectionne: string | null;
  onJour: (jour: string | null) => void;
  onPrecedent: () => void;
  onAujourdhui: () => void;
  onSuivant: () => void;
}) {
  // `elements` est stable tant que la fenêtre et les filtres ne changent pas (mémoïsé par l'appelant) :
  // basculer de vue ou sélectionner un jour ne regroupe donc pas les événements à nouveau.
  const parJour = useMemo(() => grouperParJour(elements), [elements]);
  const semaine = useMemo(() => joursDeSemaine(ancre), [ancre]);
  const entreesGrille = useMemo(
    () => entreesGrilleDepuisElements(elements, couleurParGroupe, libellePastilleCalendrier),
    [elements, couleurParGroupe],
  );
  const duJour = jourSelectionne !== null ? (parJour.get(jourSelectionne) ?? []) : [];
  const libellePeriode =
    vue === 'mois'
      ? libelleMois(ancre)
      : t('agenda.semaine_du', { jour: libelleJour(semaine[0] ?? ancre, { day: 'numeric', month: 'long' }) });
  const nbEvenementsSemaine = compterSurJours(semaine, parJour);

  return (
    <section className="carte widget-agenda" aria-busy={lecture.enCours} aria-labelledby="semaine-titre">
      <div className="carte-entete">
        <h2 id="semaine-titre" className="bloc-titre">
          <span>{t('tableau.semaine_titre')}</span>
        </h2>
        {/* Le compteur est celui de la semaine affichée : en vue « mois », il ne dirait plus rien de ce qu'on regarde. */}
        {vue !== 'mois' && (
          <span className="discret">
            {nbEvenementsSemaine > 0
              ? t(cleAccord('tableau.ruban_hebdo_compte', nbEvenementsSemaine), { n: String(nbEvenementsSemaine) })
              : t('tableau.ruban_hebdo_aucun')}
          </span>
        )}
      </div>

      {vue !== 'liste' && (
        <BarreOutilsCalendrier
          filtre={filtre}
          onFiltre={onFiltre}
          vue={vue}
          onVue={onVue}
          libellePeriode={libellePeriode}
          onPrecedent={onPrecedent}
          onAujourdhui={onAujourdhui}
          onSuivant={onSuivant}
        />
      )}

      <ChargementPage etat={lecture.etat} erreur={lecture.erreur} onReessayer={lecture.recharger} squelette={<SqueletteListe />}>
        {/* Une relecture de fenêtre ratée garde l'ancienne grille à l'écran : le message s'affiche à côté. */}
        {lecture.etat === 'pret' && <Erreur message={lecture.erreur} onReessayer={lecture.recharger} />}

        {vue === 'liste' && (
          <>
            <RubanHebdoMobile
              semaine={semaine}
              parJour={parJour}
              couleurParGroupe={couleurParGroupe}
              jourActuel={jourActuel}
              jourSelectionne={jourSelectionne}
              onJour={onJour}
            />
            {jourSelectionne !== null && <ListeAgenda elements={duJour} />}
          </>
        )}
        {vue === 'mois' && (
          <GrilleMois
            ancre={ancre}
            parJour={parJour}
            couleurParGroupe={couleurParGroupe}
            jourActuel={jourActuel}
            libellePeriode={libellePeriode}
          />
        )}
        {vue === 'semaine' && <GrilleSemaine semaine={semaine} entrees={entreesGrille} jourActuel={jourActuel} periode={libellePeriode} />}
      </ChargementPage>

      {vue !== 'mois' && (
        <div className="widget-agenda-liens">
          {vue === 'liste' && jourSelectionne !== null && (
            <button type="button" className="lien" onClick={() => onJour(null)}>
              {t('tableau.jour_filtre_effacer')}
            </button>
          )}
          {vue === 'liste' && (
            <button type="button" className="lien" onClick={() => onVue('semaine')}>
              {t('tableau.voir_semaine')}
            </button>
          )}
          <button type="button" className="lien" onClick={() => onVue('mois')}>
            {t('tableau.ouvrir_mois')}
          </button>
        </div>
      )}
    </section>
  );
}
