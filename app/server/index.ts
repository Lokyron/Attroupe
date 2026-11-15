import { join } from 'node:path';
import { verifierDossierDonnees } from './config/donnees.js';
import { chargerEnv, ErreurConfiguration } from './config/env.js';
import { dossierClient, version } from './config/paquet.js';
import { fermer, ouvrirEtMigrer } from './db/migrate.js';
import { creerApp } from './http/app.js';

// Amorçage : env → base → migrations → routes → écoute.
function demarrer(): void {
  const env = chargerEnv();
  verifierDossierDonnees(env.ATTROUPE_DATA_DIR);
  // Les routes (lots 2 et 3) recevront cette connexion, un « Base » opaque sans méthode ; le démarrage échoue si PRAGMA ou migrations échouent.
  const base = ouvrirEtMigrer(join(env.ATTROUPE_DATA_DIR, 'attroupe.sqlite'));
  const app = creerApp({
    env,
    version,
    ...(env.NODE_ENV === 'production' ? { dossierClient } : {}),
  });

  const serveur = app.listen(env.PORT, (erreur?: Error) => {
    // Express 5 transmet aussi l'échec d'écoute à ce rappel : le gestionnaire « error » ci-dessous s'en charge.
    if (erreur !== undefined) return;
    console.log(`Attroupe ${version} à l'écoute sur le port ${env.PORT} (${env.NODE_ENV}).`);
  });

  // Port occupé, adresse refusée… : sans cet écouteur, l'erreur serait avalée et le code de sortie serait 0.
  serveur.on('error', (erreur: NodeJS.ErrnoException) => {
    if (erreur.code === 'EADDRINUSE') {
      console.error(`Impossible d'écouter : le port ${env.PORT} est déjà utilisé.`);
    } else {
      console.error(`Impossible d'écouter sur le port ${env.PORT} :`, erreur);
    }
    process.exit(1);
  });

  // Arrêt propre sur le signal de Docker : on finit les requêtes en cours.
  const arreter = (): void => {
    serveur.close(() => {
      fermer(base);
      process.exit(0);
    });
  };
  process.on('SIGTERM', arreter);
  process.on('SIGINT', arreter);
}

try {
  demarrer();
} catch (erreur) {
  if (erreur instanceof ErreurConfiguration) {
    console.error(erreur.message);
  } else {
    console.error('Échec du démarrage :', erreur);
  }
  process.exit(1);
}
