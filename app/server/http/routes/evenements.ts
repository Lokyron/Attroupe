import { Router } from 'express';
import { cloturerEvenementService, reouvrirEvenementService } from '../../services/depenses.js';
import type { Contexte } from '../contexte.js';
import { scopeDe } from '../middleware/appartenance.js';
import { parametre } from '../parametres.js';
import { schemaFenetre, schemaModificationEvenement, schemaNouvelEvenement, schemaPresence } from '../schemas/evenements.js';
import { analyser } from '../schemas/valider.js';
import {
  ajouterOrganisateur,
  annulerEvenement,
  creerEvenement,
  detailEvenement,
  listerEvenements,
  modifierEvenement,
  presencesEvenement,
  repondrePresence,
  retirerOrganisateur,
} from '../../services/evenements.js';

// /api/groupes/:groupId/evenements : l'agenda du groupe. Monté sous le préfixe du groupe, donc derrière `exigerAppartenance`
// (404 hors du groupe). Les routes qui modifient l'événement (PATCH, DELETE, organisateurs) ajoutent le droit fin
// `peutModifierEvenement` (403) dans le service, APRÈS avoir trouvé l'événement dans le groupe (404) : les deux codes ne se croisent pas.

export function routesEvenements(contexte: Contexte): Router {
  const routeur = Router({ mergeParams: true });

  routeur.get('/', (req, res) => {
    res.json({ evenements: listerEvenements(scopeDe(req), analyser(schemaFenetre, req.query)) });
  });

  // Crée l'événement ET son fil de discussion, dans la même transaction.
  routeur.post('/', (req, res) => {
    res.status(201).json(creerEvenement(contexte, scopeDe(req), analyser(schemaNouvelEvenement, req.body)));
  });

  routeur.get('/:evenementId', (req, res) => {
    res.json(detailEvenement(scopeDe(req), parametre(req, 'evenementId')));
  });

  routeur.patch('/:evenementId', (req, res) => {
    const champs = analyser(schemaModificationEvenement, req.body);
    res.json(modifierEvenement(scopeDe(req), parametre(req, 'evenementId'), champs));
  });

  // Annulation, pas suppression : l'événement reste lisible avec `status = 'cancelled'`.
  routeur.delete('/:evenementId', (req, res) => {
    res.json(annulerEvenement(scopeDe(req), parametre(req, 'evenementId')));
  });

  // La réponse est TOUJOURS celle de l'appelant : aucun identifiant de membre ne transite par le corps.
  routeur.put('/:evenementId/ma-presence', (req, res) => {
    const reponse = analyser(schemaPresence, req.body);
    res.json(repondrePresence(contexte, scopeDe(req), parametre(req, 'evenementId'), reponse));
  });

  routeur.get('/:evenementId/presences', (req, res) => {
    res.json(presencesEvenement(scopeDe(req), parametre(req, 'evenementId')));
  });

  routeur.post('/:evenementId/organisateurs/:membreId', (req, res) => {
    res.json(ajouterOrganisateur(contexte, scopeDe(req), parametre(req, 'evenementId'), parametre(req, 'membreId')));
  });

  routeur.delete('/:evenementId/organisateurs/:membreId', (req, res) => {
    res.json(retirerOrganisateur(scopeDe(req), parametre(req, 'evenementId'), parametre(req, 'membreId')));
  });

  routeur.post('/:evenementId/cloture', (req, res) => {
    res.status(201).json(cloturerEvenementService(contexte, scopeDe(req), parametre(req, 'evenementId')));
  });

  routeur.delete('/:evenementId/cloture', (req, res) => {
    res.json(reouvrirEvenementService(contexte, scopeDe(req), parametre(req, 'evenementId')));
  });

  return routeur;
}
