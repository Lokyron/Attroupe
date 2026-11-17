import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { creerListe, listerListes, type ResumeListe } from '../api/listes';
import { useRechargement } from '../api/rechargement';
import { useTempsReel } from '../api/tempsReel';
import { EnteteGroupe } from '../components/EnteteGroupe';
import { Erreur, messageDe } from '../components/Erreur';
import { IconeListe } from '../components/Icones';
import { t } from '../i18n';

export const lienListe = (groupId: string, listeId: string): string => `#/groupe/${encodeURIComponent(groupId)}/liste/${encodeURIComponent(listeId)}`;

type TypeListe = 'courses' | 'affaires' | 'taches';

function extraireTypeListe(l: ResumeListe): { readonly cleType: string; readonly titrePropre: string } {
  if (l.event_id !== null) {
    return { cleType: t('listes.badge_evenement'), titrePropre: l.title };
  }
  const prefixAffaires = `${t('listes.type_affaires')} : `;
  if (l.title.startsWith(prefixAffaires)) {
    return { cleType: t('listes.type_affaires'), titrePropre: l.title.slice(prefixAffaires.length) };
  }
  const prefixTaches = `${t('listes.type_taches')} : `;
  if (l.title.startsWith(prefixTaches)) {
    return { cleType: t('listes.type_taches'), titrePropre: l.title.slice(prefixTaches.length) };
  }
  return { cleType: t('listes.type_courses'), titrePropre: l.title };
}

/** Les listes de courses du groupe, avec leur avancement. Elles se mettent à jour d'elles-mêmes (flux temps réel). */
export function Listes({ groupId }: { groupId: string }) {
  const [listes, setListes] = useState<ResumeListe[] | null>(null);
  const [titre, setTitre] = useState('');
  const [typeListe, setTypeListe] = useState<TypeListe>('courses');
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
    const net = titre.trim();
    if (net === '') return;
    const prefixe =
      typeListe === 'affaires'
        ? `${t('listes.type_affaires')} : `
        : typeListe === 'taches'
          ? `${t('listes.type_taches')} : `
          : '';
    const titreComplet = `${prefixe}${net}`.slice(0, 120);
    creerListe(groupId, titreComplet, null)
      .then((l) => {
        window.location.hash = lienListe(groupId, l.id);
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  return (
    <section className="page-groupe-pile">
      <EnteteGroupe groupId={groupId} ongletActif="listes" titre={t('listes.titre')} />
      <Erreur message={erreur} />

      <form className="carte barre-ajout-ligne" onSubmit={creer}>
        <input
          type="text"
          value={titre}
          maxLength={120}
          aria-label={t('listes.nouvelle')}
          placeholder={t('listes.placeholder_nom')}
          onChange={(e) => setTitre(e.target.value)}
        />
        <select
          aria-label={t('listes.type_label')}
          value={typeListe}
          onChange={(e) => setTypeListe(e.target.value as TypeListe)}
          className="select-type-liste"
        >
          <option value="courses">{t('listes.type_courses')}</option>
          <option value="affaires">{t('listes.type_affaires')}</option>
          <option value="taches">{t('listes.type_taches')}</option>
        </select>
        <button type="submit" disabled={titre.trim() === ''}>
          {t('listes.creer_court')}
        </button>
      </form>

      {listes !== null && listes.length === 0 ? (
        <div className="carte">
          <p className="discret">{t('listes.aucune')}</p>
        </div>
      ) : (
        <div className="grille-cartes-module">
          {(listes ?? []).map((l) => {
            const { cleType, titrePropre } = extraireTypeListe(l);
            const pct = l.articles_total === 0 ? 0 : Math.round((l.articles_faits / l.articles_total) * 100);
            return (
              <a key={l.id} className="carte carte-lien-module" href={lienListe(groupId, l.id)}>
                <div className="carte-module-haut">
                  <span className="kpi-icone-badge module-icone-badge kpi-badge-emeraude">
                    <IconeListe className="icone" />
                  </span>
                  <span className="pilule">{cleType}</span>
                </div>
                <strong className="carte-module-titre">{titrePropre}</strong>
                <div className="carte-module-progression">
                  <div className="barre-progression" aria-hidden="true">
                    <div className="barre-progression-remplie" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="discret ligne-meta">
                    {t('liste.progression', { faits: String(l.articles_faits), total: String(l.articles_total) })}
                  </span>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </section>
  );
}
