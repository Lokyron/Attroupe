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
export type Exigence = 'aucune' | 'session' | 'appartenance' | 'admin' | 'organisateur' | 'jetonFlux';

/** Ressource désignée par un paramètre d'URL. Chacune existe en un exemplaire dans chaque monde (A et B) : voir monde.ts. */
export type Ressource = 'membre' | 'evenement' | 'invitation' | 'invitationRecue' | 'jeton' | 'session' | 'abonnement' | 'jetonFlux';

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
}

/** Clé d'erreur attendue quand la ressource forgée n'existe pas pour l'appelant. */
export const INTROUVABLE: Readonly<Record<Ressource, string>> = {
  membre: 'membre.introuvable',
  evenement: 'evenement.introuvable',
  invitation: 'invitation.introuvable',
  invitationRecue: 'invitation.introuvable',
  jeton: 'invitation.introuvable',
  session: 'session.introuvable',
  abonnement: 'flux.introuvable',
  jetonFlux: 'flux.introuvable',
};

export const PREFIXE_GROUPE = '/api/groupes/:groupId';

export const REGISTRE: readonly EntreeRoute[] = [
  // --- Public ---------------------------------------------------------------------------------------------
  { methode: 'GET', chemin: '/api/sante', exige: 'aucune' },
  { methode: 'POST', chemin: '/api/auth/inscription', exige: 'aucune' },
  { methode: 'POST', chemin: '/api/auth/connexion', exige: 'aucune' },
  { methode: 'POST', chemin: '/api/auth/deconnexion', exige: 'aucune' }, // tolérante : sans session, elle efface le cookie et répond 200
  { methode: 'POST', chemin: '/api/auth/mot-de-passe/oubli', exige: 'aucune' },
  { methode: 'POST', chemin: '/api/auth/mot-de-passe/reinitialisation', exige: 'aucune' },
  { methode: 'POST', chemin: '/api/auth/email/verification', exige: 'aucune' },

  // --- Le compte (session, jamais de groupe) -----------------------------------------------------------------
  { methode: 'GET', chemin: '/api/moi', exige: 'session' },
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
  { methode: 'GET', chemin: '/api/groupes/:groupId/membres', exige: 'appartenance' },
  { methode: 'PATCH', chemin: '/api/groupes/:groupId/membres/:membreId', exige: 'admin', ressources: { membreId: 'membre' }, corps: { role: 'admin' } },
  { methode: 'DELETE', chemin: '/api/groupes/:groupId/membres/:membreId', exige: 'admin', ressources: { membreId: 'membre' } },
  { methode: 'POST', chemin: '/api/groupes/:groupId/depart', exige: 'appartenance' },
  { methode: 'GET', chemin: '/api/groupes/:groupId/invitations', exige: 'admin' },
  { methode: 'POST', chemin: '/api/groupes/:groupId/invitations', exige: 'admin', corps: { email: 'forge@exemple.test' } },
  { methode: 'DELETE', chemin: '/api/groupes/:groupId/invitations/:invitationId', exige: 'admin', ressources: { invitationId: 'invitation' } },

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

  // --- Le flux de calendrier (lot 5) : hors /api, sans cookie, le jeton est le seul secret ----------------------------------------------
  { methode: 'GET', chemin: '/ical/:jeton.ics', exige: 'jetonFlux', ressources: { jeton: 'jetonFlux' } },
];

export const cle = (e: Pick<EntreeRoute, 'methode' | 'chemin'>): string => `${e.methode} ${e.chemin}`;
