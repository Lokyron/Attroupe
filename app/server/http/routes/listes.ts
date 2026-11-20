import { Router } from 'express';
import {
  ajouterArticle,
  creerListe,
  definirFait,
  definirPreneur,
  detailListe,
  listerListes,
  modifierArticle,
  renommerListe,
  retirerArticle,
  supprimerListe,
} from '../../services/listes.js';
import type { Contexte } from '../contexte.js';
import { scopeDe } from '../middleware/appartenance.js';
import { parametre } from '../parametres.js';
import { schemaFait, schemaFiltreListes, schemaModificationArticle, schemaNouvelArticle, schemaNouvelleListe, schemaPreneur, schemaRenommageListe } from '../schemas/listes.js';
import { analyser } from '../schemas/valider.js';

// /api/groupes/:groupId/listes : les listes de courses. Monté sous le préfixe du groupe, donc derrière `exigerAppartenance` (404 hors du
// groupe). Tout membre actif modifie une liste (bien commun) : aucun droit fin, donc aucun 403 ; les conflits de données sont des 409.

export function routesListes(contexte: Contexte): Router {
  const routeur = Router({ mergeParams: true });

  // Filtrable par événement : `?event_id=…` (404 si l'événement n'est pas de CE groupe).
  routeur.get('/', (req, res) => {
    res.json({ listes: listerListes(scopeDe(req), analyser(schemaFiltreListes, req.query).event_id) });
  });

  routeur.post('/', (req, res) => {
    res.status(201).json(creerListe(contexte, scopeDe(req), analyser(schemaNouvelleListe, req.body)));
  });

  routeur.get('/:listeId', (req, res) => {
    res.json(detailListe(scopeDe(req), parametre(req, 'listeId')));
  });

  routeur.patch('/:listeId', (req, res) => {
    res.json(renommerListe(contexte, scopeDe(req), parametre(req, 'listeId'), analyser(schemaRenommageListe, req.body)));
  });

  // Suppression logique : la liste et ses articles disparaissent ensemble.
  routeur.delete('/:listeId', (req, res) => {
    supprimerListe(contexte, scopeDe(req), parametre(req, 'listeId'));
    res.json({ ok: true });
  });

  routeur.post('/:listeId/articles', (req, res) => {
    res.status(201).json(ajouterArticle(contexte, scopeDe(req), parametre(req, 'listeId'), analyser(schemaNouvelArticle, req.body)));
  });

  routeur.patch('/:listeId/articles/:articleId', (req, res) => {
    const champs = analyser(schemaModificationArticle, req.body);
    res.json(modifierArticle(contexte, scopeDe(req), parametre(req, 'listeId'), parametre(req, 'articleId'), champs));
  });

  routeur.delete('/:listeId/articles/:articleId', (req, res) => {
    retirerArticle(contexte, scopeDe(req), parametre(req, 'listeId'), parametre(req, 'articleId'));
    res.json({ ok: true });
  });

  // Le preneur est TOUJOURS l'appelant : aucun identifiant de membre ne transite par le corps. 409 si un autre l'a déjà pris.
  routeur.put('/:listeId/articles/:articleId/preneur', (req, res) => {
    const { prend } = analyser(schemaPreneur, req.body);
    res.json(definirPreneur(contexte, scopeDe(req), parametre(req, 'listeId'), parametre(req, 'articleId'), prend));
  });

  routeur.put('/:listeId/articles/:articleId/fait', (req, res) => {
    const { fait } = analyser(schemaFait, req.body);
    res.json(definirFait(contexte, scopeDe(req), parametre(req, 'listeId'), parametre(req, 'articleId'), fait));
  });

  return routeur;
}
