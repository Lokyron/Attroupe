import { libelleHoraire, libelleJour } from '../../agenda/format';
import { t } from '../../i18n';
import { libellePastilleCalendrier } from './formats';
import { lienElementCalendrier, type ElementCalendrier } from './selecteurs';

export function VueSemaine({
  semaine,
  parJour,
  jourActuel,
}: {
  semaine: readonly string[];
  parJour: ReadonlyMap<string, readonly ElementCalendrier[]>;
  jourActuel: string;
}) {
  return (
    <ul className="jours semaine">
      {semaine.map((jour) => {
        const elements = parJour.get(jour) ?? [];
        return (
          <li key={jour} className={jour === jourActuel ? 'aujourdhui' : undefined}>
            <h3>{libelleJour(jour, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
            {elements.length === 0 ? (
              <p className="discret">{t('agenda.rien')}</p>
            ) : (
              elements.map((el) => (
                <a
                  key={`${el.sorte}-${el.id}`}
                  href={lienElementCalendrier(el)}
                  className={`evenement ${el.sorte === 'groupe' ? 'evenement-groupe' : 'evenement-perso'}`}
                >
                  <span className="evenement-heure">{libelleHoraire(el)}</span>{' '}
                  <span className="evenement-libelle">{libellePastilleCalendrier(el)}</span>
                </a>
              ))
            )}
          </li>
        );
      })}
    </ul>
  );
}
