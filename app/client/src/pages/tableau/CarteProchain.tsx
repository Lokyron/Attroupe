import { IconeCalendrier, IconeLieu } from '../../components/Icones';
import { t } from '../../i18n';
import { cleStatutCompact, formaterDateEnClair } from './formats';
import { lienElementCalendrier, type CouleurGroupe, type ElementCalendrier } from './selecteurs';

/**
 * Première chose lue en ouvrant l'application : le prochain événement, en grande carte, avec l'action la plus probable.
 * Réponse attendue (événement de groupe sans réponse) : « Répondre » ; sinon « Voir l'événement ».
 * Sans événement, la carte propose de planifier (`lienCreation` : un seul groupe) ou de créer un groupe (`aucunGroupe`).
 */
export function CarteProchain({
  prochain,
  jourActuel,
  couleurParGroupe,
  lienCreation,
  aucunGroupe,
}: {
  prochain: ElementCalendrier | null;
  jourActuel: string;
  couleurParGroupe: ReadonlyMap<string, CouleurGroupe>;
  lienCreation: string | null;
  aucunGroupe: boolean;
}) {
  if (prochain === null) {
    return (
      <section className="carte carte-prochain carte-prochain-vide" aria-labelledby="prochain-titre">
        <h2 id="prochain-titre" className="prochain-etiquette">
          <IconeCalendrier className="prochain-icone" />
          <span>{t('tableau.prochain_titre')}</span>
        </h2>
        <p className="prochain-vide-texte">{aucunGroupe ? t('tableau.groupes_vide') : t('tableau.prochain_vide')}</p>
        {aucunGroupe ? (
          <a href="#/nouveau" className="bouton bouton-primaire prochain-action">
            {t('tableau.action_groupe')}
          </a>
        ) : lienCreation !== null ? (
          <a href={lienCreation} className="bouton bouton-primaire prochain-action">
            {t('tableau.prochain_planifier')}
          </a>
        ) : (
          <p className="discret">{t('tableau.prochain_vide_aide')}</p>
        )}
      </section>
    );
  }

  const reponseAttendue = prochain.sorte === 'groupe' && prochain.mon_statut === null;
  const couleur = prochain.sorte === 'perso' ? 'violet' : (couleurParGroupe.get(prochain.group_id) ?? 'indigo');
  return (
    <section className={`carte carte-prochain bordure-${couleur}`} aria-labelledby="prochain-titre">
      <h2 id="prochain-titre" className="prochain-etiquette">
        <IconeCalendrier className="prochain-icone" />
        <span>{t('tableau.prochain_titre')}</span>
      </h2>
      <p className="prochain-date">{formaterDateEnClair(prochain, jourActuel)}</p>
      <h3 className="prochain-titre">{prochain.title}</h3>
      <div className="prochain-meta">
        <span className={`pilule ${prochain.sorte === 'groupe' ? 'pilule-agenda' : 'pilule-perso'}`}>
          {prochain.sorte === 'groupe' ? prochain.group_name : t('tableau.badge_perso')}
        </span>
        {prochain.sorte === 'groupe' && !reponseAttendue && (
          <span className={`pilule pilule-statut-${prochain.mon_statut ?? 'aucun'}`}>{t(cleStatutCompact(prochain.mon_statut))}</span>
        )}
        {prochain.location_name !== null && (
          <span className="prochain-lieu">
            <IconeLieu className="icone-mini" />
            <span>{prochain.location_name}</span>
          </span>
        )}
      </div>
      <a href={lienElementCalendrier(prochain)} className="bouton bouton-primaire prochain-action">
        {reponseAttendue ? t('tableau.prochain_repondre') : t('tableau.prochain_voir')}
      </a>
    </section>
  );
}
