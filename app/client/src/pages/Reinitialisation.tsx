import { useRef, useState, type FormEvent } from 'react';
import { reinitialiserMotDePasse } from '../api/groupes';
import { Erreur, messageDe } from '../components/Erreur';
import { t } from '../i18n';
import { effacerFragment } from '../historique';
import { jetonDuFragment } from '../lien';

/**
 * Page du lien de réinitialisation : `/reinitialisation#jeton=…`.
 *
 * Contrairement à la confirmation d'adresse, rien ne part tout seul : le jeton n'est consommé qu'à la
 * soumission du nouveau mot de passe — un scanner de liens qui exécute le JavaScript ne peut donc pas le brûler.
 *
 * Deux gardes qui comptent :
 *  - `enVol` (un `ref`, pas un état) empêche la DOUBLE soumission. Le serveur vérifie le jeton en lecture seule,
 *    puis hache en scrypt (long) avant de le consommer : deux envois passent tous deux la vérification, un seul
 *    consomme, et l'autre revient en `jeton.invalide`. Sans ce garde, l'écran affichait le succès ET le refus
 *    côte à côte, et l'utilisateur redemandait un lien alors que son mot de passe était déjà changé. Un état
 *    ne suffirait PAS : React groupe les mises à jour, donc plusieurs clics d'une même salve liraient tous
 *    `false` et partiraient quand même — mesuré, trois clics donnaient trois requêtes. Un `ref` change tout de
 *    suite. L'état `envoi` ne sert qu'à l'affichage (bouton grisé, libellé).
 *  - Le jeton, valable une heure, est lu une fois puis retiré de l'URL : il ne reste ni dans la barre
 *    d'adresse ni dans l'historique du navigateur.
 *
 * La confirmation à deux champs est vérifiée ICI seulement : c'est un garde-fou de saisie, pas une règle de
 * sécurité ; le serveur n'en sait rien et n'a pas à le savoir.
 */
export function Reinitialisation() {
  const [jeton] = useState(() => {
    const lu = jetonDuFragment(window.location.hash);
    if (lu !== null) effacerFragment();
    return lu;
  });
  const [motDePasse, setMotDePasse] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const enVol = useRef(false);
  const [envoi, setEnvoi] = useState(false);
  const [reussie, setReussie] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const soumettre = (e: FormEvent): void => {
    e.preventDefault();
    if (jeton === null || enVol.current || reussie) return;
    setErreur(null);
    if (motDePasse !== confirmation) {
      setErreur(t('reinitialisation.discordance'));
      return;
    }
    enVol.current = true;
    setEnvoi(true);
    reinitialiserMotDePasse(jeton, motDePasse)
      .then(() => {
        setReussie(true);
        setMotDePasse('');
        setConfirmation('');
      })
      .catch((err: unknown) => setErreur(messageDe(err)))
      .finally(() => {
        enVol.current = false;
        setEnvoi(false);
      });
  };

  return (
    <main className="connexion-enveloppe">
      <section className="carte connexion-carte">
        <div className="connexion-entete">
          <img src="/icons/logo.png" alt={''} className="connexion-logo" aria-hidden="true" />
          <h1 className="marque">{t('app.nom')}</h1>
        </div>
        <h2>{t('reinitialisation.titre')}</h2>
        {jeton === null ? (
          <p role="alert">{t('reinitialisation.lien_consomme')}</p>
        ) : reussie ? (
          <p role="status" className="info">{t('reinitialisation.reussie')}</p>
        ) : (
          <>
            <form onSubmit={soumettre} className="formulaire">
              <label>
                {t('reinitialisation.nouveau')}
                <input type="password" value={motDePasse} onChange={(e) => setMotDePasse(e.target.value)} required autoComplete="new-password" disabled={envoi} />
              </label>
              <label>
                {t('reinitialisation.confirmation')}
                <input type="password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} required autoComplete="new-password" disabled={envoi} />
              </label>
              <button type="submit" className="bouton-primaire" disabled={envoi}>
                {envoi ? t('reinitialisation.en_cours') : t('reinitialisation.valider')}
              </button>
            </form>
            <Erreur message={erreur} />
          </>
        )}
        <a href="/">{t('reinitialisation.retour')}</a>
      </section>
    </main>
  );
}
