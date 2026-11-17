// Retrait du fragment de l'URL. À part de `lien.ts`, qui reste pur : `lien.ts` est importé par les tests, qui
// tournent sans DOM, alors que ce module-ci touche `window` et `history` et n'existe que dans le navigateur.
/**
 * Retire le fragment de l'URL sans recharger ni empiler d'entrée d'historique.
 *
 * Appelé dès que le jeton est lu : un rechargement ou une restauration d'onglet ne rejoue alors pas un jeton
 * à usage unique (ce qui afficherait « lien invalide » à qui vient de réussir), et un jeton de réinitialisation,
 * valable une heure, ne dort pas dans la barre d'adresse ni dans l'historique du navigateur.
 *
 * Pas pour l'invitation : son jeton doit survivre au passage par la connexion, dans le même onglet.
 */
export function effacerFragment(): void {
  history.replaceState(null, '', window.location.pathname + window.location.search);
}
