import { join } from 'node:path';
import { verifierDossierDonnees } from './config/donnees.js';
import { chargerEnv, ErreurConfiguration } from './config/env.js';
import { dossierClient, version } from './config/paquet.js';
import { fermer, ouvrirEtMigrer } from './db/migrate.js';
import { creerApp } from './http/app.js';
import { creerJournal } from './http/middleware/journal.js';
import { creerTransporteurBrevo } from './services/brevo.js';
import { demarrerTaches } from './services/taches.js';
import { DiffuseurTempsReel } from './services/temps-reel.js';

// Amorçage : env → base → migrations → routes → écoute.
function demarrer(): void {
  const env = chargerEnv();
  verifierDossierDonnees(env.ATTROUPE_DATA_DIR);
  // Les routes reçoivent cette connexion, un « Base » opaque sans méthode ; le démarrage échoue si PRAGMA ou migrations échouent.
  const base = ouvrirEtMigrer(join(env.ATTROUPE_DATA_DIR, 'attroupe.sqlite'));
  const journal = creerJournal(env.ATTROUPE_LOG_LEVEL);

  // Brevo est facultatif : sans clé, l'application démarre et les e-mails restent en file (signalé dans GET /api/moi).
  const transporteur =
    env.BREVO_API_KEY === undefined || env.BREVO_SENDER_EMAIL === undefined
      ? undefined
      : creerTransporteurBrevo({
          apiKey: env.BREVO_API_KEY,
          expediteurEmail: env.BREVO_SENDER_EMAIL,
          expediteurNom: env.BREVO_SENDER_NAME ?? 'Attroupe',
          urlApi: env.BREVO_API_URL,
        });
  if (transporteur === undefined) {
    journal.warn('email.non_configure', { detail: "BREVO_API_KEY absente : les e-mails restent en file d'attente et ne partiront pas." });
  }
  const taches = demarrerTaches({ base, transporteur, journal, baseUrl: env.ATTROUPE_BASE_URL });

  // Créé ici pour pouvoir fermer les flux à l'arrêt : un flux SSE ne se termine jamais de lui-même.
  const diffuseur = new DiffuseurTempsReel({ journal, plafondGlobal: env.ATTROUPE_SSE_MAX_CONNECTIONS });
  const app = creerApp({
    env,
    version,
    base,
    journal,
    diffuseur,
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
    // Sans cela, `serveur.close()` attendrait indéfiniment les flux temps réel ouverts.
    diffuseur.fermerTout();
    serveur.close(() => {
      // On laisse finir la remise d'e-mails en cours avant de fermer la base.
      void taches.arreter().then(() => {
        fermer(base);
        process.exit(0);
      });
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
