import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
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
import { EnteteGroupe } from '../components/EnteteGroupe';
import { Erreur, messageDe } from '../components/Erreur';
import { IconePoubelle } from '../components/Icones';
import { t } from '../i18n';

/**
 * Une liste de courses ou de tâches : barre d'ajout rapide en haut, éléments à faire en premier et cochés regroupés en dessous,
 * attribution en un clic et synchronisation temps réel.
 */
export function Liste({ groupId, listeId }: { groupId: string; listeId: string }) {
  const [liste, setListe] = useState<DetailListe | null>(null);
  const [moi, setMoi] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [disparue, setDisparue] = useState(false);
  const [flux, setFlux] = useState<EtatFlux>('reconnexion');
  const [reordonner, setReordonner] = useState(false);
  const [saisie, setSaisie] = useState('');
  const [quantite, setQuantite] = useState('');
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

  useTempsReel(groupId, {
    onOuvert: recharger,
    onEtat: setFlux,
    onEvenement: (e) => {
      if (e.id === listeId || e.parent_id === listeId) planifier();
    },
  });

  const remplacer = (a: Article): void =>
    setListe((l) => (l === null ? l : { ...l, articles: l.articles.map((x) => (x.id === a.id ? a : x)) }));

  const echec = (err: unknown): void => {
    setErreur(
      err instanceof ErreurApi && err.cle === 'article.deja_pris'
        ? t('liste.deja_pris_par', { nom: nomDuGagnant(err.donnees, 'pris_par') ?? t('liste.quelquun') })
        : messageDe(err),
    );
    recharger();
  };

  const cocher = (a: Article): void => {
    remplacer({ ...a, is_done: !a.is_done });
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
    const qte = quantite.trim() === '' ? null : quantite.trim();
    setSaisie('');
    setQuantite('');
    champSaisie.current?.focus();
    ajouterArticle(groupId, listeId, label, qte)
      .then((a) =>
        setListe((l) => (l === null || l.articles.some((x) => x.id === a.id) ? l : { ...l, articles: [...l.articles, a] })),
      )
      .catch(echec);
  };

  const retirer = (a: Article): void => {
    setListe((l) => (l === null ? l : { ...l, articles: l.articles.filter((x) => x.id !== a.id) }));
    retirerArticle(groupId, listeId, a.id).catch(echec);
  };

  const retourListes = `#/groupe/${encodeURIComponent(groupId)}/listes`;
  if (disparue) {
    return (
      <section className="page-groupe-pile">
        <EnteteGroupe
          groupId={groupId}
          ongletActif="listes"
          lienRetour={{ href: retourListes, libelle: t('liste.retour') }}
        />
        <div className="carte">
          <p role="status">{t('liste.disparue')}</p>
        </div>
      </section>
    );
  }
  if (liste === null) return <Erreur message={erreur} />;

  const aFaire = liste.articles.filter((a) => !a.is_done);
  const coches = liste.articles.filter((a) => a.is_done);

  const rendreLigne = (a: Article, indexGlobal: number): ReactNode => {
    const aMoi = a.claimed_by_membership_id !== null && a.claimed_by_membership_id === moi;
    const prisParAutre = a.claimed_by_membership_id !== null && !aMoi;

    return (
      <li key={a.id} className={`article${a.is_done ? ' article-fait' : ''}`}>
        <label className="article-case">
          <input type="checkbox" checked={a.is_done} onChange={() => cocher(a)} />
          <span className="article-libelle">{a.label}</span>
          {a.quantity !== null && <span className="pilule pilule-quantite">{a.quantity}</span>}
        </label>

        {reordonner ? (
          <span className="article-actions">
            <button
              type="button"
              className="bouton-compact"
              disabled={indexGlobal === 0}
              aria-label={t('liste.monter')}
              onClick={() => deplacer(a, -1)}
            >
              {t('liste.fleche_haut')}
            </button>
            <button
              type="button"
              className="bouton-compact"
              disabled={indexGlobal === liste.articles.length - 1}
              aria-label={t('liste.descendre')}
              onClick={() => deplacer(a, 1)}
            >
              {t('liste.fleche_bas')}
            </button>
            <button
              type="button"
              className="bouton-compact bouton-danger-discret"
              aria-label={t('liste.retirer')}
              onClick={() => retirer(a)}
            >
              <IconePoubelle className="icone-mini" />
            </button>
          </span>
        ) : (
          <span className="article-actions">
            {a.claimed_by_membership_id === null ? (
              <span className="pilule pilule-statut-aucun pilule-attrib-discret">{t('liste.attrib_libre')}</span>
            ) : aMoi ? (
              <span className="pilule pilule-statut-yes">{t('liste.attrib_moi')}</span>
            ) : (
              <span className="pilule">{a.claimed_by_name ?? t('liste.quelquun')}</span>
            )}
            <button
              type="button"
              className="bouton-compact"
              aria-pressed={aMoi}
              disabled={prisParAutre || moi === null}
              onClick={() => prendre(a)}
            >
              {aMoi ? t('liste.liberer') : t('liste.je_prends')}
            </button>
            <button
              type="button"
              className="bouton-icone-discret"
              aria-label={t('liste.retirer')}
              onClick={() => retirer(a)}
            >
              <IconePoubelle className="icone-mini" />
            </button>
          </span>
        )}
      </li>
    );
  };

  return (
    <section className="page-groupe-pile liste-courses">
      <EnteteGroupe
        groupId={groupId}
        ongletActif="listes"
        titre={liste.title}
        lienRetour={{ href: retourListes, libelle: t('liste.retour') }}
        meta={
          <>
            <span className="pilule">
              {t('liste.progression', { faits: String(coches.length), total: String(liste.articles.length) })}
            </span>
            {flux === 'reconnexion' && <span className="pilule pilule-statut-maybe">{t('liste.reconnexion')}</span>}
          </>
        }
        actions={
          <div className="barre-compacte">
            <button type="button" className="bouton-compact" aria-pressed={reordonner} onClick={() => setReordonner(!reordonner)}>
              {t('liste.reordonner')}
            </button>
            <button
              type="button"
              className="bouton-compact"
              onClick={() => {
                const titre = window.prompt(t('liste.renommer_invite'), liste.title);
                if (titre !== null && titre.trim() !== '') renommerListe(groupId, listeId, titre.trim()).then(setListe).catch(echec);
              }}
            >
              {t('liste.renommer')}
            </button>
            <button
              type="button"
              className="bouton-compact bouton-danger-discret"
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
        }
      />

      <Erreur message={erreur} />

      <form className="carte barre-ajout-article" onSubmit={ajouter}>
        <input
          ref={champSaisie}
          type="text"
          className="champ-article-nom"
          value={saisie}
          maxLength={120}
          enterKeyHint="send"
          autoComplete="off"
          aria-label={t('liste.nouvel_article')}
          placeholder={t('liste.nouvel_article')}
          onChange={(e) => setSaisie(e.target.value)}
        />
        <input
          type="text"
          className="champ-article-quantite"
          value={quantite}
          maxLength={40}
          autoComplete="off"
          aria-label={t('liste.quantite_label')}
          placeholder={t('liste.quantite_champ')}
          onChange={(e) => setQuantite(e.target.value)}
        />
        {/* Presser le bouton ne doit pas retirer le focus du champ (sinon le clavier mobile se ferme). */}
        <button type="submit" onPointerDown={(e) => e.preventDefault()}>
          {t('liste.ajouter_court')}
        </button>
      </form>

      {liste.articles.length === 0 ? (
        <div className="carte">
          <p className="discret">{t('liste.vide')}</p>
        </div>
      ) : reordonner ? (
        <div className="carte">
          <ul className="articles">{liste.articles.map((a, i) => rendreLigne(a, i))}</ul>
        </div>
      ) : (
        <>
          {aFaire.length > 0 && (
            <div className="carte">
              <div className="carte-entete">
                <h3>{t('liste.section_a_faire', { n: String(aFaire.length) })}</h3>
              </div>
              <ul className="articles">{aFaire.map((a, i) => rendreLigne(a, i))}</ul>
            </div>
          )}

          {coches.length > 0 && (
            <div className="carte carte-coches">
              <div className="carte-entete">
                <h3 className="discret">{t('liste.section_coches', { n: String(coches.length) })}</h3>
              </div>
              <ul className="articles">{coches.map((a, i) => rendreLigne(a, i))}</ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
