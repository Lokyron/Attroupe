import { t } from '../../i18n';
import { partiesSoldeAffichees } from './formats';
import type { SoldeGroupe } from './selecteurs';

/**
 * Où il en est financièrement : un chiffre net par groupe, le détail derrière un tapotement (la page des dépenses du groupe).
 * Le nom accessible du lien est son contenu (groupe, sens et montant) : pas d'`aria-label`, qui l'écraserait.
 * Un groupe à plusieurs devises affiche une partie par devise, chacune avec son sens.
 */
export function BlocSolde({ soldes }: { soldes: readonly SoldeGroupe[] }) {
  if (soldes.length === 0) return null;
  return (
    <section className="carte bloc-solde" aria-labelledby="solde-titre">
      <h2 id="solde-titre" className="bloc-titre">
        <span>{t('tableau.solde_titre')}</span>
      </h2>
      <ul className="bloc-solde-liste">
        {soldes.map((s) => (
          <li key={s.group_id}>
            <a href={`#/groupe/${encodeURIComponent(s.group_id)}/depenses`} className="ligne-solde">
              <span className="ligne-solde-groupe">{s.group_name}</span>
              {partiesSoldeAffichees(s).map((p) => (
                <span key={p.devise} className={`ligne-solde-partie solde-${p.sens}`}>
                  <span className="ligne-solde-etiquette">{p.etiquette}</span>
                  <strong className="ligne-solde-montant">{p.montant}</strong>
                </span>
              ))}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
