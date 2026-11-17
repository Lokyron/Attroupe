import { Router } from 'express';
import {
  creerFilLibreDansGroupe,
  listerFilsDuGroupe,
  listerMessagesDuFil,
  modifierMessageDansFil,
  posterMessageDansFil,
  supprimerMessageDansFil,
} from '../../services/fils.js';
import type { Contexte } from '../contexte.js';
import { scopeDe } from '../middleware/appartenance.js';
import { parametre } from '../parametres.js';
import { schemaCreationFil, schemaMessage, schemaRequeteMessages } from '../schemas/fils.js';
import { analyser } from '../schemas/valider.js';

// /api/groupes/:groupId/fils (lot 10). `exigerAppartenance` est déjà posé sur le routeur parent.

export function routesFils(contexte: Contexte): Router {
  const routeur = Router({ mergeParams: true });

  routeur.get('/', (req, res) => {
    res.json({ fils: listerFilsDuGroupe(scopeDe(req)) });
  });

  routeur.post('/', (req, res) => {
    const { title } = analyser(schemaCreationFil, req.body);
    res.status(201).json(creerFilLibreDansGroupe(scopeDe(req), title));
  });

  routeur.get('/:filId/messages', (req, res) => {
    const { avant, limite } = analyser(schemaRequeteMessages, req.query);
    res.json(listerMessagesDuFil(scopeDe(req), parametre(req, 'filId'), avant, limite));
  });

  routeur.post('/:filId/messages', (req, res) => {
    const { body } = analyser(schemaMessage, req.body);
    res.status(201).json(posterMessageDansFil(contexte, scopeDe(req), parametre(req, 'filId'), body));
  });

  routeur.patch('/:filId/messages/:messageId', (req, res) => {
    const { body } = analyser(schemaMessage, req.body);
    res.json(modifierMessageDansFil(contexte, scopeDe(req), parametre(req, 'filId'), parametre(req, 'messageId'), body));
  });

  routeur.delete('/:filId/messages/:messageId', (req, res) => {
    supprimerMessageDansFil(contexte, scopeDe(req), parametre(req, 'filId'), parametre(req, 'messageId'));
    res.json({ ok: true });
  });

  return routeur;
}
