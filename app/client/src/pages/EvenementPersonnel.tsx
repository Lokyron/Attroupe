import { lireCreneauPersonnel } from '../api/agenda-personnel';
import { libelleDateHoraire } from '../agenda/format';
import { ChargementPage, SqueletteCarte } from '../components/ChargementPage';
import { IconeCalendrier, IconeLieu, IconeRetour } from '../components/Icones';
import { TexteAvecLiens } from '../components/TexteAvecLiens';
import { useLecture } from '../hooks/useLecture';
import { t } from '../i18n';

/**
 * Page d'un événement PERSONNEL (`#/agenda/:creneauId`), lue sur `GET /api/moi/agenda/:creneauId` : le serveur ne rend que les
 * créneaux du compte connecté, un autre identifiant donne un 404. Lecture seule : l'édition et le partage restent dans « Mon compte ».
 */
export function EvenementPersonnel({ creneauId }: { creneauId: string }) {
  const { donnees: creneau, etat, erreur, recharger } = useLecture(() => lireCreneauPersonnel(creneauId), [creneauId]);

  return (
    <section className="page-pile">
      <a href="#/compte" className="groupe-retour-lien">
        <IconeRetour className="icone-mini" />
        <span>{t('agenda_perso.retour')}</span>
      </a>
      <ChargementPage etat={etat} erreur={erreur} onReessayer={recharger} squelette={<SqueletteCarte />}>
        {creneau !== null && (
          <article className="carte page-pile">
            <h2>{creneau.title === '' ? t('agenda_perso.sans_titre') : creneau.title}</h2>
            <p className="groupe-meta">
              <span className="pilule">
                <IconeCalendrier className="icone-mini" />
                <time dateTime={creneau.starts_at}>{libelleDateHoraire(creneau)}</time>
              </span>
              {!creneau.all_day && <span className="discret ligne-meta">{t('agenda.heure_de', { fuseau: creneau.time_zone })}</span>}
            </p>
            {creneau.location_name !== null && (
              <p>
                <IconeLieu className="icone-mini" /> <strong>{t('agenda_perso.lieu')}</strong>
                {t('commun.separateur_tiret')}
                {creneau.location_name}
              </p>
            )}
            {creneau.description !== null && (
              <div>
                <h3>{t('agenda_perso.description')}</h3>
                <TexteAvecLiens texte={creneau.description} />
              </div>
            )}
            <p className="discret">
              <strong>{t('agenda_perso.source')}</strong>
              {t('commun.separateur_tiret')}
              {creneau.calendar_source_id === null ? t('agenda_perso.source_manuelle') : t('agenda_perso.source_importee')}
            </p>
          </article>
        )}
      </ChargementPage>
    </section>
  );
}
