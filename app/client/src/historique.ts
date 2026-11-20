// Retrait du fragment de l'URL. À part de `lien.ts`, qui reste pur : `lien.ts` est importé par les tests, qui
// tournent sans DOM, alors que ce module-ci touche `window` et `history` et n'existe que dans le navigateur.
/**
 * Retire le fragment de l'URL sans recharger ni empiler d'entrée d'historique.
 *
 * Appelé dès que le jeton est lu : un rechargement ou une restauration d'onglet ne rejoue alors pas un jeton
 * à usage unique (ce qui afficherait « lien invalide » à qui vient de réussir), et un jeton de réinitialisation,
 * valable une heure, ne dort pas dans la barre d'adresse ni dans l'historique du navigateur.
 *
 * Pour l'invitation aussi, depuis que son jeton est gardé en `sessionStorage` (`invitationEnAttente.ts`) : c'est ce
 * stockage, effacé à l'acceptation, au refus et à la déconnexion, qui lui fait traverser la connexion. Le laisser dans
 * l'URL le ferait revenir en stockage après un rechargement ou « Précédent » sur un poste partagé.
 */
export function effacerFragment(): void {
  history.replaceState(null, '', window.location.pathname + window.location.search);
}
