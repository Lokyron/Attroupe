import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { lireGroupe, type Membre } from '../api/groupes';
import { creerListe, listerListes, type ResumeListe } from '../api/listes';
import { assigner, changerStatut, creerTache, listerTaches, supprimerTache, type Tache } from '../api/taches';
import { useRechargement } from '../api/rechargement';
import { useTempsReel } from '../api/tempsReel';
import { lienListe } from '../pages/Listes';
import { t } from '../i18n';
import { Erreur, messageDe } from './Erreur';

/**
 * Le « qui apporte quoi » d'un événement : ses tâches (avec qui s'en occupe) et ses listes de courses. Se met à jour avec le flux du groupe.
 * Le serveur reste juge : réassigner la tâche de quelqu'un d'autre est un droit, l'interface n'est qu'un confort.
 */
export function TachesEvenement({ groupId, evenementId, titreEvenement, membres }: { groupId: string; evenementId: string; titreEvenement: string; membres: Membre[] }) {
  const [taches, setTaches] = useState<Tache[]>([]);
  const [listes, setListes] = useState<ResumeListe[]>([]);
  const [moi, setMoi] = useState<string | null>(null);
  const [titre, setTitre] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);

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
  useEffect(() => {
    recharger();
    lireGroupe(groupId)
      .then((g) => setMoi(g.mon_appartenance_id))
      .catch((err: unknown) => setErreur(messageDe(err)));
  }, [groupId, recharger]);
  useTempsReel(groupId, {
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
    agir(creerTache(groupId, titre.trim(), evenementId));
    setTitre('');
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
                <button type="button" aria-label={`${t('taches.supprimer')} ${tache.title}`} onClick={() => window.confirm(t('taches.supprimer_confirmation')) && agir(supprimerTache(groupId, tache.id))}>
                  {t('liste.croix')}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <form className="ajout-rapide" onSubmit={ajouter}>
        <input type="text" value={titre} maxLength={140} enterKeyHint="send" autoComplete="off" aria-label={t('taches.nouvelle')} placeholder={t('taches.nouvelle')} onChange={(e) => setTitre(e.target.value)} />
        <button type="submit" onPointerDown={(e) => e.preventDefault()}>
          {t('taches.ajouter')}
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
        onClick={() =>
          creerListe(groupId, t('listes.titre_evenement', { titre: titreEvenement }).slice(0, 120), evenementId)
            .then((l) => {
              window.location.hash = lienListe(groupId, l.id);
            })
            .catch((err: unknown) => setErreur(messageDe(err)))
        }
      >
        {t('listes.creer_pour_evenement')}
      </button>
    </>
  );
}
