import { useState, type FormEvent } from 'react';
import { creerGroupe } from '../api/groupes';
import { Erreur, messageDe } from '../components/Erreur';
import { useSoumission } from '../hooks/useSoumission';
import { t } from '../i18n';

export function NouveauGroupe({ onCree }: { onCree: (groupId: string) => void }) {
  const [nom, setNom] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const { enCours, lancer } = useSoumission();

  const soumettre = (e: FormEvent): void => {
    e.preventDefault();
    setErreur(null);
    lancer(() => creerGroupe(nom).then(onCree)).catch((err: unknown) => setErreur(messageDe(err)));
  };

  return (
    <section>
      <h2>{t('groupe_nouveau.titre')}</h2>
      <form onSubmit={soumettre} className="formulaire">
        <label>
          {t('groupe_nouveau.nom')}
          <input type="text" value={nom} onChange={(e) => setNom(e.target.value)} required maxLength={80} />
        </label>
        <button type="submit" disabled={enCours}>
          {enCours ? t('commun.creation') : t('groupe_nouveau.creer')}
        </button>
      </form>
      <Erreur message={erreur} />
    </section>
  );
}
