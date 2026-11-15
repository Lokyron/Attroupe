import { Router, type Request } from 'express';
import { authentification, effacerCookieSession, hacherAdresse, poserCookieSession } from '../middleware/session.js';
import { revoquerSession } from '../../db/queries/comptes.js';
import { versInstant } from '../../domain/instant.js';
import { connecter, demanderReinitialisation, inscrire, reinitialiser, verifierEmail } from '../../services/authentification.js';
import { cadence, adresseClient, cleCouple } from '../middleware/cadence.js';
import type { Contexte } from '../contexte.js';
import { schemaConnexion, schemaInscription, schemaOubli, schemaReinitialisation, schemaVerification } from '../schemas/auth.js';
import { analyser } from '../schemas/valider.js';

// /api/auth : routes SANS session (sauf la déconnexion, qui est tolérante). Ordre sur chaque route :
// CSRF (global) → corps JSON (global) → cadence → validation → cas d'usage.

/** User-Agent tronqué et nettoyé : affiché dans « mes appareils », jamais interprété. */
function userAgentDe(req: Request): string | null {
  const brut = req.get('user-agent');
  // eslint-disable-next-line no-control-regex -- on retire précisément les caractères de contrôle
  const propre = brut?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return propre === undefined || propre === '' ? null : propre;
}

export function routesAuth(contexte: Contexte): Router {
  const routeur = Router();

  // Réponse volontairement identique que l'adresse soit nouvelle ou déjà inscrite.
  routeur.post('/inscription', cadence(contexte, 'inscription'), async (req, res) => {
    const corps = analyser(schemaInscription, req.body);
    await inscrire(contexte, { email: corps.email, username: corps.username, display_name: corps.display_name, password: corps.password });
    res.status(202).json({ ok: true });
  });

  routeur.post('/email/verification', cadence(contexte, 'jeton'), (req, res) => {
    verifierEmail(contexte, analyser(schemaVerification, req.body).token);
    res.json({ ok: true });
  });

  routeur.post('/connexion', cadence(contexte, 'connexion'), async (req, res) => {
    const corps = analyser(schemaConnexion, req.body);
    const session = await connecter(contexte, corps.email, corps.password, {
      userAgent: userAgentDe(req),
      ipHash: hacherAdresse(contexte, adresseClient(req)),
    });
    // Connexion réussie : le compteur du couple (CETTE adresse e-mail, CETTE IP) repart de zéro ; ni celui de l'IP,
    // ni celui, large, de l'adresse e-mail ne bougent.
    contexte.limiteur.oublier(cleCouple('connexion', corps.email, adresseClient(req)));
    poserCookieSession(res, contexte, session.jeton, session.expireLe);
    res.json({ ok: true });
  });

  // Tolérante : sans session valide on efface quand même le cookie et on répond 200 (déconnexion idempotente).
  routeur.post('/deconnexion', (req, res) => {
    const auth = authentification(req);
    if (auth !== undefined) revoquerSession(auth.portee, auth.sessionId, versInstant(contexte.horloge()));
    effacerCookieSession(res, contexte);
    res.json({ ok: true });
  });

  routeur.post('/mot-de-passe/oubli', cadence(contexte, 'oubli'), async (req, res) => {
    await demanderReinitialisation(contexte, analyser(schemaOubli, req.body).email);
    res.status(202).json({ ok: true });
  });

  routeur.post('/mot-de-passe/reinitialisation', cadence(contexte, 'jeton'), async (req, res) => {
    const corps = analyser(schemaReinitialisation, req.body);
    await reinitialiser(contexte, corps.token, corps.password);
    res.json({ ok: true });
  });

  return routeur;
}
