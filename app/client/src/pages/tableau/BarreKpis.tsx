import { IconeBalance, IconeCalendrier, IconeCamera, IconeGroupes } from '../../components/Icones';
import { t } from '../../i18n';
import { cleAccord } from '../../lib/pluriel';
import { formaterDateRelative, formaterMontant } from './formats';
import { lienElementCalendrier, type ElementCalendrier, type ResumeSoldes } from './selecteurs';

/** Les quatre tuiles d'en-tête : prochain événement, balance, groupes actifs, médias. */
export function BarreKpis({
  prochainEvenement,
  jourActuel,
  groupeCibleId,
  resumeSoldes,
  groupeDepensesId,
  nbGroupes,
  invitationsEnAttente,
  nbEvenementsMois,
  nbPhotos,
  titrePremierAlbum,
  groupePhotosId,
}: {
  prochainEvenement: ElementCalendrier | null;
  jourActuel: string;
  groupeCibleId: string | null;
  resumeSoldes: ResumeSoldes;
  groupeDepensesId: string;
  nbGroupes: number;
  invitationsEnAttente: number;
  nbEvenementsMois: number;
  nbPhotos: number;
  titrePremierAlbum: string | null;
  groupePhotosId: string | null;
}) {
  // Sans événement à venir ni groupe ciblé, la tuile n'a nulle part où mener : elle n'est alors pas un lien.
  const hrefTuileProchain =
    prochainEvenement !== null
      ? lienElementCalendrier(prochainEvenement)
      : groupeCibleId !== null
        ? `#/groupe/${encodeURIComponent(groupeCibleId)}/evenement-nouveau`
        : null;
  const contenuTuileProchain = (
    <>
      <div className="kpi-texte">
        <span className="kpi-etiquette">{t('tableau.kpi_prochain_event')}</span>
        <strong className="kpi-valeur">
          {prochainEvenement !== null ? prochainEvenement.title : t('tableau.kpi_aucun_event')}
        </strong>
        <span className="kpi-sous kpi-indigo">
          {prochainEvenement !== null
            ? formaterDateRelative(prochainEvenement, jourActuel)
            : t('tableau.kpi_planifier')}
        </span>
      </div>
      <span className="kpi-icone-badge kpi-badge-indigo" aria-hidden="true">
        <IconeCalendrier className="kpi-icone" />
      </span>
    </>
  );

  const { sens, devises, total } = resumeSoldes;
  const classeBalance = sens === 'positif' ? 'kpi-positif' : sens === 'negatif' ? 'kpi-negatif' : 'kpi-neutre';
  const premiereDevise = devises[0];
  const libelleBalance =
    sens === 'aucun' || premiereDevise === undefined
      ? formaterMontant(0, 'EUR')
      : sens === 'multi'
        ? devises.map(([dev, val]) => formaterMontant(val, dev, true)).join(' · ')
        : formaterMontant(total, premiereDevise[0], true);
  const sousTitreBalance =
    sens === 'multi'
      ? t('tableau.kpi_multi_devises', { n: String(devises.length) })
      : sens === 'positif'
        ? t('tableau.kpi_on_vous_doit')
        : sens === 'negatif'
          ? t('tableau.kpi_a_equilibrer')
          : t('tableau.kpi_a_lequilibre');

  return (
    <section className="barre-kpis" aria-label={t('tableau.vue_ensemble')}>
      {hrefTuileProchain !== null ? (
        <a href={hrefTuileProchain} className="carte kpi-tuile">
          {contenuTuileProchain}
        </a>
      ) : (
        <div className="carte kpi-tuile">{contenuTuileProchain}</div>
      )}

      <a
        href={groupeDepensesId !== '' ? `#/groupe/${encodeURIComponent(groupeDepensesId)}/depenses` : '#/nouveau'}
        className="carte kpi-tuile"
      >
        <div className="kpi-texte">
          <span className="kpi-etiquette">{t('tableau.kpi_balance')}</span>
          <strong className={`kpi-valeur ${classeBalance}`}>{libelleBalance}</strong>
          <span className="kpi-sous">{sousTitreBalance}</span>
        </div>
        <span className="kpi-icone-badge kpi-badge-emeraude" aria-hidden="true">
          <IconeBalance className="kpi-icone" />
        </span>
      </a>

      <a href={invitationsEnAttente > 0 ? '#/invitations' : '#/nouveau'} className="carte kpi-tuile">
        <div className="kpi-texte">
          <span className="kpi-etiquette">{t('tableau.kpi_groupes_actifs')}</span>
          <strong className="kpi-valeur">
            {t(nbGroupes <= 1 ? 'tableau.kpi_n_groupes_singulier' : 'tableau.kpi_n_groupes_pluriel', {
              n: String(nbGroupes),
            })}
          </strong>
          <span className="kpi-sous kpi-ambre">
            {invitationsEnAttente > 0
              ? t(cleAccord('tableau.kpi_invitations_attente', invitationsEnAttente), { n: String(invitationsEnAttente) })
              : t(cleAccord('tableau.kpi_evenements_mois', nbEvenementsMois), { n: String(nbEvenementsMois) })}
          </span>
        </div>
        <span className="kpi-icone-badge kpi-badge-ambre" aria-hidden="true">
          <IconeGroupes className="kpi-icone" />
        </span>
      </a>

      <a
        href={groupePhotosId !== null ? `#/groupe/${encodeURIComponent(groupePhotosId)}/albums` : '#/nouveau'}
        className="carte kpi-tuile"
      >
        <div className="kpi-texte">
          <span className="kpi-etiquette">{t('tableau.kpi_medias')}</span>
          <strong className="kpi-valeur">
            {t(nbPhotos <= 1 ? 'tableau.kpi_n_photos_singulier' : 'tableau.kpi_n_photos_pluriel', {
              n: String(nbPhotos),
            })}
          </strong>
          <span className="kpi-sous kpi-rose">{titrePremierAlbum ?? t('tableau.kpi_aucun_album')}</span>
        </div>
        <span className="kpi-icone-badge kpi-badge-rose" aria-hidden="true">
          <IconeCamera className="kpi-icone" />
        </span>
      </a>
    </section>
  );
}
