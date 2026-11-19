import { useCallback, useRef, useState } from 'react';

/**
 * Garde contre la double soumission d'une écriture (création, vote, dépense, remboursement…).
 *
 * La garde est un `ref`, pas un état : React groupe les mises à jour, donc plusieurs clics (ou « Entrée »
 * répétés) d'une même salve liraient tous `false` et partiraient quand même. Un `ref` change tout de suite.
 * L'état `enCours` ne sert qu'à l'affichage (bouton grisé, libellé de progression).
 *
 * Le hook NE TRAITE PAS l'erreur : si la promesse échoue (ou si la fabrique lève de façon synchrone), l'exception
 * remonte à l'appelant, qui garde son `try/catch` ou son `.catch((err) => setErreur(messageDe(err)))`.
 *
 * Après démontage : depuis React 18, un `setState` sur un composant démonté est inoffensif (plus d'avertissement,
 * aucun effet) ; un drapeau « monté » serait donc inutile. En revanche une `ref` restée à `true` ne l'est pas :
 * c'est pourquoi elle est relâchée dans un `finally`, quoi qu'il arrive.
 */
export function useSoumission(): {
  /** Vrai pendant l'envoi : à poser sur `disabled` et sur le libellé de progression. */
  enCours: boolean;
  /** Lance la promesse si aucune n'est déjà en vol. Renvoie `undefined` si l'appel a été ignoré. */
  lancer: <T>(fabrique: () => Promise<T>) => Promise<T | undefined>;
} {
  const enVol = useRef(false);
  const [enCours, setEnCours] = useState(false);

  const lancer = useCallback(async <T,>(fabrique: () => Promise<T>): Promise<T | undefined> => {
    if (enVol.current) return undefined;
    enVol.current = true;
    setEnCours(true);
    try {
      return await fabrique();
    } finally {
      enVol.current = false;
      setEnCours(false);
    }
  }, []);

  return { enCours, lancer };
}
