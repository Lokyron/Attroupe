import { t } from '../../i18n';
import { VUES_CALENDRIER, type FiltreCalendrier, type VueCalendrier } from './selecteurs';

export function BarreOutilsCalendrier({
  filtre,
  onFiltre,
  vue,
  onVue,
  libellePeriode,
  onPrecedent,
  onAujourdhui,
  onSuivant,
}: {
  filtre: FiltreCalendrier;
  onFiltre: (filtre: FiltreCalendrier) => void;
  vue: VueCalendrier;
  onVue: (vue: VueCalendrier) => void;
  libellePeriode: string;
  onPrecedent: () => void;
  onAujourdhui: () => void;
  onSuivant: () => void;
}) {
  return (
    <div className="calendrier-barre-outils">
      <div className="calendrier-controles">
        <div className="barre-onglets" role="group" aria-label={t('tableau.calendrier_sources')}>
          <button type="button" aria-pressed={filtre === 'tous'} onClick={() => onFiltre('tous')}>
            {t('tableau.onglet_tous')}
          </button>
          <button type="button" aria-pressed={filtre === 'groupes'} onClick={() => onFiltre('groupes')}>
            {t('tableau.onglet_groupes')}
          </button>
          <button type="button" aria-pressed={filtre === 'perso'} onClick={() => onFiltre('perso')}>
            {t('tableau.onglet_perso')}
          </button>
        </div>
        <div className="barre-onglets" role="group" aria-label={t('agenda.vues')}>
          {VUES_CALENDRIER.map((v) => (
            <button key={v} type="button" aria-pressed={vue === v} onClick={() => onVue(v)}>
              {t(`agenda.vue_${v}` as const)}
            </button>
          ))}
        </div>
      </div>

      {vue !== 'liste' && (
        <div className="calendrier-nav">
          <div className="calendrier-nav-boutons">
            <button type="button" onClick={onPrecedent} aria-label={t('agenda.precedent')}>
              {t('tableau.calendrier_precedent')}
            </button>
            <button type="button" onClick={onAujourdhui}>
              {t('agenda.aujourdhui')}
            </button>
            <button type="button" onClick={onSuivant} aria-label={t('agenda.suivant')}>
              {t('tableau.calendrier_suivant')}
            </button>
          </div>
          <strong className="calendrier-periode">{libellePeriode}</strong>
        </div>
      )}
    </div>
  );
}
