import { grilleMois } from '../../agenda/dates';
import { libelleJourCourt } from '../../agenda/format';
import { t } from '../../i18n';
import { cleAccord } from '../../lib/pluriel';
import { libellePastilleCalendrier } from './formats';
import { lienElementCalendrier, type CouleurGroupe, type ElementCalendrier } from './selecteurs';

const MAX_ELEMENTS_CELLULE = 3;

export function GrilleMois({
  ancre,
  parJour,
  couleurParGroupe,
  jourActuel,
  libellePeriode,
}: {
  ancre: string;
  parJour: ReadonlyMap<string, readonly ElementCalendrier[]>;
  couleurParGroupe: ReadonlyMap<string, CouleurGroupe>;
  jourActuel: string;
  libellePeriode: string;
}) {
  const lignes = grilleMois(ancre);
  return (
    <div className="grille-mois" role="table" aria-label={libellePeriode}>
      <div className="grille-ligne" role="row">
        {(lignes[0] ?? []).map((jour) => (
          <span key={jour} className="grille-entete" role="columnheader">
            {libelleJourCourt(jour)}
          </span>
        ))}
      </div>
      {lignes.map((ligne) => (
        <div key={ligne[0]} className="grille-ligne" role="row">
          {ligne.map((jour) => (
            <div
              key={jour}
              role="cell"
              className={`grille-jour${jour.slice(0, 7) === ancre.slice(0, 7) ? '' : ' hors-mois'}${jour === jourActuel ? ' aujourdhui' : ''}`}
              aria-current={jour === jourActuel ? 'date' : undefined}
            >
              <span className="numero">{Number(jour.slice(8))}</span>
              {(() => {
                const duJour = parJour.get(jour) ?? [];
                const visibles = duJour.slice(0, MAX_ELEMENTS_CELLULE);
                const reste = duJour.length - visibles.length;
                return (
                  <>
                    {visibles.map((el) => {
                      const libelle = libellePastilleCalendrier(el);
                      const couleur = el.sorte === 'perso' ? 'violet' : (couleurParGroupe.get(el.group_id) ?? 'indigo');
                      return (
                        <a
                          key={`${el.sorte}-${el.id}`}
                          href={lienElementCalendrier(el)}
                          className={`evenement ${el.sorte === 'groupe' ? 'evenement-groupe' : 'evenement-perso'} bordure-${couleur}`}
                          title={libelle}
                        >
                          {libelle}
                        </a>
                      );
                    })}
                    {reste > 0 && <span className="discret ligne-meta">{t(cleAccord('agenda.plus_autres', reste), { n: String(reste) })}</span>}
                  </>
                );
              })()}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
