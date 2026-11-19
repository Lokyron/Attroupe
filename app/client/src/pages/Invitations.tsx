import { useState } from 'react';
import { listerInvitationsRecues, repondreInvitation, type InvitationRecue } from '../api/groupes';
import { ChargementPage } from '../components/ChargementPage';
import { DialogueConfirmation } from '../components/DialogueConfirmation';
import { Erreur, messageDe } from '../components/Erreur';
import { useLecture } from '../hooks/useLecture';
import { useSoumission } from '../hooks/useSoumission';
import { t } from '../i18n';

/** Une invitation reçue : sa propre garde de soumission, pour qu'une réponse ne grise pas les autres lignes. */
function LigneInvitation({
  invitation: i,
  onRepondre,
  onErreur,
}: {
  invitation: InvitationRecue;
  onRepondre: () => void;
  onErreur: (message: string | null) => void;
}) {
  const { enCours, lancer } = useSoumission();
  const [refus, setRefus] = useState(false);

  const repondre = (reponse: 'acceptation' | 'refus'): void => {
    onErreur(null);
    lancer(() => repondreInvitation(i.id, reponse).then(onRepondre)).catch((err: unknown) => onErreur(messageDe(err)));
  };

  return (
    <li>
      {t('invitations_recues.texte', {
        invitant: i.invited_by_name,
        groupe: i.group_name,
        role: t(i.role === 'admin' ? 'membres.role_admin' : 'membres.role_member'),
      })}
      {i.message !== null && <blockquote>{i.message}</blockquote>}
      <button
        type="button"
        disabled={enCours}
        aria-label={`${t('invitations_recues.accepter')} ${i.group_name}`}
        onClick={() => repondre('acceptation')}
      >
        {t('invitations_recues.accepter')}
      </button>
      <button
        type="button"
        disabled={enCours}
        aria-label={`${t('invitations_recues.refuser')} ${i.group_name}`}
        onClick={() => setRefus(true)}
      >
        {t('invitations_recues.refuser')}
      </button>
      <DialogueConfirmation
        ouvert={refus}
        titre={t('confirm.invitations.refuser.titre', { groupe: i.group_name })}
        consequence={t('confirm.invitations.refuser.consequence')}
        reversible={false}
        libelleConfirmer={t('confirm.invitations.refuser.action')}
        danger={false}
        onConfirmer={() => {
          setRefus(false);
          repondre('refus');
        }}
        onAnnuler={() => setRefus(false)}
      />
    </li>
  );
}

/** Invitations reçues (par nom d'utilisateur) : accepter ou refuser. */
export function Invitations({ onChange }: { onChange: () => void }) {
  const {
    donnees: invitations,
    etat,
    erreur: erreurLecture,
    recharger,
  } = useLecture(() => listerInvitationsRecues(), []);
  const [erreur, setErreur] = useState<string | null>(null);

  return (
    <section>
      <h2>{t('invitations_recues.titre')}</h2>
      <Erreur message={erreur} />
      <ChargementPage etat={etat} erreur={erreurLecture} onReessayer={recharger}>
        {invitations?.length === 0 && (
          <div className="etat-vide">
            <p>{t('invitations_recues.aucune')}</p>
          </div>
        )}
        <ul>
          {invitations?.map((i) => (
            <LigneInvitation
              key={i.id}
              invitation={i}
              onErreur={setErreur}
              onRepondre={() => {
                recharger();
                onChange();
              }}
            />
          ))}
        </ul>
      </ChargementPage>
    </section>
  );
}
