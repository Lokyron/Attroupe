import { fermer, ouvrirEtMigrer } from '../../server/db/migrate.js';

// Processus de test du démarrage simultané : attend l'instant `barriere` (ms depuis l'époque) pour
// que tous les processus ouvrent la base ensemble, puis ouvre et migre comme le fait index.ts.
// Usage : node --import tsx demarrer-base.ts <base.sqlite> <barriere> <dossier-migrations>
const [chemin, barriere, dossierMigrations] = process.argv.slice(2);
if (chemin === undefined || barriere === undefined || dossierMigrations === undefined) {
  console.error('usage : demarrer-base.ts <base> <barriere> <dossier-migrations>');
  process.exit(2);
}

while (Date.now() < Number(barriere)) {
  // attente active : on veut le départ le plus simultané possible
}

try {
  const base = ouvrirEtMigrer(chemin, { dossierMigrations });
  fermer(base);
  console.log('ok');
} catch (erreur) {
  console.error(erreur instanceof Error ? erreur.message : String(erreur));
  process.exit(1);
}
