// Le REGISTRE DE CLOISONNEMENT (architecture §8) : une entrée par route de l'application, avec ce qu'elle exige.
// Il est lu par deux tests :
//  - registre.test.ts (complétude) : la liste des routes réellement montées par Express doit être EXACTEMENT celle du
//    registre. Une route ajoutée sans entrée, ou une entrée sans route, fait échouer l'intégration continue ;
//  - suite-generique.test.ts : pour chaque entrée, les attaques de cloisonnement adaptées à son exigence.
//
// AJOUTER UNE ROUTE : ajouter ici une entrée, et c'est tout — la suite lui applique d'elle-même les attaques.
// Pour une route de groupe, fournir un `corps` VALIDE (sinon la validation répondrait 400 avant que l'attaque
// n'atteigne la ressource) et, pour CHAQUE endroit où la route lit l'identifiant d'une ressource, le déclarer :
//  - `ressources`        : paramètre d'URL (`:membreId`) ;
//  - `ressourcesCorps`   : chemin JSON dans le corps (`payer_membership_id`, `shares.0.membership_id`) ;
//  - `ressourcesRequete` : paramètre de la chaîne de requête (`?event_id=…`).
// Un identifiant lu ailleurs que dans l'URL et non déclaré ici n'est PAS attaqué : c'est à l'auteur de la route de le déclarer.
// Le `corps` doit contenir chaque chemin déclaré (n'importe quelle valeur : la suite y pose les identifiants de A, puis de B).

export type Methode = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 *  - `aucune`       : route publique (inscription, connexion, santé…) ;
 *  - `session`      : exige une session ; elle relève du COMPTE (`/api/moi/*`, sélecteur de groupes) ;
 *  - `appartenance` : sous `/api/groupes/:groupId/…`, exige d'être membre ACTIF du groupe (404 sinon) ;
 *  - `admin`        : idem, et exige d'être administrateur du groupe (403 `droit.admin_requis` sinon) ;
 *  - `organisateur` : idem, et exige de pouvoir modifier l'événement visé (auteur, co-organisateur ou administrateur du groupe :
 *                     403 `droit.organisateur_requis` sinon). La ressource `evenement` est donc déclarée dans `ressources`.
 *  - `jetonFlux`    : HORS `/api`, sans cookie : le jeton de l'URL est l'unique authentification, et la route lit les événements de
 *                     PLUSIEURS groupes sans groupe dans l'URL. Ce n'est PAS `aucune` : `aucune` ne lancerait aucune attaque sur la seule
 *                     route du projet qui agrège plusieurs groupes. Ses attaques sont dans `flux.ts` (jeton inconnu / révoqué, membre
 *                     retiré, jeton restreint à un groupe), menées par des simples membres — jamais par une administratrice.
 */
export type Exigence = 'aucune' | 'session' | 'appartenance' | 'admin' | 'organisateur' | 'jetonFlux' | 'media';

/** Ressource désignée par un paramètre d'URL. Chacune existe en un exemplaire dans chaque monde (A et B) : voir monde.ts. */
export type Ressource =
  | 'membre'
  | 'membreAutre'
  | 'evenement'
  | 'invitation'
  | 'invitationRecue'
  | 'jeton'
  | 'session'
  | 'abonnement'
  | 'jetonFlux'
  | 'liste'
  | 'article'
  | 'articleVoisin'
  | 'tache'
  | 'sondage'
  | 'optionSondage'
  | 'creneauPerso'
  | 'sourceAgenda'
  | 'depense'
  | 'remboursement'
  | 'fil'
  | 'message'
  | 'album'
  | 'photo'
  | 'utilisateur';

export interface EntreeRoute {
  readonly methode: Methode;
  readonly chemin: string;
  readonly exige: Exigence;
  /** Paramètre d'URL (hors `:groupId`) → ressource qu'il désigne. */
  readonly ressources?: Readonly<Record<string, Ressource>>;
  /** Chemin JSON dans `corps` (`a.0.b`) → ressource qu'il désigne. */
  readonly ressourcesCorps?: Readonly<Record<string, Ressource>>;
  /** Paramètre de la chaîne de requête → ressource qu'il désigne. */
  readonly ressourcesRequete?: Readonly<Record<string, Ressource>>;
  /** Chaîne de requête OBLIGATOIRE de la route (valide), à laquelle s'ajoutent les identifiants déclarés dans `ressourcesRequete`. */
  readonly requete?: Readonly<Record<string, string>>;
  /** Corps JSON valide pour la route (les attaques doivent buter sur le cloisonnement, pas sur la validation). */
  readonly corps?: unknown;
  /**
   * Route à réponse ININTERROMPUE (flux SSE) : la suite l'appelle par un vrai socket, lit le statut et le premier message, puis COUPE
   * (tests/fixtures/flux-sse.ts). Sans cela, la suite attendrait une fin qui n'arrive jamais. Les attaques ne changent pas : un étranger
   * doit recevoir son 404 AVANT que le flux ne s'ouvre, et le cas légitime doit s'ouvrir (200, `text/event-stream`).
   */
  readonly flux?: true;
  /** Pour une route `appartenance` dotée d'un droit fin sur l'auteur/bénéficiaire (non admin), clé d'erreur 403 attendue pour Erin. */
  readonly droitFin?: string;
}

/** Clé d'erreur attendue quand la ressource forgée n'existe pas pour l'appelant. */
export const INTROUVABLE: Readonly<Record<Ressource, string>> = {
  membre: 'membre.introuvable',
  membreAutre: 'membre.introuvable',
  evenement: 'evenement.introuvable',
  invitation: 'invitation.introuvable',
  invitationRecue: 'invitation.introuvable',
  jeton: 'invitation.introuvable',
  session: 'session.introuvable',
  abonnement: 'flux.introuvable',
  jetonFlux: 'flux.introuvable',
  liste: 'liste.introuvable',
  article: 'article.introuvable',
  articleVoisin: 'article.introuvable',
  tache: 'tache.introuvable',
  sondage: 'sondage.introuvable',
  optionSondage: 'option.introuvable',
  creneauPerso: 'agenda.introuvable',
  sourceAgenda: 'source.introuvable',
  depense: 'depense.introuvable',
  remboursement: 'remboursement.introuvable',
  fil: 'fil.introuvable',
  message: 'message.introuvable',
  album: 'album.introuvable',
  photo: 'photo.introuvable',
  utilisateur: 'avatar.introuvable',
};

export const PREFIXE_GROUPE = '/api/groupes/:groupId';

export const REGISTRE: readonly EntreeRoute[] = [
  // --- Public ---------------------------------------------------------------------------------------------
  { methode: 'GET', chemin: '/api/sante', exige: 'aucune' },
  { methode: 'GET', chemin: '/api/version', exige: 'aucune' },
  { methode: 'GET', chemin: '/api/devises', exige: 'aucune' },
  { methode: 'POST', chemin: '/api/auth/inscription', exige: 'aucune' },
  { methode: 'POST', chemin: '/api/auth/connexion', exige: 'aucune' },
  { methode: 'POST', chemin: '/api/auth/deconnexion', exige: 'aucune' }, // tolérante : sans session, elle efface le cookie et répond 200
  { methode: 'POST', chemin: '/api/auth/mot-de-passe/oubli', exige: 'aucune' },
  { methode: 'POST', chemin: '/api/auth/mot-de-passe/reinitialisation', exige: 'aucune' },
  { methode: 'POST', chemin: '/api/auth/email/verification', exige: 'aucune' },

  // --- Le compte (session, jamais de groupe) -----------------------------------------------------------------
  { methode: 'GET', chemin: '/api/moi', exige: 'session' },
  { methode: 'GET', chemin: '/api/moi/tableau-de-bord', exige: 'session' },
  { methode: 'PATCH', chemin: '/api/moi', exige: 'session', corps: { display_name: 'Nouveau nom' } },
  { methode: 'POST', chemin: '/api/moi/mot-de-passe', exige: 'session', corps: { current_password: 'incorrect-mais-valide-en-forme', new_password: 'un-tout-nouveau-mot-de-passe' } },
  { methode: 'POST', chemin: '/api/moi/email/verification', exige: 'session' },
  { methode: 'GET', chemin: '/api/moi/sessions', exige: 'session' },
  { methode: 'DELETE', chemin: '/api/moi/sessions', exige: 'session' },
  { methode: 'DELETE', chemin: '/api/moi/sessions/:id', exige: 'session', ressources: { id: 'session' } },
  // Abonnements calendrier (lot 5) : relèvent du COMPTE. Le jeton en clair ne sort qu'à la création. `group_id` (restriction à un groupe) est le
  // seul identifiant de groupe lu dans un corps de /api/moi : il n'est PAS forgé par la suite générique, parce que Manon est légitimement
  // membre de B (créer un jeton restreint à B est alors permis). Il est attaqué à part : tests/integration/flux-ical-jetons.test.ts.
  { methode: 'GET', chemin: '/api/moi/flux-ical', exige: 'session' },
  { methode: 'POST', chemin: '/api/moi/flux-ical', exige: 'session', corps: { label: 'Mon téléphone', include_declined: false } },
  { methode: 'DELETE', chemin: '/api/moi/flux-ical/:fluxId', exige: 'session', ressources: { fluxId: 'abonnement' } },
  // Agenda personnel (lot 8) : relève du COMPTE. `group_id` dans `PUT /api/moi/agenda/:id/partages` n'est pas forgé par la suite générique
  // (Manon est légitimement membre de B) ; il est attaqué dans tests/unite/agenda-personnel.test.ts et tests/integration/agenda-personnel.test.ts.
  { methode: 'GET', chemin: '/api/moi/agenda', exige: 'session' },
  { methode: 'POST', chemin: '/api/moi/agenda', exige: 'session', corps: { title: 'Dentiste', starts_at: '2027-03-21T10:00:00Z', time_zone: 'Europe/Paris' } },
  { methode: 'PATCH', chemin: '/api/moi/agenda/:id', exige: 'session', ressources: { id: 'creneauPerso' }, corps: { title: 'Modifié' } },
  { methode: 'DELETE', chemin: '/api/moi/agenda/:id', exige: 'session', ressources: { id: 'creneauPerso' } },
  { methode: 'PUT', chemin: '/api/moi/agenda/:id/partages', exige: 'session', ressources: { id: 'creneauPerso' }, corps: { partages: [] } },
  // Sources d'agenda externe (ADR-0013) : relèvent du COMPTE. L'URL est un secret porteur, jamais rendue. Il n'existe pas de lecture d'UNE source par
  // identifiant : la liste est filtrée par le compte (ses attaques sont celles de `GET /api/moi/flux-ical`) ; l'identifiant forgé s'attaque en
  // écriture (PATCH, synchronisation à la demande) et en suppression.
  { methode: 'GET', chemin: '/api/moi/agenda/sources', exige: 'session' },
  { methode: 'POST', chemin: '/api/moi/agenda/sources', exige: 'session', corps: { url: 'https://agenda.exemple.org/propre-a-la-suite.ics' } },
  { methode: 'PATCH', chemin: '/api/moi/agenda/sources/:id', exige: 'session', ressources: { id: 'sourceAgenda' }, corps: { label: 'Renommée' } },
  { methode: 'DELETE', chemin: '/api/moi/agenda/sources/:id', exige: 'session', ressources: { id: 'sourceAgenda' } },
  { methode: 'POST', chemin: '/api/moi/agenda/sources/:id/synchronisation', exige: 'session', ressources: { id: 'sourceAgenda' } },
  // Notifications et préférences d'e-mail (lot 10) : relèvent du COMPTE. `group_id` est `'*'` ici (Manon est membre de B).
  { methode: 'GET', chemin: '/api/moi/notifications', exige: 'session' },
  { methode: 'POST', chemin: '/api/moi/notifications/lecture', exige: 'session', corps: { tout: true } },
  { methode: 'GET', chemin: '/api/moi/preferences-notifications', exige: 'session' },
  { methode: 'PUT', chemin: '/api/moi/preferences-notifications', exige: 'session', corps: { group_id: '*', email_mode: 'daily' } },
  // Photo de profil et Web Push (lot 12).
  { methode: 'GET', chemin: '/api/moi/avatar', exige: 'session' },
  {
    methode: 'PUT',
    chemin: '/api/moi/avatar',
    exige: 'session',
    corps: {
      mime: 'image/png',
      data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    },
  },
  { methode: 'DELETE', chemin: '/api/moi/avatar', exige: 'session' },
  { methode: 'GET', chemin: '/api/moi/push/cle', exige: 'session' },
  {
    methode: 'POST',
    chemin: '/api/moi/push/abonnement',
    exige: 'session',
    corps: {
      endpoint: 'https://push.exemple.test/sub/alice',
      keys: {
        p256dh: 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        auth: 'AQEBAQEBAQEBAQEBAQEBAQ',
      },
    },
  },
  { methode: 'DELETE', chemin: '/api/moi/push/abonnement', exige: 'session' },
  { methode: 'POST', chemin: '/api/moi/push/test', exige: 'session' },
  { methode: 'GET', chemin: '/api/utilisateurs/:userId/avatar', exige: 'session', ressources: { userId: 'utilisateur' } },
  { methode: 'GET', chemin: '/api/groupes', exige: 'session' },
  { methode: 'POST', chemin: '/api/groupes', exige: 'session', corps: { name: 'Un autre groupe' } },
  // Invitations reçues : relèvent du COMPTE destinataire (pas encore de groupe), jamais d'un identifiant de groupe.
  { methode: 'GET', chemin: '/api/moi/invitations', exige: 'session' },
  { methode: 'POST', chemin: '/api/moi/invitations/:invitationId/acceptation', exige: 'session', ressources: { invitationId: 'invitationRecue' } },
  { methode: 'POST', chemin: '/api/moi/invitations/:invitationId/refus', exige: 'session', ressources: { invitationId: 'invitationRecue' } },
  // Invitations par lien : le jeton est le secret ; l'aperçu est public, l'acceptation exige une session et une adresse vérifiée identique.
  // Le jeton est dans le CORPS (jamais dans l'URL, donc jamais dans un journal d'accès).
  { methode: 'POST', chemin: '/api/invitations/apercu', exige: 'aucune', corps: { token: '' }, ressourcesCorps: { token: 'jeton' } },
  { methode: 'POST', chemin: '/api/invitations/acceptation', exige: 'session', corps: { token: '' }, ressourcesCorps: { token: 'jeton' } },

  // --- Le groupe (appartenance obligatoire, posée une fois sur le préfixe) ----------------------------------------
  { methode: 'GET', chemin: '/api/groupes/:groupId', exige: 'appartenance' },
  { methode: 'PATCH', chemin: '/api/groupes/:groupId', exige: 'admin', corps: { name: 'Nouveau nom' } },
  { methode: 'DELETE', chemin: '/api/groupes/:groupId', exige: 'admin' },
  { methode: 'GET', chemin: '/api/groupes/:groupId/membres', exige: 'appartenance' },
  { methode: 'PATCH', chemin: '/api/groupes/:groupId/membres/:membreId', exige: 'admin', ressources: { membreId: 'membre' }, corps: { role: 'admin' } },
  { methode: 'DELETE', chemin: '/api/groupes/:groupId/membres/:membreId', exige: 'admin', ressources: { membreId: 'membre' } },
  { methode: 'POST', chemin: '/api/groupes/:groupId/depart', exige: 'appartenance' },
  { methode: 'GET', chemin: '/api/groupes/:groupId/invitations', exige: 'admin' },
  { methode: 'POST', chemin: '/api/groupes/:groupId/invitations', exige: 'admin', corps: { email: 'forge@exemple.test' } },
  { methode: 'DELETE', chemin: '/api/groupes/:groupId/invitations/:invitationId', exige: 'admin', ressources: { invitationId: 'invitation' } },
  // Visibilité par défaut et disponibilités partagées dans le groupe (lot 8).
  { methode: 'PUT', chemin: '/api/groupes/:groupId/ma-visibilite', exige: 'appartenance', corps: { visibility: 'busy' } },
  { methode: 'GET', chemin: '/api/groupes/:groupId/disponibilites', exige: 'appartenance', requete: { du: '2027-03-01', au: '2027-03-31' } },

  // --- L'agenda du groupe (lot 4) ---------------------------------------------------------------------------------
  // `host_membership_id` est le seul identifiant que le corps de création LIT : un hôte de B ne doit pas entrer dans un événement de A.
  { methode: 'GET', chemin: '/api/groupes/:groupId/evenements', exige: 'appartenance', requete: { du: '2027-03-01', au: '2027-03-31' } },
  { methode: 'POST', chemin: '/api/groupes/:groupId/evenements', exige: 'appartenance', corps: { title: 'Apéro', starts_at: '2027-03-20T18:00:00Z', time_zone: 'Europe/Paris', host_membership_id: 'a-remplacer' }, ressourcesCorps: { host_membership_id: 'membre' } },
  { methode: 'GET', chemin: '/api/groupes/:groupId/evenements/:evenementId', exige: 'appartenance', ressources: { evenementId: 'evenement' } },
  { methode: 'PATCH', chemin: '/api/groupes/:groupId/evenements/:evenementId', exige: 'organisateur', ressources: { evenementId: 'evenement' }, corps: { title: 'Pirate', host_membership_id: 'a-remplacer' }, ressourcesCorps: { host_membership_id: 'membre' } },
  { methode: 'DELETE', chemin: '/api/groupes/:groupId/evenements/:evenementId', exige: 'organisateur', ressources: { evenementId: 'evenement' } },
  { methode: 'PUT', chemin: '/api/groupes/:groupId/evenements/:evenementId/ma-presence', exige: 'appartenance', ressources: { evenementId: 'evenement' }, corps: { status: 'yes', guests_count: 1 } },
  { methode: 'GET', chemin: '/api/groupes/:groupId/evenements/:evenementId/presences', exige: 'appartenance', ressources: { evenementId: 'evenement' } },
  // Deux identifiants lus : l'événement ET le membre. Promouvoir un membre de B sur un événement de A (ou l'inverse) est un 404 du membre.
  { methode: 'POST', chemin: '/api/groupes/:groupId/evenements/:evenementId/organisateurs/:membreId', exige: 'organisateur', ressources: { evenementId: 'evenement', membreId: 'membre' } },
  { methode: 'DELETE', chemin: '/api/groupes/:groupId/evenements/:evenementId/organisateurs/:membreId', exige: 'organisateur', ressources: { evenementId: 'evenement', membreId: 'membre' } },

  // --- Listes de courses, tâches et temps réel (lot 6) ---------------------------------------------------------------------------------
  // Toutes `appartenance` : tout membre actif modifie une liste ou une tâche (aucun droit fin, donc aucun 403 ; le seul droit du lot, réassigner
  // la tâche de quelqu'un d'autre, relève d'un test d'intégration). Les identifiants lus dans un corps ou une requête sont déclarés :
  // `event_id` (liste, tâche), `after_item_id` (réordonnancement), `assignee_membership_id` (désigner quelqu'un).
  { methode: 'GET', chemin: '/api/groupes/:groupId/listes', exige: 'appartenance', ressourcesRequete: { event_id: 'evenement' } },
  { methode: 'POST', chemin: '/api/groupes/:groupId/listes', exige: 'appartenance', corps: { title: 'Courses', event_id: 'a-remplacer' }, ressourcesCorps: { event_id: 'evenement' } },
  { methode: 'GET', chemin: '/api/groupes/:groupId/listes/:listeId', exige: 'appartenance', ressources: { listeId: 'liste' } },
  { methode: 'PATCH', chemin: '/api/groupes/:groupId/listes/:listeId', exige: 'appartenance', ressources: { listeId: 'liste' }, corps: { title: 'Pirate' } },
  { methode: 'DELETE', chemin: '/api/groupes/:groupId/listes/:listeId', exige: 'appartenance', ressources: { listeId: 'liste' } },
  { methode: 'POST', chemin: '/api/groupes/:groupId/listes/:listeId/articles', exige: 'appartenance', ressources: { listeId: 'liste' }, corps: { label: 'Pain' } },
  // `after_item_id` doit être un AUTRE article de la même liste : le monde en porte deux (`article`, `articleVoisin`).
  { methode: 'PATCH', chemin: '/api/groupes/:groupId/listes/:listeId/articles/:articleId', exige: 'appartenance', ressources: { listeId: 'liste', articleId: 'article' }, corps: { label: 'Pirate', after_item_id: 'a-remplacer' }, ressourcesCorps: { after_item_id: 'articleVoisin' } },
  { methode: 'DELETE', chemin: '/api/groupes/:groupId/listes/:listeId/articles/:articleId', exige: 'appartenance', ressources: { listeId: 'liste', articleId: 'article' } },
  { methode: 'PUT', chemin: '/api/groupes/:groupId/listes/:listeId/articles/:articleId/preneur', exige: 'appartenance', ressources: { listeId: 'liste', articleId: 'article' }, corps: { prend: true } },
  { methode: 'PUT', chemin: '/api/groupes/:groupId/listes/:listeId/articles/:articleId/fait', exige: 'appartenance', ressources: { listeId: 'liste', articleId: 'article' }, corps: { fait: true } },
  { methode: 'GET', chemin: '/api/groupes/:groupId/taches', exige: 'appartenance', ressourcesRequete: { event_id: 'evenement' } },
  { methode: 'POST', chemin: '/api/groupes/:groupId/taches', exige: 'appartenance', corps: { title: 'Apporter la glace', event_id: 'a-remplacer' }, ressourcesCorps: { event_id: 'evenement' } },
  { methode: 'PATCH', chemin: '/api/groupes/:groupId/taches/:tacheId', exige: 'appartenance', ressources: { tacheId: 'tache' }, corps: { title: 'Pirate', event_id: 'a-remplacer' }, ressourcesCorps: { event_id: 'evenement' } },
  { methode: 'DELETE', chemin: '/api/groupes/:groupId/taches/:tacheId', exige: 'appartenance', ressources: { tacheId: 'tache' } },
  // Désigner quelqu'un : un identifiant de MEMBRE lu dans le corps. Un membre de B ne s'assigne pas à une tâche de A (404 `membre.introuvable`).
  { methode: 'PUT', chemin: '/api/groupes/:groupId/taches/:tacheId/assignation', exige: 'appartenance', ressources: { tacheId: 'tache' }, corps: { assignee_membership_id: 'a-remplacer' }, ressourcesCorps: { assignee_membership_id: 'membre' } },
  // Le flux SSE : ouvert par un vrai socket, coupé par la suite (`flux`). Ses attaques propres (membre retiré en cours de flux, deux groupes) sont dans tests/integration/temps-reel.test.ts.
  { methode: 'GET', chemin: '/api/groupes/:groupId/temps-reel', exige: 'appartenance', flux: true },

  // --- Sondages de dates (lot 7) ------------------------------------------------------------------------------------------
  { methode: 'GET', chemin: '/api/groupes/:groupId/sondages', exige: 'appartenance' },
  { methode: 'POST', chemin: '/api/groupes/:groupId/sondages', exige: 'appartenance', corps: { title: 'Date du dîner', options: [{ starts_at: '2027-04-10T19:00:00Z' }] } },
  { methode: 'GET', chemin: '/api/groupes/:groupId/sondages/:sondageId', exige: 'appartenance', ressources: { sondageId: 'sondage' } },
  { methode: 'PATCH', chemin: '/api/groupes/:groupId/sondages/:sondageId', exige: 'appartenance', droitFin: 'droit.auteur_requis', ressources: { sondageId: 'sondage' }, corps: { title: 'Pirate' } },
  { methode: 'DELETE', chemin: '/api/groupes/:groupId/sondages/:sondageId', exige: 'appartenance', droitFin: 'droit.auteur_requis', ressources: { sondageId: 'sondage' } },
  { methode: 'POST', chemin: '/api/groupes/:groupId/sondages/:sondageId/options', exige: 'appartenance', ressources: { sondageId: 'sondage' }, corps: { starts_at: '2027-04-18T19:00:00Z' } },
  { methode: 'DELETE', chemin: '/api/groupes/:groupId/sondages/:sondageId/options/:optionId', exige: 'appartenance', droitFin: 'droit.auteur_requis', ressources: { sondageId: 'sondage', optionId: 'optionSondage' } },
  { methode: 'PUT', chemin: '/api/groupes/:groupId/sondages/:sondageId/options/:optionId/mon-vote', exige: 'appartenance', ressources: { sondageId: 'sondage', optionId: 'optionSondage' }, corps: { value: 'yes' } },
  { methode: 'POST', chemin: '/api/groupes/:groupId/sondages/:sondageId/conversion', exige: 'appartenance', droitFin: 'droit.auteur_requis', ressources: { sondageId: 'sondage' }, corps: { option_id: 'a-remplacer' }, ressourcesCorps: { option_id: 'optionSondage' } },

  // --- Dépenses partagées, remboursements, soldes et clôture (lot 9) ---------------------------------------------------
  { methode: 'GET', chemin: '/api/groupes/:groupId/depenses', exige: 'appartenance', ressourcesRequete: { event_id: 'evenement', payer_membership_id: 'membre' } },
  {
    methode: 'POST',
    chemin: '/api/groupes/:groupId/depenses',
    exige: 'appartenance',
    corps: {
      event_id: 'a-remplacer',
      label: 'Pizzas',
      spent_on: '2027-03-20',
      payer_membership_id: 'a-remplacer',
      amount_minor: 2000,
      currency_code: 'EUR',
      split_mode: 'equal',
      shares: [{ membership_id: 'a-remplacer' }],
    },
    ressourcesCorps: { event_id: 'evenement', payer_membership_id: 'membre', 'shares.0.membership_id': 'membre' },
  },
  { methode: 'GET', chemin: '/api/groupes/:groupId/depenses/:depenseId', exige: 'appartenance', ressources: { depenseId: 'depense' } },
  {
    methode: 'PATCH',
    chemin: '/api/groupes/:groupId/depenses/:depenseId',
    exige: 'appartenance',
    droitFin: 'droit.depense_requise',
    ressources: { depenseId: 'depense' },
    corps: {
      event_id: 'a-remplacer',
      label: 'Pizzas modifiées',
      payer_membership_id: 'a-remplacer',
      shares: [{ membership_id: 'a-remplacer' }],
    },
    ressourcesCorps: { event_id: 'evenement', payer_membership_id: 'membre', 'shares.0.membership_id': 'membre' },
  },
  { methode: 'DELETE', chemin: '/api/groupes/:groupId/depenses/:depenseId', exige: 'appartenance', droitFin: 'droit.depense_requise', ressources: { depenseId: 'depense' } },
  { methode: 'GET', chemin: '/api/groupes/:groupId/soldes', exige: 'appartenance', ressourcesRequete: { evenement: 'evenement' } },
  { methode: 'GET', chemin: '/api/groupes/:groupId/remboursements', exige: 'appartenance', ressourcesRequete: { event_id: 'evenement' } },
  {
    methode: 'POST',
    chemin: '/api/groupes/:groupId/remboursements',
    exige: 'appartenance',
    corps: {
      event_id: 'a-remplacer',
      from_membership_id: 'a-remplacer',
      to_membership_id: 'a-remplacer',
      amount_minor: 500,
      currency_code: 'EUR',
      settled_on: '2027-03-21',
    },
    ressourcesCorps: { event_id: 'evenement', from_membership_id: 'membre', to_membership_id: 'membreAutre' },
  },
  { methode: 'POST', chemin: '/api/groupes/:groupId/remboursements/:remboursementId/confirmation', exige: 'appartenance', droitFin: 'droit.beneficiaire_requis', ressources: { remboursementId: 'remboursement' } },
  { methode: 'DELETE', chemin: '/api/groupes/:groupId/remboursements/:remboursementId', exige: 'appartenance', droitFin: 'droit.auteur_requis', ressources: { remboursementId: 'remboursement' } },
  { methode: 'POST', chemin: '/api/groupes/:groupId/evenements/:evenementId/cloture', exige: 'organisateur', ressources: { evenementId: 'evenement' } },
  { methode: 'DELETE', chemin: '/api/groupes/:groupId/evenements/:evenementId/cloture', exige: 'organisateur', ressources: { evenementId: 'evenement' } },

  // --- Fils de discussion libres et messages (lot 10) ---------------------------------------------------
  { methode: 'GET', chemin: '/api/groupes/:groupId/fils', exige: 'appartenance' },
  { methode: 'POST', chemin: '/api/groupes/:groupId/fils', exige: 'appartenance', corps: { title: 'Discussion libre' } },
  { methode: 'GET', chemin: '/api/groupes/:groupId/fils/:filId/messages', exige: 'appartenance', ressources: { filId: 'fil' } },
  { methode: 'POST', chemin: '/api/groupes/:groupId/fils/:filId/messages', exige: 'appartenance', ressources: { filId: 'fil' }, corps: { body: 'Bonjour tout le monde' } },
  { methode: 'PATCH', chemin: '/api/groupes/:groupId/fils/:filId/messages/:messageId', exige: 'appartenance', droitFin: 'droit.message_requis', ressources: { filId: 'fil', messageId: 'message' }, corps: { body: 'Message modifié' } },
  { methode: 'DELETE', chemin: '/api/groupes/:groupId/fils/:filId/messages/:messageId', exige: 'appartenance', droitFin: 'droit.message_requis', ressources: { filId: 'fil', messageId: 'message' } },

  // --- Photos / Immich (lot 11) ---------------------------------------------------------------------------
  { methode: 'GET', chemin: '/api/groupes/:groupId/immich', exige: 'admin' },
  { methode: 'PUT', chemin: '/api/groupes/:groupId/immich', exige: 'admin', corps: { base_url: 'https://immich.exemple.test/api', api_key: 'nouvelle-cle-api-immich' } },
  { methode: 'DELETE', chemin: '/api/groupes/:groupId/immich', exige: 'admin' },
  { methode: 'POST', chemin: '/api/groupes/:groupId/immich/test', exige: 'admin' },
  { methode: 'GET', chemin: '/api/groupes/:groupId/albums', exige: 'appartenance' },
  { methode: 'POST', chemin: '/api/groupes/:groupId/albums', exige: 'appartenance', corps: { title: 'Album test', event_id: 'a-remplacer' }, ressourcesCorps: { event_id: 'evenement' } },
  { methode: 'GET', chemin: '/api/groupes/:groupId/albums/:albumId', exige: 'appartenance', ressources: { albumId: 'album' } },
  { methode: 'PATCH', chemin: '/api/groupes/:groupId/albums/:albumId', exige: 'appartenance', ressources: { albumId: 'album' }, corps: { title: 'Album renommé', cover_immich_asset_id: 'a-remplacer' }, ressourcesCorps: { cover_immich_asset_id: 'photo' } },
  { methode: 'DELETE', chemin: '/api/groupes/:groupId/albums/:albumId', exige: 'appartenance', ressources: { albumId: 'album' } },
  { methode: 'GET', chemin: '/api/groupes/:groupId/albums/:albumId/photos', exige: 'appartenance', ressources: { albumId: 'album' } },
  {
    methode: 'POST',
    chemin: '/api/groupes/:groupId/albums/:albumId/photos',
    exige: 'appartenance',
    ressources: { albumId: 'album' },
    corps: {
      files: [
        {
          filename: 'souvenir.jpg',
          mime_type: 'image/jpeg',
          content_base64: 'AQID',
        },
      ],
    },
  },
  { methode: 'DELETE', chemin: '/api/groupes/:groupId/albums/:albumId/photos/:assetId', exige: 'appartenance', ressources: { albumId: 'album', assetId: 'photo' } },

  // --- Le flux de calendrier (lot 5) : hors /api, sans cookie, le jeton est le seul secret ----------------------------------------------
  { methode: 'GET', chemin: '/ical/:jeton.ics', exige: 'jetonFlux', ressources: { jeton: 'jetonFlux' } },

  // --- Relai média signé (lot 11) : hors /api, session + signature HMAC liée à l'utilisateur ---------------------------------------------
  { methode: 'GET', chemin: '/media/:albumId/:assetId/:taille', exige: 'media', ressources: { albumId: 'album', assetId: 'photo' } },
];

export const cle = (e: Pick<EntreeRoute, 'methode' | 'chemin'>): string => `${e.methode} ${e.chemin}`;
