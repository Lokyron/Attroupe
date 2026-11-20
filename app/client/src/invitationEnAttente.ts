// Jeton d'invitation en attente, gardé pour la durée de l'onglet (`sessionStorage`).
//
// Le jeton d'un lien d'invitation est un secret porteur de droits : il ne part que dans le CORPS des requêtes, jamais
// dans une URL, un journal ou un message affiché. Ce module le garde le temps du parcours (arrivée sur le lien,
// création de compte, confirmation de l'adresse, connexion) et l'efface à l'acceptation, au refus et à la déconnexion.
//
// Tout accès au stockage est protégé : en navigation privée ou avec les données de site bloquées, l'accesseur
// `window.sessionStorage` lui-même peut lever. Le parcours continue alors en mode dégradé (le jeton reste en mémoire
// dans la coque, et dans le fragment de l'URL tant qu'on n'a pas navigué) au lieu de planter.

import { jetonDuFragment } from './lien.js';

const CLE = 'attroupe.invitation_en_attente';

/** Ce dont le module a besoin du stockage ; permet de le tester sans navigateur. */
export type Stockage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Le stockage de l'onglet, ou `null` s'il est inaccessible. */
function stockageDeLOnglet(): Stockage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Le jeton gardé, ou `null` (rien de gardé, stockage inaccessible, ou valeur mal formée). */
export function lireInvitationEnAttente(stockage: Stockage | null = stockageDeLOnglet()): string | null {
  if (stockage === null) return null;
  try {
    // Repasser par la forme du fragment valide la valeur : une entrée altérée n'est jamais renvoyée à l'API.
    return jetonDuFragment(`#jeton=${stockage.getItem(CLE) ?? ''}`);
  } catch {
    return null;
  }
}

/** Garde le jeton ; renvoie `false` si le stockage a refusé (le parcours continue alors sans persistance). */
export function garderInvitationEnAttente(jeton: string, stockage: Stockage | null = stockageDeLOnglet()): boolean {
  if (stockage === null) return false;
  try {
    stockage.setItem(CLE, jeton);
    return true;
  } catch {
    return false;
  }
}

/** Efface le jeton gardé. Sans effet, sans erreur, si le stockage est inaccessible. */
export function effacerInvitationEnAttente(stockage: Stockage | null = stockageDeLOnglet()): void {
  if (stockage === null) return;
  try {
    stockage.removeItem(CLE);
  } catch {
    // Rien à faire : si on ne peut ni lire ni écrire, il n'y a rien à effacer non plus.
  }
}

/**
 * Jeton à l'arrivée sur la page : le lien frais (fragment) l'emporte sur un jeton plus ancien, et il est gardé ;
 * sans fragment (retour depuis la confirmation d'adresse), on reprend celui qui était gardé.
 */
export function jetonALArrivee(fragment: string, stockage: Stockage | null = stockageDeLOnglet()): string | null {
  const frais = jetonDuFragment(fragment);
  if (frais === null) return lireInvitationEnAttente(stockage);
  garderInvitationEnAttente(frais, stockage);
  return frais;
}
