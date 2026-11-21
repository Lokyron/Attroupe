import { t } from '../../i18n';
import { cleAccord } from '../../lib/pluriel';
import { formaterDateEvenement } from './formats';
import { lienElementCalendrier, type ActionsAttendues } from './selecteurs';

/** Ce qui attend une réponse de l'utilisateur. Rendu `null` quand il n'y a rien : le bloc ne reste pas en place à vide. */
export function BlocAFaire({ actions }: { actions: ActionsAttendues }) {
  if (actions.total === 0) return null;
  return (
    <section className="carte bloc-a-faire" aria-labelledby="a-faire-titre">
      <h2 id="a-faire-titre" className="bloc-titre">
        <span>{t('tableau.a_faire_titre')}</span>
        <span className="badge-alerte">{actions.total}</span>
      </h2>
      <ul className="bloc-a-faire-liste">
        {actions.invitations > 0 && (
          <li>
            <a href="#/invitations" className="ligne-a-faire">
              <span className="ligne-a-faire-texte">
                {t(cleAccord('tableau.a_faire_invitations', actions.invitations), { n: String(actions.invitations) })}
              </span>
              <span className="ligne-a-faire-action">{t('tableau.a_faire_repondre')}</span>
            </a>
          </li>
        )}
        {actions.reponses.map((el) => (
          <li key={el.id}>
            <a href={lienElementCalendrier(el)} className="ligne-a-faire">
              <span className="ligne-a-faire-texte">
                <strong>{el.title}</strong>
                <span className="discret">
                  {`${el.group_name} · ${formaterDateEvenement(el.starts_at, el.all_day, el.time_zone)}`}
                </span>
              </span>
              <span className="ligne-a-faire-action">{t('tableau.a_faire_repondre')}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
