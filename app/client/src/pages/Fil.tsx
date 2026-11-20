import { listerFils, type Fil as FilType } from '../api/fils';
import { ChargementPage } from '../components/ChargementPage';
import { EnteteGroupe } from '../components/EnteteGroupe';
import { Erreur } from '../components/Erreur';
import { FilDiscussion } from '../components/FilDiscussion';
import { useLecture } from '../hooks/useLecture';
import { t, texteErreur } from '../i18n';

/** Page dédiée à un fil de discussion libre. */
export function Fil({ groupId, filId }: { groupId: string; filId: string }) {
  // Il n'existe pas de route « un seul fil » : on lit la liste du groupe (déjà cloisonnée) et on y cherche le fil.
  // `null` = lecture réussie mais fil absent, distinct de l'état `chargement` / `erreur`.
  const { donnees: trouve, etat, erreur, recharger } = useLecture<FilType | null>(
    () => listerFils(groupId).then((liste) => liste.find((f) => f.id === filId) ?? null),
    [groupId, filId],
  );

  const titre = trouve === null ? t('fil.titre_defaut') : (trouve.title ?? trouve.event_title ?? t('fil.titre_defaut'));
  const retour = `#/groupe/${encodeURIComponent(groupId)}/fils`;

  return (
    <section className="page-groupe-pile">
      <EnteteGroupe
        ongletActif="fils"
        titre={titre}
        lienRetour={{ href: retour, libelle: t('fil.retour_fils') }}
      />
      <ChargementPage etat={etat} erreur={erreur} onReessayer={recharger}>
        {trouve === null ? (
          <div className="carte">
            <Erreur message={texteErreur('fil.introuvable')} />
            <a href={retour}>{t('fil.retour_fils')}</a>
          </div>
        ) : (
          <div className="carte">
            <FilDiscussion key={`${groupId}/${filId}`} groupId={groupId} filId={filId} />
          </div>
        )}
      </ChargementPage>
    </section>
  );
}
