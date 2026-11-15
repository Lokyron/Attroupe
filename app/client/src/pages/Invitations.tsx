import { useCallback, useEffect, useState } from 'react';
import { listerInvitationsRecues, repondreInvitation, type InvitationRecue } from '../api/groupes';
import { Erreur, messageDe } from '../components/Erreur';
import { t } from '../i18n';

/** Invitations reçues (par nom d'utilisateur) : accepter ou refuser. */
export function Invitations({ onChange }: { onChange: () => void }) {
  const [invitations, setInvitations] = useState<InvitationRecue[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const charger = useCallback((): void => {
    listerInvitationsRecues().then(setInvitations).catch((err: unknown) => setErreur(messageDe(err)));
  }, []);
  useEffect(charger, [charger]);

  const repondre = (id: string, reponse: 'acceptation' | 'refus'): void => {
    setErreur(null);
    repondreInvitation(id, reponse)
      .then(() => {
        charger();
        onChange();
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  return (
    <section>
      <h2>{t('invitations_recues.titre')}</h2>
      <Erreur message={erreur} />
      {invitations === null && <p>{t('commun.chargement')}</p>}
      {invitations?.length === 0 && <p>{t('invitations_recues.aucune')}</p>}
      <ul>
        {invitations?.map((i) => (
          <li key={i.id}>
            {t('invitations_recues.texte', { invitant: i.invited_by_name, groupe: i.group_name, role: t(i.role === 'admin' ? 'membres.role_admin' : 'membres.role_member') })}
            {i.message !== null && <blockquote>{i.message}</blockquote>}
            <button type="button" onClick={() => repondre(i.id, 'acceptation')}>
              {t('invitations_recues.accepter')}
            </button>
            <button type="button" onClick={() => repondre(i.id, 'refus')}>
              {t('invitations_recues.refuser')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
