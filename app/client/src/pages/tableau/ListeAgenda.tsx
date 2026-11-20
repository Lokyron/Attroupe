import { t } from '../../i18n';
import { cleStatutCompact, formaterDateEvenement } from './formats';
import { lienElementCalendrier, type ElementCalendrier } from './selecteurs';

export function ListeAgenda({ elements }: { elements: readonly ElementCalendrier[] }) {
  if (elements.length === 0) return <p className="discret">{t('tableau.calendrier_vide')}</p>;
  return (
    <ul className="liste-elements">
      {elements.map((el) => (
        <li key={`${el.sorte}-${el.id}`}>
          <a href={lienElementCalendrier(el)} className="ligne-interactive">
            <div className="ligne-principale">
              <div className="ligne-badges">
                {el.sorte === 'groupe' ? (
                  <span className="pilule pilule-agenda">{el.group_name}</span>
                ) : (
                  <span className="pilule pilule-perso">{t('tableau.badge_perso')}</span>
                )}
                {el.sorte === 'groupe' && (
                  <span className={`pilule pilule-statut-${el.mon_statut ?? 'aucun'}`}>
                    {t(cleStatutCompact(el.mon_statut))}
                  </span>
                )}
              </div>
              <strong className="ligne-titre">{el.title}</strong>
              <span className="ligne-meta">
                {formaterDateEvenement(el.starts_at, el.all_day, el.time_zone)}
                {el.location_name !== null ? ` · ${el.location_name}` : ''}
              </span>
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}
