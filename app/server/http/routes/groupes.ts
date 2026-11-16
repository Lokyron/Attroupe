import { Router } from 'express';
import { listerInvitationsEmises } from '../../db/queries/invitations.js';
import { listerMembres } from '../../db/queries/membres.js';
import { mesGroupes } from '../../db/queries/transverse.js';
import { versInstant } from '../../domain/instant.js';
import { changerRole, creerNouveauGroupe, detailGroupe, inviter, modifierGroupe, quitter, retirerMembre, revoquerInvitation } from '../../services/groupes.js';
import type { Contexte } from '../contexte.js';
import { exigerAdminGroupe, exigerAppartenance, scopeDe } from '../middleware/appartenance.js';
import { cadence } from '../middleware/cadence.js';
import { exigerSession, gardeSession } from '../middleware/session.js';
import { monter } from '../montage.js';
import { parametre } from '../parametres.js';
import { schemaChangementRole, schemaCreationGroupe, schemaInvitation, schemaModificationGroupe } from '../schemas/groupes.js';
import { analyser } from '../schemas/valider.js';
import { routesEvenements } from './evenements.js';

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

  // L'agenda du groupe (lot 4) : monté par `monter`, pour que le registre de cloisonnement en voie les routes.
  monter(routeur, '/evenements', routesEvenements(contexte));

  return routeur;
}
