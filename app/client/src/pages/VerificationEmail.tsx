import { useEffect, useRef, useState } from 'react';
import { verifierEmail } from '../api/groupes';
import { Erreur, messageDe } from '../components/Erreur';
import { t } from '../i18n';
import { effacerFragment } from '../historique';
import { lireInvitationEnAttente } from '../invitationEnAttente';
import { jetonDuFragment } from '../lien';

/**
 * Page du lien de confirmation d'adresse : `/verification-email#jeton=…`.
 *
 * Le jeton est à USAGE UNIQUE et consommé par l'appel : il ne doit partir qu'une fois.
 *  - Le garde `envoye` est un `ref`, pas un état : le double montage de `StrictMode` rejouerait l'effet avant
 *    tout rendu, et le deuxième appel échouerait sur un jeton déjà consommé — un succès affiché comme une erreur.
 *  - Le jeton est lu UNE fois (initialiseur paresseux) puis retiré de l'URL. Sans cela, un rechargement, un
 *    retour en arrière ou la restauration de l'onglet sur mobile rejouerait un jeton déjà consommé et afficherait
 *    « lien invalide » à quelqu'un dont l'adresse vient précisément d'être confirmée.
 *
 * Un lien rouvert après coup n'a donc plus de jeton : le message dit « incomplet OU déjà utilisé », parce que
 * cette page ne peut pas distinguer les deux et ne doit pas affirmer l'un pour l'autre.
 *
 * Si une invitation attendait (jeton gardé dans l'onglet), « Reprendre l'invitation » y retourne SANS remettre le
 * jeton dans l'URL : la page d'invitation le relit du stockage. Le lien de confirmation s'ouvre souvent dans un
 * autre onglet, qui n'a pas ce stockage : alors rien n'est proposé, et l'onglet d'origine garde son invitation.
 */
export function VerificationEmail() {
  const [jeton] = useState(() => jetonDuFragment(window.location.hash));
  const [invitationEnAttente] = useState(() => lireInvitationEnAttente() !== null);
  const envoye = useRef(false);
  const [etat, setEtat] = useState<'en_cours' | 'reussie'>('en_cours');
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    if (jeton === null || envoye.current) return;
    envoye.current = true;
    effacerFragment();
    verifierEmail(jeton)
      .then(() => setEtat('reussie'))
      .catch((err: unknown) => setErreur(messageDe(err)));
  }, [jeton]);

  return (
    <main className="connexion-enveloppe">
      <section className="carte connexion-carte">
        <div className="connexion-entete">
          <img src="/icons/logo.png" alt={''} className="connexion-logo" aria-hidden="true" />
          <h1 className="marque">{t('app.nom')}</h1>
        </div>
        <h2>{t('verification.titre')}</h2>
        {jeton === null ? (
          <p role="alert">{t('verification.lien_consomme')}</p>
        ) : etat === 'reussie' ? (
          <p role="status" className="info">{t('verification.reussie')}</p>
        ) : (
          <>
            {erreur === null && <p role="status">{t('verification.en_cours')}</p>}
            <Erreur message={erreur} />
          </>
        )}
        {etat === 'reussie' && invitationEnAttente && (
          <p>
            <a href="/invitation" className="bouton-primaire">{t('verification.reprendre_invitation')}</a>
          </p>
        )}
        {etat === 'reussie' && !invitationEnAttente && <p className="texte-doux">{t('verification.invitation_rouvrir')}</p>}
        <a href="/">{t('verification.retour')}</a>
      </section>
    </main>
  );
}
