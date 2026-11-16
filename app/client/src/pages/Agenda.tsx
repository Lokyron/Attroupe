import { useEffect, useState } from 'react';
import { listerEvenements, type Evenement } from '../api/evenements';
import { ajouterJours, aujourdhui, grilleMois, jourDeDebut, joursDe, joursDeSemaine, moisVoisin } from '../agenda/dates';
import { libelleHoraire, libelleJour, libelleJourCourt, libelleMois } from '../agenda/format';
import { Erreur, messageDe } from '../components/Erreur';
import { t } from '../i18n';

type Vue = 'mois' | 'semaine' | 'liste';
const VUES: readonly Vue[] = ['mois', 'semaine', 'liste'];

const lienEvenement = (groupId: string, id: string): string => `#/groupe/${encodeURIComponent(groupId)}/evenement/${encodeURIComponent(id)}`;

/** Fenêtre à demander au serveur : la grille affichée, élargie d'un jour (les jours sont lus dans le fuseau de l'événement, la fenêtre en UTC). */
function fenetre(vue: Vue, ancre: string): { du: string; au?: string } {
  if (vue === 'liste') return { du: aujourdhui() };
  const jours = vue === 'mois' ? grilleMois(ancre).flat() : joursDeSemaine(ancre);
  return { du: ajouterJours(jours[0] ?? ancre, -1), au: ajouterJours(jours[jours.length - 1] ?? ancre, 1) };
}

function LigneEvenement({ groupId, e, court }: { groupId: string; e: Evenement; court?: boolean }) {
  return (
    <a className={`evenement${e.status === 'cancelled' ? ' evenement-annule' : ''}`} href={lienEvenement(groupId, e.id)}>
      <span className="evenement-heure">{libelleHoraire(e)}</span> {e.title}
      {e.status === 'cancelled' && court !== true && ` (${t('agenda.annule')})`}
    </a>
  );
}

/** L'agenda du groupe : mois, semaine, liste. La grille est calculée à la main (agenda/dates.ts), sans dépendance. */
export function Agenda({ groupId }: { groupId: string }) {
  const [vue, setVue] = useState<Vue>('mois');
  const [ancre, setAncre] = useState(aujourdhui);
  const [evenements, setEvenements] = useState<Evenement[]>([]);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    setErreur(null);
    // Réponses dans le désordre (deux clics rapides) : celle d'une fenêtre abandonnée est ignorée.
    let abandonne = false;
    listerEvenements(groupId, fenetre(vue, ancre))
      .then((lus) => {
        if (!abandonne) setEvenements(lus);
      })
      .catch((err: unknown) => {
        if (!abandonne) setErreur(messageDe(err));
      });
    return () => {
      abandonne = true;
    };
  }, [groupId, vue, ancre]);

  const parJour = new Map<string, Evenement[]>();
  for (const e of evenements) {
    for (const jour of vue === 'liste' ? [jourDeDebut(e)] : joursDe(e)) parJour.set(jour, [...(parJour.get(jour) ?? []), e]);
  }

  const precedent = (): void => setAncre(vue === 'mois' ? moisVoisin(ancre, -1) : ajouterJours(ancre, -7));
  const suivant = (): void => setAncre(vue === 'mois' ? moisVoisin(ancre, 1) : ajouterJours(ancre, 7));
  const semaine = joursDeSemaine(ancre);
  const titre = vue === 'mois' ? libelleMois(ancre) : vue === 'semaine' ? t('agenda.semaine_du', { jour: libelleJour(semaine[0] ?? ancre, { day: 'numeric', month: 'long' }) }) : t('agenda.a_venir');

  return (
    <section>
      <p>
        <a href={`#/groupe/${encodeURIComponent(groupId)}`}>{t('agenda.retour_groupe')}</a>
      </p>
      <h2>{t('agenda.titre')}</h2>
      <p>
        <a className="bouton" href={`#/groupe/${encodeURIComponent(groupId)}/evenement-nouveau`}>
          {t('agenda.nouvel_evenement')}
        </a>
      </p>
      <div className="barre" role="group" aria-label={t('agenda.vues')}>
        {VUES.map((v) => (
          <button key={v} type="button" aria-pressed={vue === v} onClick={() => setVue(v)}>
            {t(`agenda.vue_${v}` as const)}
          </button>
        ))}
      </div>
      {vue !== 'liste' && (
        <div className="barre">
          <button type="button" onClick={precedent} aria-label={t('agenda.precedent')}>
            {t('agenda.fleche_precedent')}
          </button>
          <strong>{titre}</strong>
          <button type="button" onClick={suivant} aria-label={t('agenda.suivant')}>
            {t('agenda.fleche_suivant')}
          </button>
          <button type="button" onClick={() => setAncre(aujourdhui())}>
            {t('agenda.aujourdhui')}
          </button>
        </div>
      )}
      <Erreur message={erreur} />

      {vue === 'mois' && (
        <div className="grille-mois" role="table" aria-label={titre}>
          <div className="grille-ligne" role="row">
            {(grilleMois(ancre)[0] ?? []).map((jour) => (
              <span key={jour} className="grille-entete" role="columnheader">
                {libelleJourCourt(jour)}
              </span>
            ))}
          </div>
          {grilleMois(ancre).map((ligne) => (
            <div key={ligne[0]} className="grille-ligne" role="row">
              {ligne.map((jour) => (
                <div key={jour} role="cell" className={`grille-jour${jour.slice(0, 7) === ancre.slice(0, 7) ? '' : ' hors-mois'}${jour === aujourdhui() ? ' aujourdhui' : ''}`}>
                  <span className="numero">{Number(jour.slice(8))}</span>
                  {(parJour.get(jour) ?? []).map((e) => (
                    <LigneEvenement key={e.id} groupId={groupId} e={e} court />
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {vue === 'semaine' && (
        <ul className="jours">
          {semaine.map((jour) => (
            <li key={jour}>
              <h3>{libelleJour(jour, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
              {(parJour.get(jour) ?? []).length === 0 && <p className="discret">{t('agenda.rien')}</p>}
              {(parJour.get(jour) ?? []).map((e) => (
                <LigneEvenement key={e.id} groupId={groupId} e={e} />
              ))}
            </li>
          ))}
        </ul>
      )}

      {vue === 'liste' && (
        <>
          <h3>{titre}</h3>
          {evenements.length === 0 && <p>{t('agenda.aucun')}</p>}
          <ul className="jours">
            {[...parJour.entries()].map(([jour, doux]) => (
              <li key={jour}>
                <h3>{libelleJour(jour)}</h3>
                {doux.map((e) => (
                  <LigneEvenement key={e.id} groupId={groupId} e={e} />
                ))}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
