import { Router } from 'express';
import { assignerTache, creerTache, listerTaches, modifierTache, supprimerTache } from '../../services/taches-evenement.js';
import type { Contexte } from '../contexte.js';
import { scopeDe } from '../middleware/appartenance.js';
import { parametre } from '../parametres.js';
import { schemaAssignation, schemaFiltreTaches, schemaModificationTache, schemaNouvelleTache } from '../schemas/taches.js';
import { analyser } from '../schemas/valider.js';

// /api/groupes/:groupId/taches : le « qui apporte quoi ». Derrière `exigerAppartenance` (404 hors du groupe). Tout membre actif crée,
// modifie ou supprime une tâche ; seule la RÉASSIGNATION de la tâche de quelqu'un d'autre est un droit (403, services/taches-evenement.ts).

export function routesTaches(contexte: Contexte): Router {
  const routeur = Router({ mergeParams: true });

  routeur.get('/', (req, res) => {
    res.json({ taches: listerTaches(scopeDe(req), analyser(schemaFiltreTaches, req.query).event_id) });
  });

  routeur.post('/', (req, res) => {
    res.status(201).json(creerTache(contexte, scopeDe(req), analyser(schemaNouvelleTache, req.body)));
  });

  routeur.patch('/:tacheId', (req, res) => {
    res.json(modifierTache(contexte, scopeDe(req), parametre(req, 'tacheId'), analyser(schemaModificationTache, req.body)));
  });

  routeur.delete('/:tacheId', (req, res) => {
    supprimerTache(contexte, scopeDe(req), parametre(req, 'tacheId'));
    res.json({ ok: true });
  });

  // Le seul identifiant de membre lu dans un corps de ce lot : déclaré au registre de cloisonnement (`ressourcesCorps`).
  routeur.put('/:tacheId/assignation', (req, res) => {
    const { assignee_membership_id: cible } = analyser(schemaAssignation, req.body);
    res.json(assignerTache(contexte, scopeDe(req), parametre(req, 'tacheId'), cible));
  });

  return routeur;
}
