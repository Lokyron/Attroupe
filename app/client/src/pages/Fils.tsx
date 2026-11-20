import { useState, type FormEvent } from 'react';
import { creerFilLibre, listerFils, type Fil } from '../api/fils';
import { ChargementPage } from '../components/ChargementPage';
import { EnteteGroupe } from '../components/EnteteGroupe';
import { Erreur, messageDe } from '../components/Erreur';
import { useGroupe } from '../components/FournisseurGroupe';
import { IconeMessage } from '../components/Icones';
import { premiereErreur } from '../hooks/etatsLecture';
import { useLecture } from '../hooks/useLecture';
import { useSoumission } from '../hooks/useSoumission';
import { t } from '../i18n';

/** Liste des fils de discussion du groupe (libres et d'événements) + création d'un fil libre. */
export function Fils({ groupId }: { groupId: string }) {
  const { donnees: fils, etat, erreur: erreurLecture, recharger } = useLecture<Fil[]>(() => listerFils(groupId), [groupId]);
  const [titre, setTitre] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const { erreur: erreurGroupe } = useGroupe();
  const { enCours, lancer } = useSoumission();

  const soumettre = (e: FormEvent): void => {
    e.preventDefault();
    if (titre.trim() === '') return;
    setErreur(null);
    lancer(() =>
      creerFilLibre(groupId, titre.trim()).then((cree) => {
        setTitre('');
        window.location.hash = `#/groupe/${encodeURIComponent(groupId)}/fil/${encodeURIComponent(cree.id)}`;
      }),
    ).catch((err: unknown) => setErreur(messageDe(err)));
  };

  return (
    <section className="page-groupe-pile">
      <EnteteGroupe ongletActif="fils" titre={t('fils.titre')} />
      <Erreur message={premiereErreur(erreur, erreurGroupe)} />

      <form onSubmit={soumettre} className="carte barre-ajout-ligne">
        <input
          type="text"
          value={titre}
          aria-label={t('fils.champ_titre')}
          placeholder={t('fils.placeholder_sujet')}
          onChange={(e) => setTitre(e.target.value)}
          required
        />
        <button type="submit" disabled={titre.trim() === '' || enCours}>
          {enCours ? t('commun.creation') : t('fils.creer_court')}
        </button>
      </form>

      <ChargementPage etat={etat} erreur={erreurLecture} onReessayer={recharger}>
      <div className="carte">
        {fils === null || fils.length === 0 ? (
          <p className="discret">{t('fils.aucun')}</p>
        ) : (
          <ul className="liste-elements">
            {fils.map((f) => {
              const libelle = f.kind === 'event' ? (f.event_title ?? t('fils.fil_evenement')) : (f.title ?? '');
              const cible =
                f.kind === 'event' && f.event_id !== null
                  ? `#/groupe/${encodeURIComponent(groupId)}/evenement/${encodeURIComponent(f.event_id)}`
                  : `#/groupe/${encodeURIComponent(groupId)}/fil/${encodeURIComponent(f.id)}`;
              return (
                <li key={f.id}>
                  <a href={cible} className="ligne-interactive">
                    <div className="ligne-membre-info">
                      <span className="depense-icone-rond" aria-hidden="true">
                        <IconeMessage className="icone-mini" />
                      </span>
                      <span className="ligne-titre">{libelle}</span>
                    </div>
                    {f.kind === 'event' && <span className="pilule pilule-agenda">{t('fils.type_evenement')}</span>}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      </ChargementPage>
    </section>
  );
}
