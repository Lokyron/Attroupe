import type { Base } from '../../server/db/base.js';
import { connexionBrute, type ConnexionBrute } from '../../server/db/connection.js';

// Seul point d'accès des tests à la vraie connexion : amorçage de fixtures et constats « hors
// scope » (relire l'état réel de la base sans passer par le dispositif testé). L'ESLint n'autorise
// l'import de db/connection que dans CE fichier (eslint.config.js, verrou n° 5).
export type Sql = ConnexionBrute;

export function brut(base: Base): Sql {
  return connexionBrute(base);
}
