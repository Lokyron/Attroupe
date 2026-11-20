import { useCallback, useEffect, useRef, useState } from 'react';
import { messageDe } from '../components/Erreur';
import type { EtatLecture } from './etatsLecture';

export type { EtatLecture };

/**
 * Lecture initiale d'une page, avec trois états DISTINCTS : `chargement`, `erreur`, `pret`. Ne jamais déduire
 * « vide » de `donnees === null` : c'est `etat === 'pret'` qui dit qu'une réponse est arrivée (elle peut être `[]`).
 *
 * Garde d'annulation par compteur de génération : toute lecture lancée (changement de `deps`, `recharger`)
 * invalide les précédentes, dont la réponse tardive est ignorée au lieu de s'appliquer à un autre groupe ou objet.
 * Même principe que `useRechargement`, qui reste le bon outil pour les rafraîchissements temps réel (SSE) : ici,
 * chaque lecture repasse par `chargement` et vide `donnees`.
 *
 * `charger` peut changer à chaque rendu sans relancer la lecture : seules `deps` la déclenchent.
 */
export function useLecture<T>(
  charger: () => Promise<T>,
  deps: readonly unknown[],
): {
  donnees: T | null;
  etat: EtatLecture;
  erreur: string | null;
  /** Relance la lecture DEPUIS ZÉRO : vide `donnees` et repasse par le squelette. À passer à `onReessayer`. */
  recharger: () => void;
  /**
   * Relit en gardant à l'écran ce qui y est déjà : `etat` reste `pret` et `donnees` n'est pas vidé.
   *
   * C'est ce qu'il faut APRÈS une action de l'utilisateur (une suppression, une synchronisation…) :
   * `recharger` y remplacerait la liste par un squelette le temps de l'aller-retour, ce qui fait
   * clignoter la page et efface au passage l'indicateur « en cours » de la ligne concernée.
   */
  rafraichir: () => void;
  /** Vrai pendant un `rafraichir` : à poser sur `aria-busy`. */
  rafraichissement: boolean;
} {
  const dernier = useRef(charger);
  dernier.current = charger;
  const generation = useRef(0);
  const [donnees, setDonnees] = useState<T | null>(null);
  const [etat, setEtat] = useState<EtatLecture>('chargement');
  const [erreur, setErreur] = useState<string | null>(null);

  const [rafraichissement, setRafraichissement] = useState(false);
  // L'état courant, lisible depuis une promesse sans la refermer sur une valeur périmée : la branche
  // d'erreur doit savoir s'il y a déjà quelque chose à l'écran pour décider quoi faire.
  const aDesDonnees = useRef(false);

  /** `enPlace` : garder à l'écran ce qui y est déjà, au lieu de repasser par le squelette. */
  const lancer = useCallback((enPlace: boolean): void => {
    generation.current += 1;
    const numero = generation.current;
    setErreur(null);
    if (enPlace) {
      setRafraichissement(true);
    } else {
      aDesDonnees.current = false;
      setDonnees(null);
      setEtat('chargement');
    }
    dernier.current().then(
      (valeur) => {
        if (numero !== generation.current) return;
        aDesDonnees.current = true;
        setDonnees(valeur);
        setEtat('pret');
        setRafraichissement(false);
      },
      (err: unknown) => {
        if (numero !== generation.current) return;
        setErreur(messageDe(err));
        setRafraichissement(false);
        // Un rafraîchissement raté ne doit pas effacer ce qui est déjà lisible : on garde l'écran et
        // le message s'affiche à côté. Mais s'il n'y a RIEN à garder — un `rafraichir` déclenché
        // avant que la première lecture n'ait abouti, par exemple — rester en `chargement` laisserait
        // un squelette pour toujours, et l'erreur serait avalée : dans ce cas on passe en `erreur`.
        if (!enPlace || !aDesDonnees.current) setEtat('erreur');
      },
    );
  }, []);

  const lire = useCallback((): void => lancer(false), [lancer]);
  const rafraichir = useCallback((): void => lancer(true), [lancer]);

  useEffect(() => {
    lire();
    // Au démontage, une réponse en vol devient obsolète.
    return () => {
      generation.current += 1;
    };
    // Les dépendances sont celles de l’appelant : aucune règle ne peut les vérifier statiquement.
  }, [lire, ...deps]);

  return { donnees, etat, erreur, recharger: lire, rafraichir, rafraichissement };
}
