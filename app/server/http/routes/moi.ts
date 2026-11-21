import { Router } from 'express';
import { z } from 'zod';
import {
  decoderBase64Avatar,
  enregistrerAvatarUtilisateur,
  lireAvatarUtilisateur,
  MIMES_AVATAR,
  supprimerAvatarUtilisateur,
  validerAvatar,
} from '../../db/queries/avatar.js';
import { creerSource, listerMesSources, lireSource, modifierSource, supprimerSource } from '../../db/queries/agenda-externe.js';
import { creerAbonnement, listerAbonnements, revoquerAbonnement } from '../../db/queries/flux.js';
import {
  compterAbonnementsPush,
  enregistrerAbonnementPush,
  supprimerAbonnementsPush,
} from '../../db/queries/push.js';
import { lireTableauDeBord } from '../../db/queries/tableau-de-bord.js';
import { mesGroupes } from '../../db/queries/transverse.js';
import { normaliserUrlSource, publierSource, synchroniserSource, type BilanSynchro } from '../../services/agenda-externe.js';
import {
  creerDansMonAgenda,
  listerMonAgenda,
  modifierDansMonAgenda,
  modifierMonProfil,
  supprimerDeMonAgenda,
} from '../../services/agenda-personnel.js';
import { lireMonCreneau } from '../../services/agenda-personnel-lecture.js';
import { accepter, mesInvitations, refuser } from '../../services/invitations.js';
import { listerSessions, lireProfil, revoquerAutresSessions, revoquerSession } from '../../db/queries/comptes.js';
import { dateValide, fenetreValide } from '../../domain/evenements.js';
import { MINUTE_MS, versInstant } from '../../domain/instant.js';
import { empreinteJeton, nouveauJetonFlux, urlFlux, urlWebcal } from '../../domain/jetons.js';
import { decoderBase64Url, validerEndpointPush } from '../../domain/push.js';
import { changerMotDePasse, renvoyerVerification } from '../../services/authentification.js';
import {
  definirMaPreferenceNotification,
  reprendreMonReglageGlobal,
  marquerLues,
  mesNotifications,
  mesPreferencesNotifications,
  pastilleNotifications,
} from '../../services/notifications.js';
import { envoyerNotificationPush, obtenirClePubliqueVapid } from '../../services/push.js';
import type { Contexte } from '../contexte.js';
import { ErreurHttp } from '../erreurs.js';
import { cadence } from '../middleware/cadence.js';
import { exigerSession, gardeSession, poserCookieSession } from '../middleware/session.js';
import { parametre } from '../parametres.js';
import { schemaModificationSource, schemaNouvelleSource } from '../schemas/agenda-externe.js';
import {
  schemaFenetreAgendaPersonnel,
  schemaIdentifiantCreneau,
  schemaModificationCreneauPersonnel,
  schemaNouveauCreneauPersonnel,
} from '../schemas/agenda-personnel.js';
import { schemaChangementMotDePasse, schemaProfil } from '../schemas/auth.js';
import { schemaCreationFlux } from '../schemas/flux.js';
import { schemaLectureNotifications, schemaListeNotifications, schemaPreferenceNotification } from '../schemas/notifications.js';
import { analyser } from '../schemas/valider.js';

/** Abonnements calendrier non révoqués par compte. */
const MAX_ABONNEMENTS_ACTIFS = 20;
/** Sources d'agenda externe par compte. */
const MAX_SOURCES_AGENDA = 5;
/** Une synchronisation à la demande par source et par fenêtre de cinq minutes. */
const DELAI_SYNCHRO_MANUELLE_MS = 5 * MINUTE_MS;

/** Résultat d'une synchronisation tel que l'API le rend. */
function publierBilan(bilan: BilanSynchro): { statut: string; creneaux_importes: number; ignores: number; modifiee: boolean; desactivee: boolean } {
  return { statut: bilan.statut, creneaux_importes: bilan.creneaux, ignores: bilan.ignores, modifiee: bilan.modifiee, desactivee: bilan.desactivee };
}

const jourOptionnel = z.string().refine(dateValide).optional();
const schemaFenetreOptionnelle = z
  .strictObject({ du: jourOptionnel, au: jourOptionnel })
  .superRefine((fenetre, ctx) => {
    if ((fenetre.du !== undefined) !== (fenetre.au !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['du'], message: 'du et au doivent être fournis ensemble' });
      return;
    }
    if (fenetre.du !== undefined && fenetre.au !== undefined && !fenetreValide(fenetre.du, fenetre.au)) {
      ctx.addIssue({ code: 'custom', path: ['au'], message: 'fenêtre invalide' });
    }
  });

const schemaAvatar = z.strictObject({
  mime: z.enum(MIMES_AVATAR),
  data_base64: z.string().min(1),
});

const schemaAbonnementPush = z.strictObject({
  // https seulement ; l'hôte public est vérifié par `validerEndpointPush` (anti-SSRF), pas par le schéma.
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
  keys: z.strictObject({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

const schemaSuppressionAbonnementPush = z.strictObject({
  endpoint: z.url({ protocol: /^https?$/ }).optional(),
});

// /api/moi : le compte courant. Tout passe par la `PorteeUtilisateur` de la session : aucune route ici ne
// reçoit un identifiant de compte, donc aucune ne peut viser un autre compte.

export function routesMoi(contexte: Contexte): Router {
  const routeur = Router();
  routeur.use(gardeSession);

  routeur.get('/', (req, res) => {
    const auth = exigerSession(req);
    const { portee } = auth;
    const invitations = mesInvitations(contexte, auth);
    res.json({
      ...lireProfil(portee),
      // Mes groupes (le sélecteur) : appartenances ACTIVES seulement, et le badge « vous avez des invitations ».
      groupes: mesGroupes(portee),
      invitations_en_attente: invitations.length,
      // Pastille de « Notifs », calculée ici une fois pour toutes : le client n'additionne rien (cf. `compterNotificationsAVoir`).
      notifications_a_voir: pastilleNotifications(
        portee,
        invitations.map((i) => i.id),
      ),
      // Sans clé Brevo les e-mails restent en file : l'interface doit le dire (architecture §7.3).
      service_email: contexte.env.BREVO_API_KEY === undefined ? 'non_configure' : 'actif',
    });
  });

  routeur.get('/tableau-de-bord', (req, res) => {
    const { portee } = exigerSession(req);
    const fenetre = analyser(schemaFenetreOptionnelle, req.query);
    res.json(
      lireTableauDeBord(contexte.base, portee, {
        maintenant: contexte.horloge(),
        signedUrlSecret: contexte.env.ATTROUPE_SIGNED_URL_SECRET,
        ...(fenetre.du !== undefined && fenetre.au !== undefined ? { du: fenetre.du, au: fenetre.au } : {}),
      }),
    );
  });

  routeur.patch('/', (req, res) => {
    const { portee } = exigerSession(req);
    const champs = analyser(schemaProfil(contexte.horloge()), req.body);
    res.json(modifierMonProfil(portee, champs, versInstant(contexte.horloge())));
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

  // Sources d'agenda externe (ADR-0013). L'URL est un secret porteur : elle n'est JAMAIS rendue, la liste n'expose que `url_host`.
  // Une source d'un autre compte est introuvable (404 `source.introuvable`), comme un identifiant inconnu.
  const synchro = (portee: Parameters<typeof synchroniserSource>[1], id: string): Promise<BilanSynchro | undefined> =>
    synchroniserSource(
      { cleChiffrement: contexte.env.ATTROUPE_ENCRYPTION_KEY, horloge: contexte.horloge, journal: contexte.journal, dependances: contexte.agendaExterne },
      portee,
      id,
    );

  routeur.get('/agenda/sources', (req, res) => {
    const { portee } = exigerSession(req);
    res.json({ sources: listerMesSources(portee).map(publierSource) });
  });

  // Crée PUIS synchronise immédiatement et synchroniquement : c'est le seul moyen de valider l'URL et d'annoncer le résultat à l'utilisateur.
  // La source est créée même si cette première synchronisation échoue : le statut dit pourquoi, la suppression est à un clic.
  routeur.post('/agenda/sources', cadence(contexte, 'import_agenda'), async (req, res) => {
    const { portee } = exigerSession(req);
    const corps = analyser(schemaNouvelleSource, req.body);
    // Une seule erreur pour toute cause de forme : on ne renseigne pas sur ce qui a été reconnu ou non.
    const url = normaliserUrlSource(corps.url);
    if (url === undefined) throw new ErreurHttp(400, 'source.url_invalide');
    if (listerMesSources(portee).length >= MAX_SOURCES_AGENDA) throw new ErreurHttp(409, 'source.plafond');
    const cree = creerSource(
      portee,
      { label: corps.label ?? url.hote.slice(0, 60), url: url.href, hote: url.hote, prochaineTentative: versInstant(contexte.horloge()) },
      contexte.env.ATTROUPE_ENCRYPTION_KEY,
    );
    if (!cree.ok) throw new ErreurHttp(409, 'source.deja_presente');
    const bilan = await synchro(portee, cree.id);
    const source = lireSource(portee, cree.id);
    if (bilan === undefined || source === undefined) throw new ErreurHttp(404, 'source.introuvable');
    res.status(201).json({ ...publierSource(source), synchronisation: publierBilan(bilan) });
  });

  routeur.patch('/agenda/sources/:id', (req, res) => {
    const { portee } = exigerSession(req);
    const id = parametre(req, 'id');
    const champs = analyser(schemaModificationSource, req.body);
    if (lireSource(portee, id) === undefined) throw new ErreurHttp(404, 'source.introuvable');
    const maintenant = versInstant(contexte.horloge());
    modifierSource(portee, id, {
      label: champs.label,
      // Réactiver repart à neuf (compteur d'échecs à zéro, essai immédiat) ; désactiver ne touche ni aux créneaux ni à l'état.
      ...(champs.disabled === true ? { disabled_at: maintenant } : {}),
      ...(champs.disabled === false ? { disabled_at: null, consecutive_failures: 0, next_attempt_at: maintenant } : {}),
    });
    const source = lireSource(portee, id);
    if (source === undefined) throw new ErreurHttp(404, 'source.introuvable');
    res.json(publierSource(source));
  });

  routeur.delete('/agenda/sources/:id', (req, res) => {
    const { portee } = exigerSession(req);
    if (!supprimerSource(portee, parametre(req, 'id'))) throw new ErreurHttp(404, 'source.introuvable');
    res.json({ ok: true });
  });

  routeur.post('/agenda/sources/:id/synchronisation', cadence(contexte, 'import_agenda'), async (req, res) => {
    const { portee } = exigerSession(req);
    const id = parametre(req, 'id');
    const avant = lireSource(portee, id);
    if (avant === undefined) throw new ErreurHttp(404, 'source.introuvable');
    if (avant.last_attempt_at !== null) {
      const attenteMs = new Date(avant.last_attempt_at).getTime() + DELAI_SYNCHRO_MANUELLE_MS - contexte.horloge().getTime();
      if (attenteMs > 0) {
        const secondes = Math.ceil(attenteMs / 1000);
        throw new ErreurHttp(429, 'cadence.depassee', secondes);
      }
    }
    const bilan = await synchro(portee, id);
    const source = lireSource(portee, id);
    if (bilan === undefined || source === undefined) throw new ErreurHttp(404, 'source.introuvable');
    res.json({ ...publierSource(source), synchronisation: publierBilan(bilan) });
  });

  // Agenda personnel (lot 8, modèle §3.6). Tout passe par la `PorteeUtilisateur` : le créneau d'un autre compte est introuvable (404).
  routeur.get('/agenda', (req, res) => {
    const { portee } = exigerSession(req);
    const fenetre = analyser(schemaFenetreAgendaPersonnel, req.query);
    res.json({ creneaux: listerMonAgenda(portee, fenetre, contexte.env.ATTROUPE_ENCRYPTION_KEY, contexte.journal) });
  });

  // Un seul créneau, porté sur le compte connecté : celui d'un autre compte (ou supprimé) est un 404, identifiant forgé ou non.
  routeur.get('/agenda/:creneauId', (req, res) => {
    const { portee } = exigerSession(req);
    const { creneauId } = analyser(schemaIdentifiantCreneau, { creneauId: parametre(req, 'creneauId') });
    res.json(lireMonCreneau(portee, creneauId, contexte.env.ATTROUPE_ENCRYPTION_KEY, contexte.journal));
  });

  routeur.post('/agenda', (req, res) => {
    const { portee } = exigerSession(req);
    const corps = analyser(schemaNouveauCreneauPersonnel, req.body);
    res.status(201).json(creerDansMonAgenda(portee, corps));
  });

  routeur.patch('/agenda/:id', (req, res) => {
    const { portee } = exigerSession(req);
    const champs = analyser(schemaModificationCreneauPersonnel, req.body);
    res.json(modifierDansMonAgenda(portee, parametre(req, 'id'), champs));
  });

  routeur.delete('/agenda/:id', (req, res) => {
    const { portee } = exigerSession(req);
    supprimerDeMonAgenda(portee, parametre(req, 'id'));
    res.json({ ok: true });
  });

  // Notifications et préférences d'envoi par e-mail (lot 10).
  routeur.get('/notifications', (req, res) => {
    const { portee } = exigerSession(req);
    const options = analyser(schemaListeNotifications, req.query);
    res.json(mesNotifications(contexte, portee, options));
  });

  routeur.post('/notifications/lecture', (req, res) => {
    const { portee } = exigerSession(req);
    const { ids } = analyser(schemaLectureNotifications, req.body);
    res.json({ lues: marquerLues(contexte, portee, ids) });
  });

  routeur.get('/preferences-notifications', (req, res) => {
    const { portee } = exigerSession(req);
    res.json({ preferences: mesPreferencesNotifications(portee) });
  });

  routeur.put('/preferences-notifications', (req, res) => {
    const { portee } = exigerSession(req);
    const { group_id, email_mode, muted_kinds } = analyser(schemaPreferenceNotification, req.body);
    res.json({ preferences: definirMaPreferenceNotification(portee, group_id, email_mode, muted_kinds) });
  });

  routeur.delete('/preferences-notifications/:groupeId', (req, res) => {
    const { portee } = exigerSession(req);
    res.json({ preferences: reprendreMonReglageGlobal(portee, parametre(req, 'groupeId')) });
  });

  // Photo de profil utilisateur.
  routeur.get('/avatar', (req, res) => {
    const { portee } = exigerSession(req);
    const avatar = lireAvatarUtilisateur(portee, portee.userId);
    if (avatar === null) throw new ErreurHttp(404, 'avatar.introuvable');
    res.set('Content-Type', avatar.mime);
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(avatar.data);
  });

  routeur.put('/avatar', (req, res) => {
    const { portee } = exigerSession(req);
    const corps = analyser(schemaAvatar, req.body);
    const data = decoderBase64Avatar(corps.data_base64);
    if (data === null) throw new ErreurHttp(400, 'avatar.invalide');
    const validation = validerAvatar(corps.mime, data);
    if (validation === 'trop_volumineux') throw new ErreurHttp(400, 'avatar.trop_volumineux');
    if (validation !== 'ok') throw new ErreurHttp(400, 'avatar.invalide');
    const avatarUrl = enregistrerAvatarUtilisateur(portee, corps.mime, data, versInstant(contexte.horloge()));
    res.json({ avatar_url: avatarUrl });
  });

  routeur.delete('/avatar', (req, res) => {
    const { portee } = exigerSession(req);
    supprimerAvatarUtilisateur(portee, versInstant(contexte.horloge()));
    res.json({ ok: true });
  });

  // Notifications Push Web (VAPID + RFC 8291).
  routeur.get('/push/cle', (req, res) => {
    const { portee } = exigerSession(req);
    res.json({
      cle_publique: obtenirClePubliqueVapid(contexte.base, contexte.env),
      nb_appareils: compterAbonnementsPush(portee),
    });
  });

  routeur.post('/push/abonnement', cadence(contexte, 'push'), (req, res) => {
    const { portee } = exigerSession(req);
    const corps = analyser(schemaAbonnementPush, req.body);
    // Anti-SSRF : le serveur POSTera vers cette URL. Hôte non public, port inhabituel, identifiants : refusés, sans dire pourquoi.
    // (La résolution DNS est vérifiée, et la connexion épinglée, à chaque envoi : un nom peut changer d'adresse après coup.)
    if (!validerEndpointPush(corps.endpoint).valide) throw new ErreurHttp(400, 'push.endpoint_invalide');
    const p256dhBrut = decoderBase64Url(corps.keys.p256dh);
    const authBrut = decoderBase64Url(corps.keys.auth);
    if (p256dhBrut.length !== 65 || p256dhBrut[0] !== 0x04 || authBrut.length !== 16) {
      throw new ErreurHttp(400, 'push.cles_invalides');
    }
    const id = enregistrerAbonnementPush(portee, {
      endpoint: corps.endpoint,
      p256dh: corps.keys.p256dh,
      auth: corps.keys.auth,
      userAgent: req.get('user-agent') ?? null,
    });
    res.status(201).json({ ok: true, id });
  });

  routeur.delete('/push/abonnement', (req, res) => {
    const { portee } = exigerSession(req);
    const corps = analyser(schemaSuppressionAbonnementPush, req.body ?? {});
    const supprimes = supprimerAbonnementsPush(portee, corps.endpoint);
    res.json({ supprimes });
  });

  // L'envoi part en arrière-plan et la réponse est un simple accusé : elle ne dépend ni du résultat ni de la durée de l'appel vers
  // l'endpoint (sinon `{envoyes, echecs}` et le temps de réponse renseigneraient sur ce que joint le serveur : oracle SSRF).
  routeur.post('/push/test', cadence(contexte, 'push'), (req, res) => {
    const { portee } = exigerSession(req);
    const appareils = compterAbonnementsPush(portee);
    envoyerNotificationPush(
      contexte.base,
      portee.userId,
      {
        title: 'Attroupe',
        body: 'Les notifications push sont bien activées sur cet appareil.',
        url: '/',
        tag: 'test',
      },
      { env: contexte.env, journal: contexte.journal, maintenant: contexte.horloge() },
    ).catch((erreur: unknown) => {
      contexte.journal.error('push.envoi_impossible', { erreur: erreur instanceof Error ? erreur.message : String(erreur) });
    });
    res.status(202).json({ ok: true, appareils });
  });

  return routeur;
}
