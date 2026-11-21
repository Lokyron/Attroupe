import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { defilementPourCentrer } from '../../lib/defilement-ruban';
import { libelleJour, libelleJourCourt } from '../../agenda/format';
import type { CouleurGroupe, ElementCalendrier } from './selecteurs';

/** Les sept jours de la semaine affichée ; toucher un jour en montre les événements (le retoucher efface la sélection). */
export function RubanHebdoMobile({
  semaine,
  parJour,
  couleurParGroupe,
  jourActuel,
  jourSelectionne,
  onJour,
}: {
  semaine: readonly string[];
  parJour: ReadonlyMap<string, readonly ElementCalendrier[]>;
  couleurParGroupe: ReadonlyMap<string, CouleurGroupe>;
  jourActuel: string;
  jourSelectionne: string | null;
  onJour: (jour: string | null) => void;
}) {
  const conteneur = useRef<HTMLDivElement>(null);
  const premierJour = semaine[0] ?? '';

  // Amène le jour sélectionné (sinon aujourd'hui) dans le champ. On règle `scrollLeft` du seul ruban (`.ruban-hebdo-jours`,
  // le nœud qui porte `overflow-x`) : `scrollIntoView` ferait aussi défiler la page. Le premier placement est instantané : une
  // animation lancée pendant la mise en page peut être interrompue et laisser le ruban à 0. Seuls les changements
  // ultérieurs (autre semaine, autre jour) s'animent. Un `ResizeObserver` rejoue le calcul si la largeur change.
  const centrer = useCallback(
    (animer: boolean): void => {
      const zone = conteneur.current;
      if (zone === null) return;
      const rang = semaine.indexOf(jourSelectionne ?? jourActuel);
      const pastille = rang < 0 ? undefined : zone.children[rang];
      if (!(pastille instanceof HTMLElement)) return;
      const p = pastille.getBoundingClientRect();
      const position = zone.scrollLeft + (p.left - zone.getBoundingClientRect().left);
      const gauche = defilementPourCentrer(zone.clientWidth, zone.scrollWidth, position, p.width);
      const reduit = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      zone.scrollTo({
        left: gauche,
        behavior: animer && !reduit ? 'smooth' : 'auto',
      });
    },
    [semaine, jourSelectionne, jourActuel],
  );

  const dejaPlace = useRef(false);
  useLayoutEffect(() => {
    centrer(dejaPlace.current);
    dejaPlace.current = true;
  }, [centrer, premierJour]);

  useEffect(() => {
    const zone = conteneur.current;
    if (zone === null || typeof ResizeObserver === 'undefined') return;
    const observateur = new ResizeObserver(() => centrer(false));
    observateur.observe(zone);
    return () => observateur.disconnect();
  }, [centrer]);

  return (
    <div className="ruban-hebdo-mobile">
      <div className="ruban-hebdo-jours" ref={conteneur}>
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
              aria-current={estAujourdhui ? 'date' : undefined}
              aria-label={libelleJour(jour, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
              onClick={() => onJour(estSelectionne ? null : jour)}
            >
              <span className="ruban-jour-nom">{libelleJourCourt(jour)}</span>
              <span className="ruban-jour-num">{Number(jour.slice(8))}</span>
              {evenementsJour.length > 0 && <span className={`ruban-jour-point ${couleurPoint}`} aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
