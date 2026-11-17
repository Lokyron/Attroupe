import { Router } from 'express';
import {
  calculerSoldesGroupe,
  confirmerRemboursementService,
  creerDepenseService,
  creerRemboursementService,
  lireDepenseService,
  listerDepensesService,
  listerRemboursementsService,
  modifierDepenseService,
  supprimerDepenseService,
} from '../../services/depenses.js';
import type { Contexte } from '../contexte.js';
import { scopeDe } from '../middleware/appartenance.js';
import { parametre } from '../parametres.js';
import {
  schemaFiltreDepenses,
  schemaFiltreRemboursements,
  schemaFiltreSoldes,
  schemaModificationDepense,
  schemaNouveauRemboursement,
  schemaNouvelleDepense,
} from '../schemas/depenses.js';
import { analyser } from '../schemas/valider.js';

// /api/groupes/:groupId/depenses, /remboursements et /soldes (lot 9).
// Montés sous le préfixe du groupe, donc derrière `exigerAppartenance` (404 hors du groupe).

export function routesDepenses(contexte: Contexte): Router {
  const routeur = Router({ mergeParams: true });

  routeur.get('/', (req, res) => {
    const filtres = analyser(schemaFiltreDepenses, req.query);
    res.json({ depenses: listerDepensesService(scopeDe(req), filtres) });
  });

  routeur.post('/', (req, res) => {
    const corps = analyser(schemaNouvelleDepense, req.body);
    res.status(201).json(creerDepenseService(contexte, scopeDe(req), corps));
  });

  routeur.get('/:depenseId', (req, res) => {
    res.json(lireDepenseService(scopeDe(req), parametre(req, 'depenseId')));
  });

  routeur.patch('/:depenseId', (req, res) => {
    const champs = analyser(schemaModificationDepense, req.body);
    res.json(modifierDepenseService(contexte, scopeDe(req), parametre(req, 'depenseId'), champs));
  });

  routeur.delete('/:depenseId', (req, res) => {
    supprimerDepenseService(contexte, scopeDe(req), parametre(req, 'depenseId'));
    res.json({ ok: true });
  });

  return routeur;
}

export function routesRemboursements(contexte: Contexte): Router {
  const routeur = Router({ mergeParams: true });

  routeur.get('/', (req, res) => {
    const { event_id } = analyser(schemaFiltreRemboursements, req.query);
    res.json({ remboursements: listerRemboursementsService(scopeDe(req), event_id) });
  });

  routeur.post('/', (req, res) => {
    const corps = analyser(schemaNouveauRemboursement, req.body);
    res.status(201).json(creerRemboursementService(contexte, scopeDe(req), corps));
  });

  routeur.post('/:remboursementId/confirmation', (req, res) => {
    res.json(confirmerRemboursementService(contexte, scopeDe(req), parametre(req, 'remboursementId')));
  });

  return routeur;
}

export function routesSoldes(): Router {
  const routeur = Router({ mergeParams: true });

  routeur.get('/', (req, res) => {
    const { evenement } = analyser(schemaFiltreSoldes, req.query);
    res.json(calculerSoldesGroupe(scopeDe(req), evenement));
  });

  return routeur;
}
