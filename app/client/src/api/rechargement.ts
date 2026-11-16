import { useCallback, useEffect, useRef } from 'react';

/** Les changements en rafale (huit personnes qui cochent) sont regroupés : un seul rechargement par fenêtre. */
export const REGROUPEMENT_MS = 150;

/**
 * Rechargement ordonné et regroupé d'une vue alimentée par le flux temps réel.
 *  - `recharger` lance une lecture ; une réponse ARRIVÉE APRÈS qu'une lecture plus récente a été lancée est ignorée (sinon une réponse en
 *    retard écraserait l'état, y compris une case cochée de façon optimiste) ;
 *  - `planifier` regroupe les demandes dans une fenêtre de `REGROUPEMENT_MS` : une seule lecture, quel que soit le nombre de messages.
 * Les fonctions passées peuvent changer à chaque rendu sans relancer quoi que ce soit.
 */
export function useRechargement<T>(charger: () => Promise<T>, appliquer: (valeur: T) => void, surErreur: (erreur: unknown) => void): { recharger: () => void; planifier: () => void } {
  const derniers = useRef({ charger, appliquer, surErreur });
  derniers.current = { charger, appliquer, surErreur };
  const generation = useRef(0);
  const attente = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const monte = useRef(true);

  useEffect(() => {
    monte.current = true;
    return () => {
      monte.current = false;
      if (attente.current !== undefined) clearTimeout(attente.current);
    };
  }, []);

  const recharger = useCallback((): void => {
    generation.current += 1;
    const numero = generation.current;
    derniers.current
      .charger()
      .then((valeur) => {
        if (monte.current && numero === generation.current) derniers.current.appliquer(valeur);
      })
      .catch((erreur: unknown) => {
        if (monte.current && numero === generation.current) derniers.current.surErreur(erreur);
      });
  }, []);

  const planifier = useCallback((): void => {
    if (attente.current !== undefined) return;
    attente.current = setTimeout(() => {
      attente.current = undefined;
      recharger();
    }, REGROUPEMENT_MS);
  }, [recharger]);

  return { recharger, planifier };
}
