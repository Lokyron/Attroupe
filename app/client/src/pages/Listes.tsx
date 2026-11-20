import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { creerListe, listerListes, type ResumeListe, type TypeListe } from '../api/listes';
import { useRechargement } from '../api/rechargement';
import { useGroupe, useTempsReelGroupe } from '../components/FournisseurGroupe';
import { BarreAjout } from '../components/BarreAjout';
import { ChargementPage } from '../components/ChargementPage';
import { EnteteGroupe } from '../components/EnteteGroupe';
import { Erreur, messageDe } from '../components/Erreur';
import { GrilleCartes } from '../components/GrilleCartes';
import { IconeListe } from '../components/Icones';
import { premiereErreur } from '../hooks/etatsLecture';
import { useLecture } from '../hooks/useLecture';
import { useSoumission } from '../hooks/useSoumission';
import { t } from '../i18n';
import { lienListe } from '../lib/liens';

function extraireTypeListe(l: ResumeListe): { readonly cleType: string; readonly titrePropre: string } {
  if (l.event_id !== null) {
    return { cleType: t('listes.badge_evenement'), titrePropre: l.title };
  }
  if (l.kind === 'affaires') {
    return { cleType: t('listes.type_affaires'), titrePropre: l.title };
  }
  if (l.kind === 'taches') {
    return { cleType: t('listes.type_taches'), titrePropre: l.title };
  }
  return { cleType: t('listes.type_courses'), titrePropre: l.title };
}

/** Les listes de courses du groupe, avec leur avancement. Elles se mettent à jour d'elles-mêmes (flux temps réel). */
export function Listes({ groupId }: { groupId: string }) {
  // Lecture initiale (trois états) ; `listes` en est la copie locale, rafraîchie par le temps réel sans repasser par le squelette.
  const lecture = useLecture(() => listerListes(groupId), [groupId]);
  const [source, setSource] = useState(lecture.donnees);
  const [listes, setListes] = useState<ResumeListe[] | null>(lecture.donnees);
  if (source !== lecture.donnees) {
    setSource(lecture.donnees);
    setListes(lecture.donnees);
  }
  const { erreur: erreurGroupe } = useGroupe();
  const { enCours, lancer } = useSoumission();
  const champTitre = useRef<HTMLInputElement>(null);
  const [titre, setTitre] = useState('');
  const [typeListe, setTypeListe] = useState<TypeListe>('courses');
  const [erreur, setErreur] = useState<string | null>(null);

  const { recharger, planifier } = useRechargement(
    () => listerListes(groupId),
    setListes,
    (err) => setErreur(messageDe(err)),
  );
  useTempsReelGroupe({
    onOuvert: recharger,
    onEvenement: (e) => {
      if (e.ressource === 'liste' || e.ressource === 'article') planifier();
    },
  });

  const creer = (evt: FormEvent): void => {
    evt.preventDefault();
    const net = titre.trim();
    if (net === '') return;
    lancer(() =>
      creerListe(groupId, net, null, typeListe).then((l) => {
        window.location.hash = lienListe(groupId, l.id);
      }),
    ).catch((err: unknown) => setErreur(messageDe(err)));
  };

  return (
    <section className="page-groupe-pile">
      <EnteteGroupe ongletActif="listes" titre={t('listes.titre')} />
      <Erreur message={premiereErreur(erreur, erreurGroupe)} />

      <BarreAjout
        onSubmit={creer}
        libelleBouton={enCours ? t('commun.creation') : t('listes.creer_court')}
        desactive={titre.trim() === '' || enCours}
      >
        <input
          ref={champTitre}
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
      </BarreAjout>

      <ChargementPage etat={lecture.etat} erreur={lecture.erreur} onReessayer={lecture.recharger}>
        {listes !== null && listes.length === 0 ? (
          <div className="carte">
            <div className="etat-vide">
              <p>{t('listes.aucune')}</p>
              <button type="button" onClick={() => champTitre.current?.focus()}>
                {t('listes.creer')}
              </button>
            </div>
          </div>
        ) : (
          <GrilleCartes
            elements={listes ?? []}
            cle={(l) => l.id}
            rendu={(l) => {
              const { cleType, titrePropre } = extraireTypeListe(l);
              const pct = l.articles_total === 0 ? 0 : Math.round((l.articles_faits / l.articles_total) * 100);
              return (
                <a className="carte carte-lien-module" href={lienListe(groupId, l.id)}>
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
            }}
          />
        )}
      </ChargementPage>
    </section>
  );
}
