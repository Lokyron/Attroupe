import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { creerListe, listerListes, type ResumeListe } from '../api/listes';
import { useRechargement } from '../api/rechargement';
import { useTempsReel } from '../api/tempsReel';
import { Erreur, messageDe } from '../components/Erreur';
import { t } from '../i18n';

export const lienListe = (groupId: string, listeId: string): string => `#/groupe/${encodeURIComponent(groupId)}/liste/${encodeURIComponent(listeId)}`;

/** Les listes de courses du groupe, avec leur avancement. Elles se mettent à jour d'elles-mêmes (flux temps réel). */
export function Listes({ groupId }: { groupId: string }) {
  const [listes, setListes] = useState<ResumeListe[] | null>(null);
  const [titre, setTitre] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);

  const { recharger, planifier } = useRechargement(
    () => listerListes(groupId),
    setListes,
    (err) => setErreur(messageDe(err)),
  );
  useEffect(recharger, [recharger]);
  useTempsReel(groupId, {
    onOuvert: recharger,
    onEvenement: (e) => {
      if (e.ressource === 'liste' || e.ressource === 'article') planifier();
    },
  });

  const creer = (evt: FormEvent): void => {
    evt.preventDefault();
    if (titre.trim() === '') return;
    creerListe(groupId, titre.trim(), null)
      .then((l) => {
        window.location.hash = lienListe(groupId, l.id);
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  return (
    <section>
      <p>
        <a href={`#/groupe/${encodeURIComponent(groupId)}`}>{t('listes.retour_groupe')}</a>
      </p>
      <h2>{t('listes.titre')}</h2>
      <Erreur message={erreur} />
      {listes !== null && listes.length === 0 && <p>{t('listes.aucune')}</p>}
      <ul className="jours">
        {(listes ?? []).map((l) => (
          <li key={l.id}>
            <a className="evenement" href={lienListe(groupId, l.id)}>
              {l.title} <span className="discret">{t('liste.progression', { faits: String(l.articles_faits), total: String(l.articles_total) })}</span>
            </a>
          </li>
        ))}
      </ul>
      <form className="formulaire" onSubmit={creer}>
        <label>
          {t('listes.nouvelle')}
          <input type="text" value={titre} maxLength={120} onChange={(e) => setTitre(e.target.value)} />
        </label>
        <button type="submit" disabled={titre.trim() === ''}>
          {t('listes.creer')}
        </button>
      </form>
    </section>
  );
}
