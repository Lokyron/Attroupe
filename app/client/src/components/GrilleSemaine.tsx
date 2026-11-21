import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { libelleHeure, libelleHoraire, libelleJour, libelleJourCourt } from '../agenda/format';
import {
  MINUTES_PAR_JOUR,
  composerSemaine,
  indexJourVisible,
  minuteDeCalage,
  premierDebut,
  semaineVide,
  type EntreeGrille,
} from '../agenda/grille-semaine';
import { t } from '../i18n';

// Ce composant vit dans `components/` et non dans `pages/tableau/` : la page agenda d'un groupe et le tableau de bord
// le montent tous les deux, il n'appartient à aucune des deux. Le placement est dans `agenda/grille-semaine.ts`.

/** Variables CSS posées en ligne (`--decalage`, `--colonne`…) : le calcul est en TS, la géométrie en CSS. */
type StyleVariables = CSSProperties & Record<`--${string}`, string | number>;

const HEURES = Array.from({ length: 24 }, (_, h) => h);

function ContenuEntree({ entree, masquerHoraire }: { entree: EntreeGrille; masquerHoraire: boolean }) {
  return (
    <>
      <time className={masquerHoraire ? 'sr-only' : 'semaine-heure'} dateTime={entree.starts_at}>
        {libelleHoraire(entree)}
      </time>{' '}
      <span className="semaine-titre">
        {entree.titre}
        {entree.annule && ` (${t('agenda.annule')})`}
      </span>
    </>
  );
}

function Bloc({ entree, style, masquerHoraire = false }: { entree: EntreeGrille; style?: StyleVariables; masquerHoraire?: boolean }) {
  const classe = `semaine-bloc ${entree.genre === 'occupe' ? 'semaine-occupe' : `bordure-${entree.couleur}`}${entree.annule ? ' evenement-annule' : ''}`;
  const titre = `${libelleHoraire(entree)} — ${entree.titre}`;
  const contenu = <ContenuEntree entree={entree} masquerHoraire={masquerHoraire} />;
  return entree.lien === null ? (
    <div className={classe} style={style} title={titre}>
      {contenu}
    </div>
  ) : (
    <a className={classe} style={style} href={entree.lien} title={titre}>
      {contenu}
    </a>
  );
}

/**
 * Grille horaire de la semaine : heures en lignes, jours en colonnes. Tant que le CONTENEUR est trop étroit pour sept
 * colonnes lisibles (`@container semaine`, voir la feuille de style) un seul jour tient à l'écran : les jours défilent
 * horizontalement (`scroll-snap`) et un ruban de pastilles permet de sauter à l'un d'eux ; au-delà, les sept jours sont
 * côte à côte. Le seuil n'existe qu'en CSS : le JavaScript lit son effet (voir `unSeulJour`) au lieu de le répéter. Sémantique : une région au clavier (défilable), un groupe étiqueté par jour, des liens dans
 * l'ordre chronologique. Pas de `role="grid"` : les blocs positionnés ne forment pas un tableau de cellules.
 */
export function GrilleSemaine({
  semaine,
  entrees,
  jourActuel,
  periode,
}: {
  semaine: readonly string[];
  entrees: readonly EntreeGrille[];
  jourActuel: string;
  /** Libellé de la période (« Semaine du 16 mars »), repris dans le nom de la région. */
  periode: string;
}) {
  const placee = useMemo(() => composerSemaine(semaine, entrees), [semaine, entrees]);
  const zone = useRef<HTMLDivElement>(null);
  const corpsHeures = useRef<HTMLDivElement>(null);
  const idBase = useId();
  const premierJour = semaine[0] ?? '';
  // La semaine s'ouvre sur aujourd'hui si elle le contient, sinon sur son lundi.
  const indexInitial = Math.max(0, semaine.indexOf(jourActuel));
  const [indexVisible, setIndexVisible] = useState(indexInitial);

  // Mode « un jour à la fois » = l'aimantation horizontale est active. On lit le style calculé plutôt que de redupliquer le
  // seuil du `@container` en JS : les deux ne peuvent pas se désynchroniser (le seuil se règle à un seul endroit, le CSS).
  const unSeulJour = (): boolean => zone.current !== null && getComputedStyle(zone.current).scrollSnapType !== 'none';
  const largeurJour = (): number => zone.current?.querySelector<HTMLElement>('.semaine-jour')?.offsetWidth ?? 0;

  useEffect(() => {
    if (zone.current === null || !unSeulJour()) return;
    zone.current.scrollTo({
      left: indexInitial * largeurJour(),
      behavior: 'auto',
    });
    setIndexVisible(indexInitial);
  }, [premierJour, indexInitial]);

  // Les heures hors plage restent atteignables en défilant ; à l'ouverture on se cale sur l'heure courante (semaine en cours),
  // sinon sur le premier événement du jour affiché (ou de la semaine, jours côte à côte), sinon sur le début de la plage.
  const semaineEnCours = semaine.includes(jourActuel);
  // L'heure courante pilote seule le calage de la semaine en cours : y changer de jour ne fait pas remonter la grille.
  const indexCalage = semaineEnCours ? -1 : indexVisible;
  useEffect(() => {
    if (zone.current === null || corpsHeures.current === null) return;
    const pxParMinute = corpsHeures.current.offsetHeight / MINUTES_PAR_JOUR;
    const maintenant = new Date();
    const minutesVisibles = (zone.current.clientHeight - corpsHeures.current.offsetTop) / pxParMinute;
    const minute = minuteDeCalage(
      placee.plage,
      semaineEnCours ? maintenant.getHours() * 60 + maintenant.getMinutes() : null,
      premierDebut(placee.jours, unSeulJour() ? indexVisible : null),
      minutesVisibles,
    );
    zone.current.scrollTop = minute * pxParMinute;
  }, [premierJour, semaineEnCours, indexCalage, placee]);

  const surDefilement = (): void => {
    if (zone.current === null || !unSeulJour()) return;
    setIndexVisible(indexJourVisible(zone.current.scrollLeft, largeurJour(), semaine.length));
  };

  const aller = (index: number): void => {
    if (zone.current === null) return;
    const reduit = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    zone.current.scrollTo({
      left: index * largeurJour(),
      behavior: reduit ? 'auto' : 'smooth',
    });
    setIndexVisible(index);
  };

  const style: StyleVariables = {
    '--plage-heures': placee.plage.fin - placee.plage.debut,
    '--bande-lignes': placee.lignesBande,
  };

  return (
    <div className="semaine">
      <div className="ruban-hebdo-mobile">
        <div className="ruban-hebdo-jours" role="group" aria-label={t('agenda.semaine_jours')}>
          {placee.jours.map((j, i) => {
            const premiere = j.journee[0] ?? j.blocs[0]?.entree;
            return (
              <button
                key={j.jour}
                type="button"
                className={`ruban-jour${j.jour === jourActuel ? ' aujourdhui' : ''}${i === indexVisible ? ' selectionne' : ''}${premiere !== undefined ? ' avec-evenement' : ''}`}
                aria-current={i === indexVisible ? 'true' : undefined}
                aria-label={libelleJour(j.jour, {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                })}
                onClick={() => aller(i)}
              >
                <span className="ruban-jour-nom">{libelleJourCourt(j.jour)}</span>
                <span className="ruban-jour-num">{Number(j.jour.slice(8))}</span>
                {premiere !== undefined && <span className={`ruban-jour-point couleur-${premiere.couleur}`} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </div>

      <div
        ref={zone}
        className="semaine-defilement"
        role="region"
        aria-label={t('agenda.semaine_grille', { periode })}
        tabIndex={0}
        style={style}
        onScroll={surDefilement}
      >
        <div className="semaine-heures" aria-hidden="true">
          <div className="semaine-entete" />
          {placee.lignesBande > 0 && <div className="semaine-bande" />}
          <div ref={corpsHeures} className="semaine-corps">
            {HEURES.slice(1).map((h) => (
              <span key={h} className="semaine-heure-ligne" style={{ '--heure': h } as StyleVariables}>
                {libelleHeure(h)}
              </span>
            ))}
          </div>
        </div>

        {placee.jours.map((j) => (
          <div
            key={j.jour}
            role="group"
            aria-labelledby={`${idBase}-${j.jour}`}
            aria-current={j.jour === jourActuel ? 'date' : undefined}
            className={`semaine-jour${j.jour === jourActuel ? ' aujourdhui' : ''}`}
          >
            <h3 id={`${idBase}-${j.jour}`} className="semaine-entete">
              <time dateTime={j.jour}>
                <span aria-hidden="true">{libelleJour(j.jour, { weekday: 'short', day: 'numeric' })}</span>
                <span className="sr-only">
                  {libelleJour(j.jour, {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                  })}
                </span>
              </time>
            </h3>
            {placee.lignesBande > 0 && (
              <div className="semaine-bande">
                {j.journee.map((entree) => (
                  <Bloc key={entree.cle} entree={entree} masquerHoraire />
                ))}
              </div>
            )}
            <div className="semaine-corps">
              {j.blocs.map((b) => (
                <Bloc
                  key={b.entree.cle}
                  entree={b.entree}
                  style={{
                    '--decalage': b.decalage,
                    '--hauteur': b.hauteur,
                    '--colonne': b.colonne,
                    '--colonnes': b.colonnes,
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      {semaineVide(placee) && <p className="discret semaine-vide">{t('agenda.rien')}</p>}
    </div>
  );
}
