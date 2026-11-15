import type { NextFunction, Request, Response } from 'express';
import { ErreurHttp } from '../erreurs.js';

/** Statut HTTP porté par une erreur (ex. corps JSON mal formé : 400), s'il est de la famille 4xx. */
function statutClient(erreur: unknown): number | undefined {
  if (typeof erreur !== 'object' || erreur === null || !('status' in erreur)) return undefined;
  const { status } = erreur;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500 ? status : undefined;
}

/** Gestionnaire d'erreurs d'Express (quatre paramètres obligatoires pour être reconnu comme tel). */
export function gestionnaireErreurs(erreur: unknown, _req: Request, res: Response, next: NextFunction): void {
  // Les en-têtes sont déjà partis : on ne peut plus répondre, Express fermera la connexion.
  if (res.headersSent) {
    next(erreur);
    return;
  }
  if (erreur instanceof ErreurHttp) {
    if (erreur.retryApresSecondes !== undefined) res.setHeader('Retry-After', String(erreur.retryApresSecondes));
    res.status(erreur.statut).json({ error: erreur.cle, ...(erreur.champs === undefined ? {} : { champs: erreur.champs }) });
    return;
  }
  const statut = statutClient(erreur);
  if (statut !== undefined) {
    // Corps JSON mal formé ou trop gros : jamais de message de l'analyseur, il peut citer le corps (donc un mot de passe).
    res.status(statut).json({ error: 'requete.invalide' });
    return;
  }
  // Pile seulement : l'objet entier d'une erreur d'analyseur peut porter le corps de la requête.
  console.error('Erreur non gérée :', erreur instanceof Error ? (erreur.stack ?? erreur.message) : String(erreur));
  res.status(500).json({ error: 'erreur.interne' });
}
