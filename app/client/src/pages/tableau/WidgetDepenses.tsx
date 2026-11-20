import type { DepenseTableauDeBord, SoldeTableauDeBord } from '../../api/tableau-de-bord';
import { IconeRecu } from '../../components/Icones';
import { t } from '../../i18n';
import { formaterDateCourte, formaterMontant } from './formats';

export function WidgetDepenses({
  soldes,
  depenses,
  groupeDepensesId,
}: {
  soldes: readonly SoldeTableauDeBord[];
  depenses: readonly DepenseTableauDeBord[];
  groupeDepensesId: string;
}) {
  return (
    <section className="carte widget-depenses">
      <div className="carte-entete">
        <h3 className="widget-titre">
          <IconeRecu className="widget-titre-icone icone-emeraude" />
          <span>{t('tableau.depenses_recentes')}</span>
        </h3>
        {groupeDepensesId !== '' && (
          <a href={`#/groupe/${encodeURIComponent(groupeDepensesId)}/depenses`} className="lien-entete-widget">
            {t('tableau.equilibrer')}
          </a>
        )}
      </div>

      {soldes.length > 0 && (
        <div className="soldes-pilules">
          {soldes.map((s) => {
            const classe = s.net_minor > 0 ? 'pilule-positif' : s.net_minor < 0 ? 'pilule-negatif' : 'pilule-neutre';
            return (
              <a
                key={`${s.group_id}-${s.currency_code}`}
                href={`#/groupe/${encodeURIComponent(s.group_id)}/depenses`}
                className={`pilule-solde ${classe}`}
              >
                <span className="pilule-solde-groupe">{s.group_name}</span>
                <strong>{formaterMontant(s.net_minor, s.currency_code, true)}</strong>
              </a>
            );
          })}
        </div>
      )}

      {depenses.length === 0 ? (
        <p className="discret">{t('tableau.depenses_vide')}</p>
      ) : (
        <ul className="liste-elements">
          {depenses.slice(0, 4).map((d) => (
            <li key={d.id}>
              <a
                href={`#/groupe/${encodeURIComponent(d.group_id)}/depenses`}
                className="ligne-interactive ligne-depense"
              >
                <span className="depense-icone-rond" aria-hidden="true">
                  <IconeRecu className="icone-mini" />
                </span>
                <div className="ligne-principale">
                  <strong className="ligne-titre">{d.label}</strong>
                  <span className="ligne-meta">
                    {t('tableau.depense_paye_par', {
                      nom: d.payer_name,
                      groupe: d.group_name,
                      date: formaterDateCourte(d.spent_on),
                    })}
                  </span>
                </div>
                <span className="montant-depense">{formaterMontant(d.amount_minor, d.currency_code)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
