import { useState, type FormEvent } from 'react';
import { connecter, inscrire } from '../api/groupes';
import { Erreur, messageDe } from '../components/Erreur';
import { t } from '../i18n';

/** Écran minimal de connexion / inscription. `onConnecte` est appelé une fois la session ouverte. */
export function Connexion({ onConnecte }: { onConnecte: () => void }) {
  const [inscription, setInscription] = useState(false);
  const [email, setEmail] = useState('');
  const [nom, setNom] = useState('');
  const [motDePasse, setMotDePasse] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const soumettre = (e: FormEvent): void => {
    e.preventDefault();
    setErreur(null);
    setInfo(null);
    const action = inscription
      ? inscrire(email, nom, motDePasse).then(() => {
          setInfo(t('connexion.inscription_envoyee'));
          setInscription(false);
        })
      : connecter(email, motDePasse).then(onConnecte);
    action.catch((err: unknown) => setErreur(messageDe(err)));
  };

  return (
    <main className="accueil">
      <h1>{t('app.nom')}</h1>
      <h2>{inscription ? t('connexion.titre_inscription') : t('connexion.titre_connexion')}</h2>
      <form onSubmit={soumettre} className="formulaire">
        <label>
          {t('connexion.email')}
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        {inscription && (
          <label>
            {t('connexion.nom_utilisateur')}
            <input type="text" value={nom} onChange={(e) => setNom(e.target.value)} required minLength={3} maxLength={32} autoComplete="username" />
          </label>
        )}
        <label>
          {t('connexion.mot_de_passe')}
          <input type="password" value={motDePasse} onChange={(e) => setMotDePasse(e.target.value)} required autoComplete={inscription ? 'new-password' : 'current-password'} />
        </label>
        <button type="submit">{inscription ? t('connexion.s_inscrire') : t('connexion.se_connecter')}</button>
      </form>
      {info !== null && <p role="status">{info}</p>}
      <Erreur message={erreur} />
      <button type="button" className="lien" onClick={() => setInscription(!inscription)}>
        {inscription ? t('connexion.vers_connexion') : t('connexion.vers_inscription')}
      </button>
    </main>
  );
}
