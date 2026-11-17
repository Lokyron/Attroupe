import { useRef, useState, type FormEvent } from 'react';
import { connecter, demanderReinitialisation, inscrire } from '../api/groupes';
import { Erreur, messageDe } from '../components/Erreur';
import { t } from '../i18n';

type Mode = 'connexion' | 'inscription' | 'oubli';

/** Écran minimal de connexion / inscription / mot de passe oublié. `onConnecte` est appelé une fois la session ouverte. */
export function Connexion({ onConnecte }: { onConnecte: () => void }) {
  const [mode, setMode] = useState<Mode>('connexion');
  const [email, setEmail] = useState('');
  const [nom, setNom] = useState('');
  const [motDePasse, setMotDePasse] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Une requête en vol bloque la suivante : un double clic enverrait deux inscriptions ou deux e-mails de
  // réinitialisation. Le garde est un `ref` : React groupe les mises à jour, donc un état serait encore à `false`
  // pour tous les clics d'une même salve. L'état `envoi` ne sert qu'à griser le bouton.
  const enVol = useRef(false);
  const [envoi, setEnvoi] = useState(false);

  const changerMode = (suivant: Mode): void => {
    setMode(suivant);
    setErreur(null);
    setInfo(null);
  };

  const soumettre = (e: FormEvent): void => {
    e.preventDefault();
    if (enVol.current) return;
    setErreur(null);
    setInfo(null);
    enVol.current = true;
    setEnvoi(true);
    let action: Promise<void>;
    if (mode === 'inscription') {
      action = inscrire(email, nom, motDePasse).then(() => {
        setInfo(t('connexion.inscription_envoyee'));
        setMode('connexion');
      });
    } else if (mode === 'oubli') {
      // Réponse volontairement identique que l'adresse existe ou non : l'écran ne doit pas révéler l'inverse.
      action = demanderReinitialisation(email).then(() => {
        setInfo(t('oubli.envoye'));
        setMode('connexion');
      });
    } else {
      action = connecter(email, motDePasse).then(onConnecte);
    }
    action.catch((err: unknown) => setErreur(messageDe(err))).finally(() => {
      enVol.current = false;
      setEnvoi(false);
    });
  };

  const titre = mode === 'inscription' ? 'connexion.titre_inscription' : mode === 'oubli' ? 'oubli.titre' : 'connexion.titre_connexion';

  return (
    <main className="connexion-enveloppe">
      <section className="carte connexion-carte">
        <div className="connexion-entete">
          <img src="/icons/logo.png" alt={''} className="connexion-logo" aria-hidden="true" />
          <h1 className="marque">{t('app.nom')}</h1>
          <p className="discret">{t('app.accroche')}</p>
        </div>
        <h2>{t(titre)}</h2>
        {mode === 'oubli' && <p className="discret">{t('oubli.explication')}</p>}
        <form onSubmit={soumettre} className="formulaire">
          <label>
            {t('connexion.email')}
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </label>
          {mode === 'inscription' && (
            <label>
              {t('connexion.nom_utilisateur')}
              <input type="text" value={nom} onChange={(e) => setNom(e.target.value)} required minLength={3} maxLength={32} autoComplete="username" />
            </label>
          )}
          {mode !== 'oubli' && (
            <label>
              {t('connexion.mot_de_passe')}
              <input
                type="password"
                value={motDePasse}
                onChange={(e) => setMotDePasse(e.target.value)}
                required
                autoComplete={mode === 'inscription' ? 'new-password' : 'current-password'}
              />
            </label>
          )}
          <button type="submit" className="bouton-primaire" disabled={envoi}>
            {mode === 'inscription' ? t('connexion.s_inscrire') : mode === 'oubli' ? t('oubli.envoyer') : t('connexion.se_connecter')}
          </button>
        </form>
        {info !== null && (
          <p role="status" className="info">
            {info}
          </p>
        )}
        <Erreur message={erreur} />
        {mode === 'connexion' && (
          <button type="button" className="lien" onClick={() => changerMode('oubli')}>
            {t('oubli.lien')}
          </button>
        )}
        <button type="button" className="lien" onClick={() => changerMode(mode === 'connexion' ? 'inscription' : 'connexion')}>
          {mode === 'inscription' ? t('connexion.vers_connexion') : mode === 'oubli' ? t('oubli.retour') : t('connexion.vers_inscription')}
        </button>
      </section>
    </main>
  );
}
