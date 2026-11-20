import { useEffect, useMemo, useState } from 'react';
import {
  changerMaVisibiliteDefaut,
  listerDisponibilitesGroupe,
  visibilitePartage,
  type DisponibiliteMembre,
  type VisibilitePartage,
} from '../api/agenda-personnel';
import { listerEvenements, type Evenement } from '../api/evenements';
import { ajouterJours, aujourdhui, grilleMois, jourDeDebut, joursDe, joursDeSemaine, moisVoisin } from '../agenda/dates';
import { libelleHoraire, libelleJour, libelleJourCourt, libelleMois } from '../agenda/format';
import { EnteteGroupe } from '../components/EnteteGroupe';
import { Erreur, messageDe } from '../components/Erreur';
import { useGroupe } from '../components/FournisseurGroupe';
import { premiereErreur } from '../hooks/etatsLecture';
import { remplacerFragment, useFragment } from '../hooks/useFragment';
import { t } from '../i18n';
import { JOURS_LISTE_DEFAUT, JOURS_LISTE_MAX, lireEtatAgenda, requeteAgenda, VUES_AGENDA, type EtatAgenda, type VueAgenda } from '../lib/etat-agenda';
import { separerFragment } from '../lib/fragment-route';
import { lienEvenement } from '../lib/liens';
import { cleAccord } from '../lib/pluriel';

type Vue = VueAgenda;

/** Fenêtre à demander au serveur : la grille affichée, élargie d'un jour (les jours sont lus dans le fuseau de l'événement, la fenêtre en UTC). */
function fenetre(vue: Vue, ancre: string, joursListe: number): { du: string; au?: string } {
  if (vue === 'liste') {
    const debut = aujourdhui();
    return { du: debut, au: ajouterJours(debut, joursListe) };
  }
  const jours = vue === 'mois' ? grilleMois(ancre).flat() : joursDeSemaine(ancre);
  return { du: ajouterJours(jours[0] ?? ancre, -1), au: ajouterJours(jours[jours.length - 1] ?? ancre, 1) };
}

function LigneEvenement({ groupId, e, court }: { groupId: string; e: Evenement; court?: boolean }) {
  return (
    <a className={`evenement${e.status === 'cancelled' ? ' evenement-annule' : ''}`} href={lienEvenement(groupId, e.id)}>
      <time className="evenement-heure" dateTime={e.starts_at}>
        {libelleHoraire(e)}
      </time>{' '}
      {e.title}
      {e.status === 'cancelled' && court !== true && ` (${t('agenda.annule')})`}
    </a>
  );
}

function LigneDisponibilite({ d }: { d: DisponibiliteMembre }) {
  const horaire = libelleHoraire(d);
  const libelle =
    d.visibility === 'details' && d.title !== null
      ? t('disponibilites.ligne_details', { nom: d.display_name, titre: d.title, horaire })
      : t('disponibilites.ligne_busy', { nom: d.display_name, horaire });
  return <div className="discret ligne-meta">{libelle}</div>;
}

/** L'agenda du groupe : liste, semaine, mois. La grille est calculée à la main (agenda/dates.ts), sans dépendance. */
export function Agenda({ groupId }: { groupId: string }) {
  // Vue, ancre et horizon de la liste vivent dans le fragment d'URL (`?vue=…&date=…&jours=…`) : un lien collé rouvre la même
  // vue, et le rechargement ne perd pas la position. Une valeur absente ou invalide retombe sur le défaut.
  const fragment = useFragment();
  const { vue, ancre, joursListe } = useMemo(
    () =>
      lireEtatAgenda(separerFragment(fragment).requete, {
        vue: window.innerWidth < 640 ? 'liste' : 'mois',
        ancre: aujourdhui(),
        joursListe: JOURS_LISTE_DEFAUT,
      }),
    [fragment],
  );
  const changerEtat = (suite: Partial<EtatAgenda>): void =>
    remplacerFragment(`#/groupe/${encodeURIComponent(groupId)}/agenda${requeteAgenda({ vue, ancre, joursListe, ...suite })}`);
  const setVue = (v: Vue): void => changerEtat({ vue: v });
  const setAncre = (a: string): void => changerEtat({ ancre: a });
  const [evenements, setEvenements] = useState<Evenement[]>([]);
  const [disponibilites, setDisponibilites] = useState<DisponibiliteMembre[]>([]);
  // Choix de l'utilisateur, tant qu'il n'en a pas fait : la valeur par défaut du groupe (contexte).
  const [visibiliteChoisie, setVisibiliteChoisie] = useState<VisibilitePartage | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const { groupe, erreur: erreurGroupe, rafraichirGroupe } = useGroupe();
  const maVisibilite = visibiliteChoisie ?? groupe?.ma_visibilite_defaut ?? 'busy';

  useEffect(() => {
    setErreur(null);
    let abandonne = false;
    const f = fenetre(vue, ancre, joursListe);
    Promise.all([listerEvenements(groupId, f), listerDisponibilitesGroupe(groupId, f)])
      .then(([lus, dispos]) => {
        if (!abandonne) {
          setEvenements(lus);
          setDisponibilites(dispos);
        }
      })
      .catch((err: unknown) => {
        if (!abandonne) setErreur(messageDe(err));
      });
    return () => {
      abandonne = true;
    };
  }, [groupId, vue, ancre, joursListe]);

  const modifierVisibilite = (nouvelle: VisibilitePartage): void => {
    setErreur(null);
    changerMaVisibiliteDefaut(groupId, nouvelle)
      .then((v) => {
        setVisibiliteChoisie(v);
        // Le contexte garde l'ancien défaut sinon : revenu sur l'agenda, le sélecteur réafficherait l'ancienne valeur.
        rafraichirGroupe();
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const parJour = useMemo(() => {
    const regroupes = new Map<string, Evenement[]>();
    for (const e of evenements) {
      for (const jour of vue === 'liste' ? [jourDeDebut(e)] : joursDe(e)) {
        const duJour = regroupes.get(jour);
        if (duJour === undefined) regroupes.set(jour, [e]);
        else duJour.push(e);
      }
    }
    return regroupes;
  }, [evenements, vue]);

  const disposParJour = useMemo(() => {
    const regroupees = new Map<string, DisponibiliteMembre[]>();
    for (const d of disponibilites) {
      for (const jour of vue === 'liste' ? [jourDeDebut(d)] : joursDe(d)) {
        const duJour = regroupees.get(jour);
        if (duJour === undefined) regroupees.set(jour, [d]);
        else duJour.push(d);
      }
    }
    return regroupees;
  }, [disponibilites, vue]);

  const precedent = (): void => setAncre(vue === 'mois' ? moisVoisin(ancre, -1) : ajouterJours(ancre, -7));
  const suivant = (): void => setAncre(vue === 'mois' ? moisVoisin(ancre, 1) : ajouterJours(ancre, 7));
  const semaine = useMemo(() => joursDeSemaine(ancre), [ancre]);
  const titre =
    vue === 'mois'
      ? libelleMois(ancre)
      : vue === 'semaine'
        ? t('agenda.semaine_du', { jour: libelleJour(semaine[0] ?? ancre, { day: 'numeric', month: 'long' }) })
        : t('agenda.a_venir');

  return (
    <section className="page-groupe-pile">
      <EnteteGroupe
        ongletActif="agenda"
        titre={t('agenda.titre')}
        actions={
          <a className="bouton bouton-primaire" href={`#/groupe/${encodeURIComponent(groupId)}/evenement-nouveau`}>
            {t('groupe.action_evenement')}
          </a>
        }
      />

      <Erreur message={premiereErreur(erreur, erreurGroupe)} />

      <div className="carte">
        <div className="calendrier-barre-outils">
          <div className="agenda-outils-haut">
            <div className="barre-onglets" role="group" aria-label={t('agenda.vues')}>
              {VUES_AGENDA.map((v) => (
                <button key={v} type="button" aria-pressed={vue === v} onClick={() => setVue(v)}>
                  {t(`agenda.vue_${v}` as const)}
                </button>
              ))}
            </div>
            <label className="agenda-visibilite-champ">
              <span className="discret ligne-meta">{t('disponibilites.ma_visibilite')}</span>
              <select value={maVisibilite} onChange={(e) => modifierVisibilite(visibilitePartage(e.target.value))}>
                <option value="none">{t('disponibilites.visibilite_none')}</option>
                <option value="busy">{t('disponibilites.visibilite_busy')}</option>
                <option value="details">{t('disponibilites.visibilite_details')}</option>
              </select>
            </label>
          </div>

          {vue !== 'liste' && (
            <div className="calendrier-nav">
              <div className="calendrier-nav-boutons">
                <button type="button" className="bouton-compact" onClick={precedent} aria-label={t('agenda.precedent')}>
                  {t('agenda.fleche_precedent')}
                </button>
                <button type="button" className="bouton-compact" onClick={() => setAncre(aujourdhui())}>
                  {t('agenda.aujourdhui')}
                </button>
                <button type="button" className="bouton-compact" onClick={suivant} aria-label={t('agenda.suivant')}>
                  {t('agenda.fleche_suivant')}
                </button>
              </div>
              <strong className="calendrier-periode">{titre}</strong>
            </div>
          )}
        </div>

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
                {ligne.map((jour) => {
                  const disposJour = disposParJour.get(jour) ?? [];
                  const disposVisibles = disposJour.slice(0, 2);
                  const resteDispos = disposJour.length - disposVisibles.length;
                  return (
                    <div
                      key={jour}
                      role="cell"
                      className={`grille-jour${jour.slice(0, 7) === ancre.slice(0, 7) ? '' : ' hors-mois'}${jour === aujourdhui() ? ' aujourdhui' : ''}`}
                    >
                      <time className="numero" dateTime={jour}>
                        {Number(jour.slice(8))}
                      </time>
                      {(parJour.get(jour) ?? []).map((e) => (
                        <LigneEvenement key={e.id} groupId={groupId} e={e} court />
                      ))}
                      {disposVisibles.map((d) => (
                        <LigneDisponibilite key={`${d.id}-${d.membership_id}`} d={d} />
                      ))}
                      {resteDispos > 0 && (
                        <span className="discret ligne-meta">{t(cleAccord('agenda.plus_autres', resteDispos), { n: String(resteDispos) })}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {vue === 'semaine' && (
          <ul className="jours semaine">
            {semaine.map((jour) => (
              <li key={jour} className={jour === aujourdhui() ? 'aujourdhui' : undefined}>
                <h3>
                  <time dateTime={jour}>{libelleJour(jour, { weekday: 'long', day: 'numeric', month: 'long' })}</time>
                </h3>
                {(parJour.get(jour) ?? []).length === 0 && (disposParJour.get(jour) ?? []).length === 0 && (
                  <p className="discret">{t('agenda.rien')}</p>
                )}
                {(parJour.get(jour) ?? []).map((e) => (
                  <LigneEvenement key={e.id} groupId={groupId} e={e} />
                ))}
                {(disposParJour.get(jour) ?? []).map((d) => (
                  <LigneDisponibilite key={`${d.id}-${d.membership_id}`} d={d} />
                ))}
              </li>
            ))}
          </ul>
        )}

        {vue === 'liste' && (
          <>
            <h3 className="sous-titre-compact">{titre}</h3>
            {evenements.length === 0 && disponibilites.length === 0 && <p className="discret">{t('agenda.aucun')}</p>}
            <ul className="jours">
              {[...new Set([...parJour.keys(), ...disposParJour.keys()])].sort().map((jour) => (
                <li key={jour}>
                  <h3>
                    <time dateTime={jour}>{libelleJour(jour)}</time>
                  </h3>
                  {(parJour.get(jour) ?? []).map((e) => (
                    <LigneEvenement key={e.id} groupId={groupId} e={e} />
                  ))}
                  {(disposParJour.get(jour) ?? []).map((d) => (
                    <LigneDisponibilite key={`${d.id}-${d.membership_id}`} d={d} />
                  ))}
                </li>
              ))}
            </ul>
            <p className="barre-compacte">
              <button type="button" className="bouton-compact" disabled={joursListe >= JOURS_LISTE_MAX}
                onClick={() => changerEtat({ joursListe: Math.min(JOURS_LISTE_MAX, joursListe + JOURS_LISTE_DEFAUT) })}>
                {t('agenda.jours_suivants')}
              </button>
            </p>
          </>
        )}
      </div>
    </section>
  );
}
