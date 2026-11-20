import { useSyncExternalStore } from 'react';

const EVENEMENT_FRAGMENT = 'attroupe:fragment';

function sabonner(rappel: () => void): () => void {
  window.addEventListener('hashchange', rappel);
  window.addEventListener(EVENEMENT_FRAGMENT, rappel);
  return () => {
    window.removeEventListener('hashchange', rappel);
    window.removeEventListener(EVENEMENT_FRAGMENT, rappel);
  };
}

/** Le fragment d'URL courant, relu à chaque changement (navigation, « retour », lien collé, ou `remplacerFragment`). */
export function useFragment(): string {
  return useSyncExternalStore(sabonner, () => window.location.hash);
}

/**
 * Change le fragment SANS ajouter d'entrée à l'historique ni déclencher `hashchange` : la coque ne remet donc pas la page
 * en haut et ne déplace pas le focus. Pour un état de consultation (vue, période), où « retour » doit quitter la page.
 */
export function remplacerFragment(hash: string): void {
  history.replaceState(history.state, '', hash);
  window.dispatchEvent(new Event(EVENEMENT_FRAGMENT));
}
