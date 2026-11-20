import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { type Membre } from '../api/groupes';
import { creerListe, listerListes, type ResumeListe } from '../api/listes';
import { assigner, changerStatut, creerTache, listerTaches, supprimerTache, type Tache } from '../api/taches';
import { useRechargement } from '../api/rechargement';
import { useGroupe, useTempsReelGroupe } from './FournisseurGroupe';
import { fusionnerEtats, premiereErreur } from '../hooks/etatsLecture';
import { useLecture } from '../hooks/useLecture';
import { useSoumission } from '../hooks/useSoumission';
import { lienListe } from '../pages/Listes';
import { t } from '../i18n';
import { ChargementPage } from './ChargementPage';
import { DialogueConfirmation } from './DialogueConfirmation';
import { Erreur, messageDe } from './Erreur';

/**
 * Le « qui apporte quoi » d'un événement : ses tâches (avec qui s'en occupe) et ses listes de courses. Se met à jour avec le flux du groupe.
 * Le serveur reste juge : réassigner la tâche de quelqu'un d'autre est un droit, l'interface n'est qu'un confort.
 */
export function TachesEvenement({ groupId, evenementId, titreEvenement, membres }: { groupId: string; evenementId: string; titreEvenement: string; membres: Membre[] }) {
  // Lecture initiale à trois états ; les rafraîchissements du flux temps réel se font ensuite dans `CorpsTaches` (`useRechargement`), sans repasser par le squelette.
  const { etat: etatGroupe, erreur: erreurGroupe, rechargerGroupe } = useGroupe();
  const lecture = useLecture<LecturesTaches>(
    () => Promise.all([listerTaches(groupId, evenementId), listerListes(groupId, evenementId)]).then(([taches, listes]) => ({ taches, listes })),
    [groupId, evenementId],
  );
  const { donnees } = lecture;
  const reessayer = (): void => {
    if (etatGroupe === 'erreur') rechargerGroupe();
    lecture.recharger();
  };
  return (
    <ChargementPage etat={fusionnerEtats(etatGroupe, lecture.etat)} erreur={premiereErreur(erreurGroupe, lecture.erreur)} onReessayer={reessayer}>
      {donnees !== null && <CorpsTaches groupId={groupId} evenementId={evenementId} titreEvenement={titreEvenement} membres={membres} initial={donnees} />}
    </ChargementPage>
  );
}

interface LecturesTaches {
  taches: Tache[];
  listes: ResumeListe[];
}

function CorpsTaches({ groupId, evenementId, titreEvenement, membres, initial }: { groupId: string; evenementId: string; titreEvenement: string; membres: Membre[]; initial: LecturesTaches }) {
  const [taches, setTaches] = useState<Tache[]>(initial.taches);
  const [listes, setListes] = useState<ResumeListe[]>(initial.listes);
  const { groupe } = useGroupe();
  const moi = groupe?.mon_appartenance_id ?? null;
  const [titre, setTitre] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [aSupprimer, setASupprimer] = useState<Tache | null>(null);
  const ajout = useSoumission();
  const creationListe = useSoumission();
  const suppression = useSoumission();

  const { recharger, planifier } = useRechargement(
    () => Promise.all([listerTaches(groupId, evenementId), listerListes(groupId, evenementId)] as const),
    ([lues, listesLues]) => {
      setTaches(lues);
      setListes(listesLues);
    },
    (err) => setErreur(messageDe(err)),
  );
  // Les listes de CET événement : un message d'article ne nous concerne que s'il vient de l'une d'elles.
  const idsListes = useRef<ReadonlySet<string>>(new Set());
  idsListes.current = new Set(listes.map((l) => l.id));
  useTempsReelGroupe({
    onOuvert: recharger,
    onEvenement: (e) => {
      const concerne =
        (e.ressource === 'tache' && e.parent_id === evenementId) ||
        (e.ressource === 'liste' && (e.parent_id === evenementId || idsListes.current.has(e.id))) ||
        (e.ressource === 'article' && e.parent_id !== null && idsListes.current.has(e.parent_id));
      if (concerne) planifier();
    },
  });

  const agir = (action: Promise<unknown>): void => {
    setErreur(null);
    action.then(recharger).catch((err: unknown) => {
      setErreur(messageDe(err));
      recharger();
    });
  };

  const ajouter = (evt: FormEvent): void => {
    evt.preventDefault();
    if (titre.trim() === '') return;
    setErreur(null);
    // Le champ n'est vidé qu'une fois la tâche créée : un échec laisse le texte à l'utilisateur.
    ajout
      .lancer(() =>
        creerTache(groupId, titre.trim(), evenementId).then(() => {
          setTitre('');
          recharger();
        }),
      )
      .catch((err: unknown) => {
        setErreur(messageDe(err));
        recharger();
      });
  };

  const actifs = membres.filter((m) => m.status === 'active');
  return (
    <>
      <h3>{t('taches.titre')}</h3>
      <Erreur message={erreur} />
      {taches.length === 0 && <p>{t('taches.aucune')}</p>}
      <ul className="taches">
        {taches.map((tache) => {
          const aMoi = tache.assignee_membership_id !== null && tache.assignee_membership_id === moi;
          return (
            <li key={tache.id} className={`tache${tache.status === 'done' ? ' article-fait' : ''}`}>
              <label className="article-case">
                <input type="checkbox" checked={tache.status === 'done'} disabled={tache.status === 'dropped'} onChange={() => agir(changerStatut(groupId, tache.id, tache.status === 'done' ? 'todo' : 'done'))} />
                <span className="article-libelle">{tache.title}</span>
              </label>
              <span className="barre">
                {tache.assignee_membership_id === null || aMoi ? (
                  <button type="button" aria-pressed={aMoi} disabled={moi === null} onClick={() => moi !== null && agir(assigner(groupId, tache.id, aMoi ? null : moi))}>
                    {aMoi ? t('taches.je_men_occupe_plus') : t('taches.je_men_occupe')}
                  </button>
                ) : (
                  <span>{t('taches.assignee_a', { nom: tache.assignee_name ?? '' })}</span>
                )}
                <select
                  aria-label={t('taches.designer')}
                  value=""
                  onChange={(e) => {
                    if (e.target.value !== '') agir(assigner(groupId, tache.id, e.target.value));
                  }}
                >
                  <option value="">{t('taches.designer')}</option>
                  {actifs.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.display_name}
                    </option>
                  ))}
                </select>
                <button type="button" aria-label={`${t('taches.supprimer')} ${tache.title}`} onClick={() => setASupprimer(tache)}>
                  {t('liste.croix')}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <form className="ajout-rapide" onSubmit={ajouter}>
        <input type="text" value={titre} maxLength={140} enterKeyHint="send" autoComplete="off" aria-label={t('taches.nouvelle')} placeholder={t('taches.nouvelle')} onChange={(e) => setTitre(e.target.value)} />
        <button type="submit" disabled={ajout.enCours} onPointerDown={(e) => e.preventDefault()}>
          {ajout.enCours ? t('commun.envoi') : t('taches.ajouter')}
        </button>
      </form>

      <h3>{t('listes.de_levenement')}</h3>
      {listes.length === 0 && <p>{t('listes.aucune')}</p>}
      <ul>
        {listes.map((l) => (
          <li key={l.id}>
            <a href={lienListe(groupId, l.id)}>{l.title}</a> <span className="discret">{t('liste.progression', { faits: String(l.articles_faits), total: String(l.articles_total) })}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={creationListe.enCours}
        onClick={() =>
          creationListe
            .lancer(() =>
              creerListe(groupId, t('listes.titre_evenement', { titre: titreEvenement }).slice(0, 120), evenementId).then((l) => {
                window.location.hash = lienListe(groupId, l.id);
              }),
            )
            .catch((err: unknown) => setErreur(messageDe(err)))
        }
      >
        {creationListe.enCours ? t('commun.creation') : t('listes.creer_pour_evenement')}
      </button>
      <DialogueConfirmation
        ouvert={aSupprimer !== null}
        titre={t('confirm.taches.supprimer.titre', { titre: aSupprimer?.title ?? '' })}
        consequence={t('confirm.taches.supprimer.consequence')}
        reversible={false}
        libelleConfirmer={t('confirm.taches.supprimer.action')}
        danger
        onConfirmer={() => {
          const cible = aSupprimer;
          setASupprimer(null);
          if (cible === null) return;
          setErreur(null);
          suppression
            .lancer(() => supprimerTache(groupId, cible.id).then(recharger))
            .catch((err: unknown) => {
              setErreur(messageDe(err));
              recharger();
            });
        }}
        onAnnuler={() => setASupprimer(null)}
      />
    </>
  );
}
