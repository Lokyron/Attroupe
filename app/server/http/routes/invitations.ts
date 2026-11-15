import { Router, type Request } from 'express';
import { FORME_JETON } from '../../domain/jetons.js';
import { accepterParJeton, apercu } from '../../services/invitations.js';
import type { Contexte } from '../contexte.js';
import { ErreurHttp } from '../erreurs.js';
import { cadence } from '../middleware/cadence.js';
import { exigerSession } from '../middleware/session.js';

// /api/invitations : invitations par LIEN (jeton dans l'e-mail). L'aperçu est public (le lien est le secret) ; l'acceptation
// exige une session, une adresse vérifiée et identique à celle invitée. Un jeton mal formé est « inconnu », sans autre détail.
// Le jeton voyage dans le CORPS (`{ token }`), comme au lot 2 : jamais dans l'URL, donc jamais dans le journal d'accès ni celui d'un proxy.

function jetonDuCorps(req: Request): string {
  const corps: unknown = req.body;
  const jeton = typeof corps === 'object' && corps !== null && 'token' in corps ? corps.token : undefined;
  if (typeof jeton !== 'string' || !FORME_JETON.test(jeton)) throw new ErreurHttp(404, 'invitation.introuvable');
  return jeton;
}

export function routesInvitations(contexte: Contexte): Router {
  const routeur = Router();

  routeur.post('/apercu', cadence(contexte, 'jeton'), (req, res) => {
    res.json(apercu(contexte, jetonDuCorps(req)));
  });

  routeur.post('/acceptation', cadence(contexte, 'jeton'), (req, res) => {
    const auth = exigerSession(req);
    accepterParJeton(contexte, auth, jetonDuCorps(req));
    res.json({ ok: true });
  });

  return routeur;
}
