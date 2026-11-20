import { joursDeSemaine } from '../../agenda/dates';
import { libelleJour, libelleMois } from '../../agenda/format';
import type { GroupeTableauDeBord } from '../../api/tableau-de-bord';
import { ChargementPage, SqueletteListe } from '../../components/ChargementPage';
import { Erreur } from '../../components/Erreur';
import { IconeCalendrier } from '../../components/Icones';
import type { EtatLecture } from '../../hooks/useLecture';
import { t } from '../../i18n';
import { BarreOutilsCalendrier } from './BarreOutilsCalendrier';
import { badgeMoisCourt } from './formats';
import { GrilleMois } from './GrilleMois';
import { ListeAgenda } from './ListeAgenda';
import { RubanHebdoMobile } from './RubanHebdoMobile';
import { grouperParJour, type CouleurGroupe, type ElementCalendrier, type FiltreCalendrier, type VueCalendrier } from './selecteurs';
import { VueSemaine } from './VueSemaine';

/**
 * Agenda consolidé. `elements` vient de la lecture de la FENÊTRE (`useFenetreCalendrier`) : c'est le seul bloc du
 * tableau de bord qui suit la navigation. `lecture` décrit l'état de cette lecture, pas celui de la page.
 */
export function WidgetAgenda({
  elements,
  lecture,
  groupesVisibles,
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
  groupesVisibles: readonly GroupeTableauDeBord[];
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
  const parJour = grouperParJour(elements);
  const semaine = joursDeSemaine(ancre);
  const elementsListe = jourSelectionne !== null ? (parJour.get(jourSelectionne) ?? []) : elements;
  const libellePeriode =
    vue === 'mois'
      ? libelleMois(ancre)
      : t('agenda.semaine_du', { jour: libelleJour(semaine[0] ?? ancre, { day: 'numeric', month: 'long' }) });

  return (
    <section className="carte widget-agenda" aria-busy={lecture.enCours}>
      <div className="carte-entete">
        <div className="widget-titre-groupe">
          <h3 className="widget-titre">
            <IconeCalendrier className="widget-titre-icone icone-indigo" />
            <span>{t('tableau.agenda_consolide')}</span>
          </h3>
          <span className="badge-mois">{badgeMoisCourt(ancre)}</span>
        </div>

        <div className="legende-sources">
          {filtre !== 'groupes' && (
            <span className="legende-item">
              <span className="pastille-couleur couleur-violet" aria-hidden="true" />
              <span>{t('tableau.badge_perso')}</span>
            </span>
          )}
          {filtre !== 'perso' &&
            groupesVisibles.slice(0, 4).map((g) => (
              <span key={g.group_id} className="legende-item">
                <span
                  className={`pastille-couleur couleur-${couleurParGroupe.get(g.group_id) ?? 'indigo'}`}
                  aria-hidden="true"
                />
                <span>{g.name}</span>
              </span>
            ))}
        </div>
      </div>

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

      <ChargementPage etat={lecture.etat} erreur={lecture.erreur} onReessayer={lecture.recharger} squelette={<SqueletteListe />}>
        {/* Une relecture de fenêtre ratée garde l'ancienne grille à l'écran : le message s'affiche à côté. */}
        {lecture.etat === 'pret' && <Erreur message={lecture.erreur} onReessayer={lecture.recharger} />}

        <RubanHebdoMobile
          semaine={semaine}
          parJour={parJour}
          couleurParGroupe={couleurParGroupe}
          jourActuel={jourActuel}
          jourSelectionne={jourSelectionne}
          vue={vue}
          onJour={onJour}
          onVue={onVue}
        />

        {vue === 'liste' && <ListeAgenda elements={elementsListe} />}
        {vue === 'mois' && (
          <GrilleMois
            ancre={ancre}
            parJour={parJour}
            couleurParGroupe={couleurParGroupe}
            jourActuel={jourActuel}
            libellePeriode={libellePeriode}
          />
        )}
        {vue === 'semaine' && <VueSemaine semaine={semaine} parJour={parJour} jourActuel={jourActuel} />}
      </ChargementPage>
    </section>
  );
}
