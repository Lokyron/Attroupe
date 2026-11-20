import { libelleHoraire } from '../../agenda/format';
import { IconeEtincelles, IconeLieu } from '../../components/Icones';
import { t } from '../../i18n';
import { cleStatutCompact, partiesVignetteDate } from './formats';
import { lienElementCalendrier, type CouleurGroupe, type ElementCalendrier } from './selecteurs';

export function WidgetEvenementsAVenir({
  evenements,
  couleurParGroupe,
  onToutVoir,
}: {
  evenements: readonly ElementCalendrier[];
  couleurParGroupe: ReadonlyMap<string, CouleurGroupe>;
  onToutVoir: () => void;
}) {
  return (
    <section className="carte widget-evenements">
      <div className="carte-entete">
        <h3 className="widget-titre">
          <IconeEtincelles className="widget-titre-icone icone-indigo" />
          <span>{t('tableau.evenements_a_venir')}</span>
        </h3>
        <button type="button" className="lien-entete-widget bouton-lien" onClick={onToutVoir}>
          {t('tableau.tout_voir')}
        </button>
      </div>

      {evenements.length === 0 ? (
        <p className="discret">{t('agenda.aucun')}</p>
      ) : (
        <div className="liste-tuiles-evenements">
          {evenements.slice(0, 4).map((el) => {
            const { mois, jour } = partiesVignetteDate(el);
            const couleur = el.sorte === 'perso' ? 'violet' : (couleurParGroupe.get(el.group_id) ?? 'indigo');
            const horaire = el.all_day ? t('tableau.journee_entiere') : libelleHoraire(el);
            return (
              <a key={`${el.sorte}-${el.id}`} href={lienElementCalendrier(el)} className="tuile-evenement">
                <div className="tuile-evenement-haut">
                  <div className="tuile-evenement-gauche">
                    <div className={`vignette-date vignette-date-${couleur}`} aria-hidden="true">
                      <span className="vignette-date-mois">{mois}</span>
                      <span className="vignette-date-jour">{jour}</span>
                    </div>
                    <div className="tuile-evenement-info">
                      <strong className="tuile-evenement-titre">{el.title}</strong>
                      <span className="tuile-evenement-meta">
                        <IconeLieu className="icone-mini" />
                        <span>{el.location_name !== null ? `${el.location_name} · ${horaire}` : horaire}</span>
                      </span>
                    </div>
                  </div>
                  {el.sorte === 'groupe' ? (
                    <span className={`pilule pilule-statut-${el.mon_statut ?? 'aucun'}`}>
                      {t(cleStatutCompact(el.mon_statut))}
                    </span>
                  ) : (
                    <span className="pilule pilule-perso">{t('tableau.badge_perso')}</span>
                  )}
                </div>
                <div className="tuile-evenement-pied">
                  <span className={`tuile-evenement-source source-${couleur}`}>
                    {el.sorte === 'groupe' ? el.group_name : t('tableau.badge_perso')}
                  </span>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </section>
  );
}
