import { Router } from 'express';
import { creerAbonnement, listerAbonnements, revoquerAbonnement } from '../../db/queries/flux.js';
import { mesGroupes } from '../../db/queries/transverse.js';
import { accepter, mesInvitations, refuser } from '../../services/invitations.js';
import { listerSessions, lireProfil, modifierProfil, revoquerAutresSessions, revoquerSession } from '../../db/queries/comptes.js';
import { versInstant } from '../../domain/instant.js';
import { empreinteJeton, nouveauJetonFlux, urlFlux, urlWebcal } from '../../domain/jetons.js';
import { changerMotDePasse, renvoyerVerification } from '../../services/authentification.js';
import type { Contexte } from '../contexte.js';
import { ErreurHttp } from '../erreurs.js';
import { cadence } from '../middleware/cadence.js';
import { exigerSession, gardeSession, poserCookieSession } from '../middleware/session.js';
import { parametre } from '../parametres.js';
import { schemaChangementMotDePasse, schemaProfil } from '../schemas/auth.js';
import { schemaCreationFlux } from '../schemas/flux.js';
import { analyser } from '../schemas/valider.js';

/** Abonnements calendrier non révoqués par compte. */
const MAX_ABONNEMENTS_ACTIFS = 20;

// /api/moi : le compte courant. Tout passe par la `PorteeUtilisateur` de la session : aucune route ici ne
// reçoit un identifiant de compte, donc aucune ne peut viser un autre compte.

export function routesMoi(contexte: Contexte): Router {
  const routeur = Router();
  routeur.use(gardeSession);

  routeur.get('/', (req, res) => {
    const auth = exigerSession(req);
    const { portee } = auth;
    res.json({
      ...lireProfil(portee),
      // Mes groupes (le sélecteur) : appartenances ACTIVES seulement, et le badge « vous avez des invitations ».
      groupes: mesGroupes(portee),
      invitations_en_attente: mesInvitations(contexte, auth).length,
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

  // Invitations reçues (par nom d'utilisateur) : adressées à CE compte seulement. Une invitation d'un autre compte est introuvable (404).
  routeur.get('/invitations', (req, res) => {
    res.json({ invitations: mesInvitations(contexte, exigerSession(req)) });
  });

  routeur.post('/invitations/:invitationId/acceptation', (req, res) => {
    accepter(contexte, exigerSession(req), parametre(req, 'invitationId'));
    res.json({ ok: true });
  });

  routeur.post('/invitations/:invitationId/refus', (req, res) => {
    refuser(contexte, exigerSession(req), parametre(req, 'invitationId'));
    res.json({ ok: true });
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

  // Abonnements calendrier (flux iCal, architecture §7.1). Le jeton n'existe en clair qu'à la création : la base ne garde que son
  // empreinte, la liste ne le rend donc jamais. Tout passe par la portée du compte : un abonnement d'un autre compte est introuvable.
  routeur.get('/flux-ical', (req, res) => {
    const { portee } = exigerSession(req);
    const noms = new Map(mesGroupes(portee).map((g) => [g.group_id, g.name]));
    res.json({
      abonnements: listerAbonnements(portee).map((a) => ({ ...a, group_name: a.group_id === null ? null : (noms.get(a.group_id) ?? null) })),
    });
  });

  routeur.post('/flux-ical', cadence(contexte, 'abonnement'), (req, res) => {
    const { portee } = exigerSession(req);
    const corps = analyser(schemaCreationFlux, req.body);
    // Plafond d'abonnements ACTIFS : une session valide n'insère pas des lignes à l'infini. Les révoqués ne comptent pas.
    if (listerAbonnements(portee).filter((a) => a.revoked_at === null).length >= MAX_ABONNEMENTS_ACTIFS) throw new ErreurHttp(409, 'flux.plafond');
    const groupes = mesGroupes(portee);
    // Restreint à un groupe : l'appartenance doit être ACTIVE. Groupe inconnu, étranger ou quitté : la même réponse, 404.
    const groupe = corps.group_id === null ? undefined : groupes.find((g) => g.group_id === corps.group_id);
    if (corps.group_id !== null && groupe === undefined) throw new ErreurHttp(404, 'groupe.introuvable');
    const jeton = nouveauJetonFlux();
    const url = urlFlux(contexte.env.ATTROUPE_BASE_URL, jeton);
    const abonnement = creerAbonnement(portee, {
      empreinte: empreinteJeton(jeton),
      groupId: corps.group_id,
      label: corps.label,
      includePersonal: corps.include_personal,
      includeDeclined: corps.include_declined,
    });
    // Seule réponse qui porte le jeton ET ses URL, jamais relisibles : la liste n'a que l'empreinte. `url_webcal` fait créer un
    // abonnement sur iOS ; `url` (https) sert au copier-coller (Google Agenda, clients de bureau).
    res.status(201).json({
      ...abonnement,
      group_name: groupe?.name ?? null,
      token: jeton,
      url,
      url_webcal: urlWebcal(url),
    });
  });

  routeur.delete('/flux-ical/:fluxId', (req, res) => {
    const { portee } = exigerSession(req);
    // 404 si l'abonnement n'est pas à moi : un identifiant forgé ne se distingue pas d'un identifiant inconnu.
    if (!revoquerAbonnement(portee, parametre(req, 'fluxId'), versInstant(contexte.horloge()))) throw new ErreurHttp(404, 'flux.introuvable');
    res.json({ ok: true });
  });

  return routeur;
}
