import { Router } from 'express';
import {
  ajouterOption,
  annulerSondage,
  convertirSondage,
  creerSondage,
  detailSondage,
  listerSondages,
  modifierSondage,
  retirerOption,
  voterSondage,
} from '../../services/sondages.js';
import type { Contexte } from '../contexte.js';
import { scopeDe } from '../middleware/appartenance.js';
import { parametre } from '../parametres.js';
import {
  schemaConversionSondage,
  schemaModificationSondage,
  schemaNouveauSondage,
  schemaOptionSondage,
  schemaVoteSondage,
} from '../schemas/sondages.js';
import { analyser } from '../schemas/valider.js';

// /api/groupes/:groupId/sondages : sondages de dates du groupe (lot 7). Monté sous le préfixe du groupe,
// donc protégé par `exigerAppartenance` (404 hors du groupe).

export function routesSondages(contexte: Contexte): Router {
  const routeur = Router({ mergeParams: true });

  routeur.get('/', (req, res) => {
    res.json({ sondages: listerSondages(scopeDe(req)) });
  });

  routeur.post('/', (req, res) => {
    const corps = analyser(schemaNouveauSondage, req.body);
    res.status(201).json(creerSondage(contexte, scopeDe(req), corps));
  });

  routeur.get('/:sondageId', (req, res) => {
    res.json(detailSondage(scopeDe(req), parametre(req, 'sondageId')));
  });

  routeur.patch('/:sondageId', (req, res) => {
    const champs = analyser(schemaModificationSondage, req.body);
    res.json(modifierSondage(contexte, scopeDe(req), parametre(req, 'sondageId'), champs));
  });

  routeur.delete('/:sondageId', (req, res) => {
    res.json(annulerSondage(contexte, scopeDe(req), parametre(req, 'sondageId')));
  });

  routeur.post('/:sondageId/options', (req, res) => {
    const option = analyser(schemaOptionSondage, req.body);
    res.status(201).json(ajouterOption(contexte, scopeDe(req), parametre(req, 'sondageId'), option));
  });

  routeur.delete('/:sondageId/options/:optionId', (req, res) => {
    res.json(retirerOption(contexte, scopeDe(req), parametre(req, 'sondageId'), parametre(req, 'optionId')));
  });

  routeur.put('/:sondageId/options/:optionId/mon-vote', (req, res) => {
    const { value } = analyser(schemaVoteSondage, req.body);
    res.json(voterSondage(contexte, scopeDe(req), parametre(req, 'sondageId'), parametre(req, 'optionId'), value));
  });

  routeur.post('/:sondageId/conversion', (req, res) => {
    const champs = analyser(schemaConversionSondage, req.body);
    res.status(201).json(convertirSondage(contexte, scopeDe(req), parametre(req, 'sondageId'), champs));
  });

  return routeur;
}
