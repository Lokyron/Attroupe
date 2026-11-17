import { useEffect, useState } from 'react';
import { accepterLien, apercuLien, type Apercu } from '../api/groupes';
import { Erreur, messageDe } from '../components/Erreur';
import { t } from '../i18n';
import { jetonDuFragment } from '../lien';

/** Lien d'invitation reçu par e-mail : `/invitation#jeton=…` (le jeton est dans le fragment, que le navigateur n'envoie pas ; il part ensuite dans le CORPS des requêtes, jamais dans leur URL). */
export function InvitationLien({ connecte, onAcceptee }: { connecte: boolean; onAcceptee: () => void }) {
  const jeton = jetonDuFragment(window.location.hash);
  const [apercu, setApercu] = useState<Apercu | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [acceptee, setAcceptee] = useState(false);

  useEffect(() => {
    if (jeton === null) return;
    apercuLien(jeton).then(setApercu).catch((err: unknown) => setErreur(messageDe(err)));
  }, [jeton]);

  if (jeton === null) return <p role="alert">{t('lien.absent')}</p>;

  const accepter = (): void => {
    setErreur(null);
    accepterLien(jeton)
      .then(() => {
        setAcceptee(true);
        onAcceptee();
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  return (
    <section>
      <h2>{t('lien.titre')}</h2>
      <Erreur message={erreur} />
      {apercu !== null && (
        <p>{t('lien.texte', { invitant: apercu.invited_by_name, groupe: apercu.group_name, role: t(apercu.role === 'admin' ? 'membres.role_admin' : 'membres.role_member') })}</p>
      )}
      {apercu !== null && !connecte && <p>{t('lien.connexion_requise')}</p>}
      {apercu !== null && connecte && !acceptee && (
        <button type="button" onClick={accepter}>
          {t('lien.accepter')}
        </button>
      )}
      {acceptee && (
        <>
          <p role="status">{t('lien.acceptee')}</p>
          <a href="/">{t('lien.retour')}</a>
        </>
      )}
    </section>
  );
}
