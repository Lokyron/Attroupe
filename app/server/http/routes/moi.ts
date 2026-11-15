import { Router } from 'express';
import { listerSessions, lireProfil, modifierProfil, revoquerAutresSessions, revoquerSession } from '../../db/queries/comptes.js';
import { versInstant } from '../../domain/instant.js';
import { changerMotDePasse, renvoyerVerification } from '../../services/authentification.js';
import type { Contexte } from '../contexte.js';
import { ErreurHttp } from '../erreurs.js';
import { cadence } from '../middleware/cadence.js';
import { exigerSession, gardeSession, poserCookieSession } from '../middleware/session.js';
import { schemaChangementMotDePasse, schemaProfil } from '../schemas/auth.js';
import { analyser } from '../schemas/valider.js';

// /api/moi : le compte courant. Tout passe par la `PorteeUtilisateur` de la session : aucune route ici ne
// reçoit un identifiant de compte, donc aucune ne peut viser un autre compte.

export function routesMoi(contexte: Contexte): Router {
  const routeur = Router();
  routeur.use(gardeSession);

  routeur.get('/', (req, res) => {
    const { portee } = exigerSession(req);
    res.json({
      ...lireProfil(portee),
      // Sans clé Brevo les e-mails restent en file : l'interface doit le dire (architecture §7.3).
      service_email: contexte.env.BREVO_API_KEY === undefined ? 'non_configure' : 'actif',
    });
  });

  routeur.patch('/', (req, res) => {
    const { portee } = exigerSession(req);
    const champs = analyser(schemaProfil(contexte.horloge()), req.body);
    modifierProfil(portee, champs, versInstant(contexte.horloge()));
    res.json(lireProfil(portee));
  });

  // Ancien mot de passe vérifié, nouveau posé, autres sessions révoquées, jeton de CETTE session renouvelé (nouveau cookie).
  routeur.post('/mot-de-passe', cadence(contexte, 'changement'), async (req, res) => {
    const auth = exigerSession(req);
    const corps = analyser(schemaChangementMotDePasse, req.body);
    const session = await changerMotDePasse(contexte, auth, corps.current_password, corps.new_password);
    poserCookieSession(res, contexte, session.jeton, session.expireLe);
    res.json({ ok: true });
  });

  // Renvoie le mail de vérification d'adresse : un lien expiré ou perdu se rattrape ici.
  routeur.post('/email/verification', cadence(contexte, 'renvoi'), (req, res) => {
    renvoyerVerification(contexte, exigerSession(req));
    res.status(202).json({ ok: true });
  });

  routeur.get('/sessions', (req, res) => {
    const { portee, sessionId } = exigerSession(req);
    const sessions = listerSessions(portee, versInstant(contexte.horloge()));
    res.json({ sessions: sessions.map((s) => ({ ...s, courante: s.id === sessionId })) });
  });

  // « Révoquer tout le reste » : toutes mes sessions sauf celle-ci.
  routeur.delete('/sessions', (req, res) => {
    const { portee, sessionId } = exigerSession(req);
    res.json({ revoquees: revoquerAutresSessions(portee, sessionId, versInstant(contexte.horloge())) });
  });

  routeur.delete('/sessions/:id', (req, res) => {
    const { portee } = exigerSession(req);
    // 404 si la session n'est pas à moi : un identifiant forgé ne se distingue pas d'un identifiant inconnu.
    if (!revoquerSession(portee, req.params.id, versInstant(contexte.horloge()))) throw new ErreurHttp(404, 'session.introuvable');
    res.json({ ok: true });
  });

  return routeur;
}
