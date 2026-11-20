import { useEffect, useState } from 'react';
import { ErreurApi } from '../api/client';
import { renvoyerVerificationEmail } from '../api/compte';
import { accepterLien, apercuLien, type Apercu } from '../api/groupes';
import { DialogueConfirmation } from '../components/DialogueConfirmation';
import { Erreur, messageDe } from '../components/Erreur';
import { useSoumission } from '../hooks/useSoumission';
import { t } from '../i18n';
import { effacerInvitationEnAttente } from '../invitationEnAttente';

/**
 * Lien d'invitation reçu par e-mail. Le jeton arrive dans le fragment (`/invitation#jeton=…`, que le navigateur
 * n'envoie pas) ; la coque le garde pour la durée de l'onglet et le passe ici. Il part ensuite dans le CORPS des
 * requêtes, jamais dans leur URL.
 *
 * Il n'existe aucune route serveur pour REFUSER un lien (ADR-0009 §9 : le refus ne vaut que pour une invitation
 * adressée à un compte, `POST /api/moi/invitations/:id/refus`). « Mettre de côté » oublie donc le lien sur cet appareil ;
 * il ne révoque rien, et l'écran le dit.
 */
export function InvitationLien({
  jeton,
  connecte,
  onAcceptee,
  onRefusee,
  onAbandon,
}: {
  jeton: string | null;
  connecte: boolean;
  /** Invitation acceptée : la coque recharge le profil (nouveau groupe, compteur d'invitations). */
  onAcceptee: () => void;
  /** Lien refusé : la coque a oublié le jeton et ramène à l'accueil. */
  onRefusee: () => void;
  /** Lien mort (inconnu, révoqué, expiré, utilisé) : la coque oublie le jeton, l'écran garde son message d'erreur. */
  onAbandon: () => void;
}) {
  const [apercu, setApercu] = useState<Apercu | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [adresseNonVerifiee, setAdresseNonVerifiee] = useState(false);
  const [lienRenvoye, setLienRenvoye] = useState(false);
  const [acceptee, setAcceptee] = useState(false);
  const [confirmerRefus, setConfirmerRefus] = useState(false);
  const { enCours, lancer } = useSoumission();

  useEffect(() => {
    if (jeton === null) return;
    apercuLien(jeton)
      .then(setApercu)
      .catch((err: unknown) => {
        setErreur(messageDe(err));
        // Un lien mort le reste : on ne le garde pas pour proposer éternellement de le « reprendre ».
        if (err instanceof ErreurApi && (err.statut === 404 || err.statut === 410)) onAbandon();
      });
    // `onAbandon` change à chaque rendu de la coque : l'aperçu ne doit être demandé qu'une fois par jeton.
  }, [jeton]);

  if (acceptee) {
    return (
      <section>
        <h2>{t('lien.titre')}</h2>
        <p role="status" className="message-succes">{t('lien.acceptee')}</p>
        <a href="/">{t('lien.retour')}</a>
      </section>
    );
  }

  // Un lien mort rend `jeton` nul (la coque l'oublie) : le message d'erreur reste alors affiché à la place de « incomplet ».
  if (jeton === null && erreur === null) return <p role="alert">{t('lien.absent')}</p>;

  const accepter = (): void => {
    if (jeton === null) return;
    setErreur(null);
    setAdresseNonVerifiee(false);
    lancer(() =>
      accepterLien(jeton).then(() => {
        effacerInvitationEnAttente();
        setAcceptee(true);
        onAcceptee();
      }),
    ).catch((err: unknown) => {
      // Adresse à confirmer : le bloc d'avertissement dit déjà quoi faire, l'erreur brute le contredirait.
      const aConfirmer = err instanceof ErreurApi && err.cle === 'invitation.adresse_non_verifiee';
      setAdresseNonVerifiee(aConfirmer);
      setErreur(aConfirmer ? null : messageDe(err));
      // Lien devenu mort entre l'aperçu et le clic (introuvable, révoqué, expiré, utilisé) : on ne le garde pas.
      if (err instanceof ErreurApi && (err.statut === 404 || err.statut === 409 || err.statut === 410)) onAbandon();
    });
  };

  const renvoyerConfirmation = (): void => {
    setErreur(null);
    lancer(() => renvoyerVerificationEmail().then(() => setLienRenvoye(true))).catch((err: unknown) =>
      setErreur(messageDe(err)),
    );
  };

  return (
    <section>
      <h2>{t('lien.titre')}</h2>
      <Erreur message={erreur} />
      {adresseNonVerifiee && (
        <div className="message-avertissement">
          <p>{t('lien.adresse_a_confirmer')}</p>
          {lienRenvoye ? (
            <p role="status">{t('lien.confirmation_renvoyee')}</p>
          ) : (
            <button type="button" disabled={enCours} onClick={renvoyerConfirmation}>
              {enCours ? t('commun.envoi') : t('lien.renvoyer_confirmation')}
            </button>
          )}
        </div>
      )}
      {apercu !== null && (
        <p>
          {t('lien.texte', {
            invitant: apercu.invited_by_name,
            groupe: apercu.group_name,
            role: t(apercu.role === 'admin' ? 'membres.role_admin' : 'membres.role_member'),
          })}
        </p>
      )}
      {apercu !== null && !connecte && <p>{t('lien.connexion_requise')}</p>}
      {apercu !== null && (
        <div className="barre-compacte">
          {connecte && (
            <button type="button" className="bouton-primaire" disabled={enCours} onClick={accepter}>
              {enCours ? t('commun.envoi') : t('lien.accepter')}
            </button>
          )}
          <button type="button" disabled={enCours} onClick={() => setConfirmerRefus(true)}>
            {t('lien.refuser')}
          </button>
        </div>
      )}
      <DialogueConfirmation
        ouvert={confirmerRefus}
        titre={t('lien.refus_titre')}
        consequence={t('lien.refus_consequence')}
        reversible
        libelleConfirmer={t('lien.refus_confirmer')}
        libelleAnnuler={t('lien.refus_garder')}
        danger={false}
        onConfirmer={() => {
          setConfirmerRefus(false);
          effacerInvitationEnAttente();
          onRefusee();
        }}
        onAnnuler={() => setConfirmerRefus(false)}
      />
    </section>
  );
}
