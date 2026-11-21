import { useState } from 'react';
import { repondreInvitation } from '../api/groupes';
import { useSoumission } from '../hooks/useSoumission';
import { t } from '../i18n';
import { messageDe } from './Erreur';
import { DialogueConfirmation } from './DialogueConfirmation';

/**
 * Boutons « Accepter » / « Refuser » d'une invitation reçue, avec la confirmation du refus (comme la page Invitations).
 * Sa propre garde de soumission : répondre à une invitation ne grise pas les autres lignes. `onRepondu` relit la liste et le badge.
 */
export function ReponseInvitation({
  invitationId,
  groupe,
  onRepondu,
  onErreur,
}: {
  invitationId: string;
  groupe: string;
  onRepondu: () => void;
  onErreur: (message: string | null) => void;
}) {
  const { enCours, lancer } = useSoumission();
  const [refus, setRefus] = useState(false);

  const repondre = (reponse: 'acceptation' | 'refus'): void => {
    onErreur(null);
    lancer(() => repondreInvitation(invitationId, reponse).then(onRepondu)).catch((err: unknown) => onErreur(messageDe(err)));
  };

  return (
    <>
      <button
        type="button"
        className="bouton-primaire bouton-compact"
        disabled={enCours}
        aria-label={`${t('invitations_recues.accepter')} ${groupe}`}
        onClick={() => repondre('acceptation')}
      >
        {t('invitations_recues.accepter')}
      </button>
      <button
        type="button"
        className="bouton-compact"
        disabled={enCours}
        aria-label={`${t('invitations_recues.refuser')} ${groupe}`}
        onClick={() => setRefus(true)}
      >
        {t('invitations_recues.refuser')}
      </button>
      <DialogueConfirmation
        ouvert={refus}
        titre={t('confirm.invitations.refuser.titre', { groupe })}
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
    </>
  );
}
