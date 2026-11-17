import { Router } from 'express';
import { listerInvitationsEmises } from '../../db/queries/invitations.js';
import { listerMembres } from '../../db/queries/membres.js';
import { mesGroupes } from '../../db/queries/transverse.js';
import { versInstant } from '../../domain/instant.js';
import { changerMaVisibiliteDefaut, disponibilitesDuGroupe } from '../../services/agenda-personnel.js';
import { changerRole, creerNouveauGroupe, detailGroupe, inviter, modifierGroupe, quitter, retirerMembre, revoquerInvitation } from '../../services/groupes.js';
import type { Contexte } from '../contexte.js';
import { exigerAdminGroupe, exigerAppartenance, scopeDe } from '../middleware/appartenance.js';
import { cadence } from '../middleware/cadence.js';
import { exigerSession, gardeSession } from '../middleware/session.js';
import { monter } from '../montage.js';
import { parametre } from '../parametres.js';
import { schemaVisibiliteDefaut } from '../schemas/agenda-personnel.js';
import { schemaFenetre } from '../schemas/evenements.js';
import { schemaChangementRole, schemaCreationGroupe, schemaInvitation, schemaModificationGroupe } from '../schemas/groupes.js';
import { analyser } from '../schemas/valider.js';
import { routesDepenses, routesRemboursements, routesSoldes } from './depenses.js';
import { routesEvenements } from './evenements.js';
import { routesFils } from './fils.js';
import { routesAlbums, routesImmich } from './immich.js';
import { routesListes } from './listes.js';
import { routesSondages } from './sondages.js';
import { routesTaches } from './taches.js';
import { routesTempsReel } from './temps-reel.js';

// /api/groupes. Deux étages :
//  - `/` (le sélecteur) relève du COMPTE : session seule, portée utilisateur ;
//  - `/:groupId/…` relève du GROUPE : `exigerAppartenance` est posé ici UNE fois sur le préfixe (verrou n° 1 et 3), si bien
//    qu'aucune route enfant ne peut l'oublier. Les routes réservées aux administrateurs ajoutent `exigerAdminGroupe`
//    (403) ; l'appartenance, elle, répond 404.

export function routesGroupes(contexte: Contexte): Router {
  const routeur = Router();
  routeur.use(gardeSession);

  // Le sélecteur de groupe : mes appartenances actives.
  routeur.get('/', (req, res) => {
    const { portee } = exigerSession(req);
    res.json({ groupes: mesGroupes(portee) });
  });

  // Un compte peut avoir plusieurs groupes ; le créateur devient administrateur du nouveau.
  routeur.post('/', cadence(contexte, 'groupe'), (req, res) => {
    const corps = analyser(schemaCreationGroupe, req.body);
    res.status(201).json(creerNouveauGroupe(contexte, exigerSession(req), corps));
  });

  monter(routeur, '/:groupId', routesDuGroupe(contexte), exigerAppartenance(contexte));
  return routeur;
}

function routesDuGroupe(contexte: Contexte): Router {
  const routeur = Router({ mergeParams: true });

  routeur.get('/', (req, res) => {
    res.json(detailGroupe(scopeDe(req)));
  });

  routeur.patch('/', exigerAdminGroupe, (req, res) => {
    const champs = analyser(schemaModificationGroupe, req.body);
    res.json(modifierGroupe(contexte, scopeDe(req), champs));
  });

  routeur.get('/membres', (req, res) => {
    res.json({ membres: listerMembres(scopeDe(req)) });
  });

  routeur.patch('/membres/:membreId', exigerAdminGroupe, (req, res) => {
    const { role } = analyser(schemaChangementRole, req.body);
    changerRole(contexte, scopeDe(req), parametre(req, 'membreId'), role);
    res.json({ ok: true });
  });

  routeur.delete('/membres/:membreId', exigerAdminGroupe, (req, res) => {
    retirerMembre(contexte, scopeDe(req), parametre(req, 'membreId'));
    res.json({ ok: true });
  });

  routeur.post('/depart', (req, res) => {
    quitter(contexte, scopeDe(req));
    res.json({ ok: true });
  });

  routeur.get('/invitations', exigerAdminGroupe, (req, res) => {
    res.json({ invitations: listerInvitationsEmises(scopeDe(req), versInstant(contexte.horloge())) });
  });

  // 202 et un corps neutre : l'émission ne dit pas si elle a créé une invitation (voir services/groupes.ts).
  routeur.post('/invitations', exigerAdminGroupe, cadence(contexte, 'invitation'), (req, res) => {
    const corps = analyser(schemaInvitation, req.body);
    inviter(contexte, exigerSession(req), scopeDe(req), corps);
    res.status(202).json({ ok: true });
  });

  routeur.delete('/invitations/:invitationId', exigerAdminGroupe, (req, res) => {
    revoquerInvitation(contexte, scopeDe(req), parametre(req, 'invitationId'));
    res.json({ ok: true });
  });

  // Visibilité par défaut et disponibilités partagées dans ce groupe (lot 8).
  routeur.put('/ma-visibilite', (req, res) => {
    const { visibility } = analyser(schemaVisibiliteDefaut, req.body);
    res.json(changerMaVisibiliteDefaut(scopeDe(req), visibility));
  });

  routeur.get('/disponibilites', (req, res) => {
    const fenetre = analyser(schemaFenetre, req.query);
    res.json({ disponibilites: disponibilitesDuGroupe(scopeDe(req), fenetre) });
  });

  // L'agenda du groupe (lot 4) : monté par `monter`, pour que le registre de cloisonnement en voie les routes.
  monter(routeur, '/evenements', routesEvenements(contexte));

  // Listes de courses, tâches et flux temps réel (lot 6) : mêmes règles, `monter` pour que le registre en voie les routes.
  monter(routeur, '/listes', routesListes(contexte));
  monter(routeur, '/taches', routesTaches(contexte));
  monter(routeur, '/temps-reel', routesTempsReel(contexte));

  // Sondages de dates (lot 7).
  monter(routeur, '/sondages', routesSondages(contexte));

  // Dépenses partagées, remboursements et soldes (lot 9).
  monter(routeur, '/depenses', routesDepenses(contexte));
  monter(routeur, '/remboursements', routesRemboursements(contexte));
  monter(routeur, '/soldes', routesSoldes());

  // Fils de discussion libres et messages (lot 10).
  monter(routeur, '/fils', routesFils(contexte));

  // Photos / Immich (lot 11).
  monter(routeur, '/immich', routesImmich(contexte));
  monter(routeur, '/albums', routesAlbums(contexte));

  return routeur;
}
