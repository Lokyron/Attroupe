import { libelleJourCourt } from '../../agenda/format';
import { t } from '../../i18n';
import { cleAccord } from '../../lib/pluriel';
import { compterSurJours, type CouleurGroupe, type ElementCalendrier, type VueCalendrier } from './selecteurs';

export function RubanHebdoMobile({
  semaine,
  parJour,
  couleurParGroupe,
  jourActuel,
  jourSelectionne,
  vue,
  onJour,
  onVue,
}: {
  semaine: readonly string[];
  parJour: ReadonlyMap<string, readonly ElementCalendrier[]>;
  couleurParGroupe: ReadonlyMap<string, CouleurGroupe>;
  jourActuel: string;
  jourSelectionne: string | null;
  vue: VueCalendrier;
  onJour: (jour: string | null) => void;
  onVue: (vue: VueCalendrier) => void;
}) {
  const nbEvenementsSemaine = compterSurJours(semaine, parJour);
  return (
    <div className="ruban-hebdo-mobile">
      <div className="ruban-hebdo-jours">
        {semaine.map((jour) => {
          const evenementsJour = parJour.get(jour) ?? [];
          const estAujourdhui = jour === jourActuel;
          const estSelectionne = jourSelectionne === jour;
          const premierEv = evenementsJour[0];
          const couleurPoint =
            premierEv === undefined
              ? ''
              : premierEv.sorte === 'perso'
                ? 'couleur-violet'
                : `couleur-${couleurParGroupe.get(premierEv.group_id) ?? 'indigo'}`;
          return (
            <button
              key={jour}
              type="button"
              className={`ruban-jour${estAujourdhui ? ' aujourdhui' : ''}${estSelectionne ? ' selectionne' : ''}${evenementsJour.length > 0 ? ' avec-evenement' : ''}`}
              aria-pressed={estSelectionne}
              onClick={() => {
                onJour(estSelectionne ? null : jour);
                onVue('liste');
              }}
            >
              <span className="ruban-jour-nom">{libelleJourCourt(jour)}</span>
              <span className="ruban-jour-num">{Number(jour.slice(8))}</span>
              {evenementsJour.length > 0 && <span className={`ruban-jour-point ${couleurPoint}`} aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <div className="ruban-hebdo-pied">
        <span className="discret">
          {nbEvenementsSemaine > 0
            ? t(cleAccord('tableau.ruban_hebdo_compte', nbEvenementsSemaine), { n: String(nbEvenementsSemaine) })
            : t('tableau.ruban_hebdo_aucun')}
        </span>
        <div className="ruban-hebdo-liens">
          {jourSelectionne !== null && (
            <button type="button" className="lien" onClick={() => onJour(null)}>
              {t('tableau.jour_filtre_effacer')}
            </button>
          )}
          {vue !== 'mois' && (
            <button type="button" className="lien" onClick={() => onVue('mois')}>
              {t('tableau.ouvrir_mois')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
