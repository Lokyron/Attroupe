import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ErreurApi } from '../api/client';
import { lireGroupe } from '../api/groupes';
import {
  ajouterArticle,
  definirFait,
  definirPreneur,
  deplacerArticle,
  lireListe,
  nomDuGagnant,
  renommerListe,
  retirerArticle,
  supprimerListe,
  type Article,
  type DetailListe,
} from '../api/listes';
import { useRechargement } from '../api/rechargement';
import { useTempsReel, type EtatFlux } from '../api/tempsReel';
import { Erreur, messageDe } from '../components/Erreur';
import { t } from '../i18n';

/**
 * Une liste de courses, pensée debout dans un magasin, à une main : cases larges, « je le prends » à portée du pouce, ajout rapide en bas
 * de l'écran (le champ garde le focus : on enchaîne les articles sans le retoucher). Les changements des autres arrivent par le flux.
 */
export function Liste({ groupId, listeId }: { groupId: string; listeId: string }) {
  const [liste, setListe] = useState<DetailListe | null>(null);
  const [moi, setMoi] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [disparue, setDisparue] = useState(false);
  const [flux, setFlux] = useState<EtatFlux>('reconnexion');
  const [reordonner, setReordonner] = useState(false);
  const [saisie, setSaisie] = useState('');
  const champSaisie = useRef<HTMLInputElement>(null);
  const { recharger, planifier } = useRechargement(
    () => lireListe(groupId, listeId),
    (lue) => {
      setListe(lue);
      setErreur(null);
    },
    (err) => {
      if (err instanceof ErreurApi && err.statut === 404) setDisparue(true);
      else setErreur(messageDe(err));
    },
  );

  useEffect(() => {
    recharger();
    lireGroupe(groupId)
      .then((g) => setMoi(g.mon_appartenance_id))
      .catch((err: unknown) => setErreur(messageDe(err)));
  }, [groupId, recharger]);

  // Chaque (re)connexion recharge tout : des changements ont pu passer pendant la coupure, le serveur ne rejoue rien.
  useTempsReel(groupId, {
    onOuvert: recharger,
    onEtat: setFlux,
    onEvenement: (e) => {
      if (e.id === listeId || e.parent_id === listeId) planifier();
    },
  });

  const remplacer = (a: Article): void => setListe((l) => (l === null ? l : { ...l, articles: l.articles.map((x) => (x.id === a.id ? a : x)) }));
  const echec = (err: unknown): void => {
    // Course perdue (409) : on nomme le gagnant, puis on recharge pour afficher l'état réel.
    setErreur(err instanceof ErreurApi && err.cle === 'article.deja_pris' ? t('liste.deja_pris_par', { nom: nomDuGagnant(err.donnees, 'pris_par') ?? t('liste.quelquun') }) : messageDe(err));
    recharger();
  };

  const cocher = (a: Article): void => {
    remplacer({ ...a, is_done: !a.is_done }); // optimiste : la case répond au toucher sans attendre le réseau
    definirFait(groupId, listeId, a.id, !a.is_done).then(remplacer).catch(echec);
  };

  const prendre = (a: Article): void => {
    const aMoi = a.claimed_by_membership_id === moi;
    definirPreneur(groupId, listeId, a.id, !aMoi).then(remplacer).catch(echec);
  };

  const deplacer = (a: Article, sens: -1 | 1): void => {
    if (liste === null) return;
    const autres = liste.articles.filter((x) => x.id !== a.id);
    const rang = liste.articles.indexOf(a) + sens;
    if (rang < 0 || rang > autres.length) return;
    setListe({ ...liste, articles: [...autres.slice(0, rang), a, ...autres.slice(rang)] });
    deplacerArticle(groupId, listeId, a.id, rang === 0 ? null : (autres[rang - 1]?.id ?? null)).catch(echec);
  };

  const ajouter = (evt: FormEvent): void => {
    evt.preventDefault();
    const label = saisie.trim();
    if (label === '') return;
    setSaisie('');
    champSaisie.current?.focus(); // le champ garde le focus : on enchaîne les articles
    ajouterArticle(groupId, listeId, label)
      .then((a) => setListe((l) => (l === null || l.articles.some((x) => x.id === a.id) ? l : { ...l, articles: [...l.articles, a] })))
      .catch(echec);
  };

  const retirer = (a: Article): void => {
    setListe((l) => (l === null ? l : { ...l, articles: l.articles.filter((x) => x.id !== a.id) }));
    retirerArticle(groupId, listeId, a.id).catch(echec);
  };

  const retourListes = `#/groupe/${encodeURIComponent(groupId)}/listes`;
  if (disparue) {
    return (
      <section>
        <p role="status">{t('liste.disparue')}</p>
        <a href={retourListes}>{t('liste.retour')}</a>
      </section>
    );
  }
  if (liste === null) return <Erreur message={erreur} />;
  const faits = liste.articles.filter((a) => a.is_done).length;

  return (
    <section className="liste-courses">
      <p>
        <a href={retourListes}>{t('liste.retour')}</a>
      </p>
      <h2>{liste.title}</h2>
      <p className="discret">
        {t('liste.progression', { faits: String(faits), total: String(liste.articles.length) })}
        {flux === 'reconnexion' && ` — ${t('liste.reconnexion')}`}
      </p>
      <Erreur message={erreur} />
      <div className="barre">
        <button type="button" aria-pressed={reordonner} onClick={() => setReordonner(!reordonner)}>
          {t('liste.reordonner')}
        </button>
        <button
          type="button"
          onClick={() => {
            const titre = window.prompt(t('liste.renommer_invite'), liste.title);
            if (titre !== null && titre.trim() !== '') renommerListe(groupId, listeId, titre.trim()).then(setListe).catch(echec);
          }}
        >
          {t('liste.renommer')}
        </button>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(t('liste.supprimer_confirmation'))) {
              supprimerListe(groupId, listeId)
                .then(() => {
                  window.location.hash = retourListes;
                })
                .catch(echec);
            }
          }}
        >
          {t('liste.supprimer')}
        </button>
      </div>

      {liste.articles.length === 0 && <p>{t('liste.vide')}</p>}
      <ul className="articles">
        {liste.articles.map((a, i) => {
          const aMoi = a.claimed_by_membership_id !== null && a.claimed_by_membership_id === moi;
          const prisParAutre = a.claimed_by_membership_id !== null && !aMoi;
          return (
            <li key={a.id} className={`article${a.is_done ? ' article-fait' : ''}`}>
              <label className="article-case">
                <input type="checkbox" checked={a.is_done} onChange={() => cocher(a)} />
                <span className="article-libelle">
                  {a.label}
                  {a.quantity !== null && <span className="discret">{t('liste.quantite', { quantite: a.quantity })}</span>}
                </span>
              </label>
              {reordonner ? (
                <span className="article-actions">
                  <button type="button" disabled={i === 0} aria-label={t('liste.monter')} onClick={() => deplacer(a, -1)}>
                    {t('liste.fleche_haut')}
                  </button>
                  <button type="button" disabled={i === liste.articles.length - 1} aria-label={t('liste.descendre')} onClick={() => deplacer(a, 1)}>
                    {t('liste.fleche_bas')}
                  </button>
                  <button type="button" aria-label={t('liste.retirer')} onClick={() => retirer(a)}>
                    {t('liste.croix')}
                  </button>
                </span>
              ) : (
                <button type="button" className="article-preneur" aria-pressed={aMoi} disabled={prisParAutre || moi === null} onClick={() => prendre(a)}>
                  {a.claimed_by_membership_id === null
                    ? t('liste.je_le_prends')
                    : aMoi
                      ? t('liste.je_lai_pris')
                      : t('liste.pris_par', { nom: a.claimed_by_name ?? t('liste.quelquun') })}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <form className="ajout-rapide" onSubmit={ajouter}>
        <input
          ref={champSaisie}
          type="text"
          value={saisie}
          maxLength={120}
          enterKeyHint="send"
          autoComplete="off"
          aria-label={t('liste.nouvel_article')}
          placeholder={t('liste.nouvel_article')}
          onChange={(e) => setSaisie(e.target.value)}
        />
        {/* Presser le bouton ne doit pas retirer le focus du champ (sinon le clavier se ferme à chaque article). */}
        <button type="submit" onPointerDown={(e) => e.preventDefault()}>
          {t('liste.ajouter')}
        </button>
      </form>
    </section>
  );
}
