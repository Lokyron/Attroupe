import { z } from 'zod';
import { baseDeScope, type Condition, type GroupScope, type Valeurs } from '../scope.js';
import { preparer } from '../sql.js';
import { listerMembres } from './membres.js';

// Agenda du groupe (lot 4) : événements, organisateurs, présences. Toutes les fonctions prennent un `GroupScope` : le
// groupe est celui du scope, jamais un paramètre. Les colonnes réservées V2 (`recurrence_rule`, `recurrence_parent_id`,
// `occurrence_date`) ne sont ni écrites ni lues ici : `ligneEvenement` ne les déclare pas, donc elles ne sortent jamais.
// `deleted_at` reste pour une purge future ; l'annulation est un statut, pas une suppression.

const ligneEvenement = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  location_name: z.string().nullable(),
  location_address: z.string().nullable(),
  location_lat: z.number().nullable(),
  location_lon: z.number().nullable(),
  all_day: z.union([z.literal(0), z.literal(1)]),
  starts_at: z.string(),
  ends_at: z.string().nullable(),
  time_zone: z.string(),
  arrival_note: z.string().nullable(),
  host_membership_id: z.string().nullable(),
  currency_code: z.string().nullable(),
  capacity: z.number().nullable(),
  status: z.enum(['draft', 'published', 'cancelled']),
  source_date_poll_id: z.string().nullable(),
  created_by_membership_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Evenement = z.infer<typeof ligneEvenement>;

/** Champs modifiables d'un événement, tels que la base les écrit (`all_day` en 0 / 1). */
export interface ChampsEvenement {
  readonly title: string;
  readonly description: string | null;
  readonly location_name: string | null;
  readonly location_address: string | null;
  readonly location_lat: number | null;
  readonly location_lon: number | null;
  readonly all_day: boolean;
  readonly starts_at: string;
  readonly ends_at: string | null;
  readonly time_zone: string;
  readonly arrival_note: string | null;
  readonly host_membership_id: string | null;
  readonly currency_code: string | null;
  readonly capacity: number | null;
}

/** Sous-ensemble des champs (modification) : une clé absente ou `undefined` n'est pas touchée. */
export type ModificationEvenement = { readonly [K in keyof ChampsEvenement]?: ChampsEvenement[K] | undefined };

/** Nombre maximal d'événements rendus par une requête de fenêtre. */
const LIMITE_LISTE = 1000;
const ORDRE_CHRONOLOGIQUE = [{ colonne: 'starts_at' }, { colonne: 'id' }] as const;

function valeursDe(champs: ModificationEvenement): Valeurs {
  const { all_day: journee, ...autres } = champs;
  const fournies = Object.entries(autres).filter((entree): entree is [string, string | number | null] => entree[1] !== undefined);
  return { ...Object.fromEntries(fournies), ...(journee === undefined ? {} : { all_day: journee ? 1 : 0 }) };
}

/** Un événement de CE groupe, ou `undefined` (404 `evenement.introuvable` : un événement d'un autre groupe est introuvable). */
export function lireEvenement(scope: GroupScope, evenementId: string): Evenement | undefined {
  const ligne = scope.un<unknown>('events', evenementId);
  return ligne === undefined ? undefined : ligneEvenement.parse(ligne);
}

/**
 * Événements dont l'intervalle touche la fenêtre `du` .. `au` (dates civiles, inclusives, lues comme des jours UTC), du plus
 * proche au plus lointain. Sans borne, tout l'agenda (dans la limite). Annulés compris : un événement annulé reste lisible.
 * Deux requêtes assemblées ici (le moteur ne connaît ni `OR` ni `COALESCE`) : ceux qui COMMENCENT dans la fenêtre, puis ceux qui
 * ont commencé avant et se terminent dans ou après elle.
 */
export function listerEvenements(scope: GroupScope, fenetre: { readonly du?: string | undefined; readonly au?: string | undefined }): Evenement[] {
  const fin: Condition[] = fenetre.au === undefined ? [] : [{ colonne: 'starts_at', operateur: '<=', valeur: `${fenetre.au}T23:59:59Z` }];
  const debutDansFenetre: Condition[] = fenetre.du === undefined ? [] : [{ colonne: 'starts_at', operateur: '>=', valeur: fenetre.du }];
  const lues = scope.tous<unknown>('events', [...debutDansFenetre, ...fin], { ordre: ORDRE_CHRONOLOGIQUE, limite: LIMITE_LISTE });
  if (fenetre.du !== undefined) {
    lues.push(
      ...scope.tous<unknown>(
        'events',
        [
          { colonne: 'starts_at', operateur: '<', valeur: fenetre.du },
          { colonne: 'ends_at', operateur: '>=', valeur: fenetre.du },
        ],
        { ordre: ORDRE_CHRONOLOGIQUE, limite: LIMITE_LISTE },
      ),
    );
  }
  return lues
    .map((ligne) => ligneEvenement.parse(ligne))
    .sort((x, y) => (x.starts_at < y.starts_at ? -1 : x.starts_at > y.starts_at ? 1 : x.id < y.id ? -1 : 1));
}

/**
 * L'autorisation fine, au-dessus du cloisonnement (architecture §4) : l'auteur, un co-organisateur, ou un administrateur du
 * groupe. `evenement` vient du groupe du scope (`lireEvenement`) ; les organisateurs sont relus dans CE groupe.
 */
export function peutModifierEvenement(scope: GroupScope, evenement: Pick<Evenement, 'id' | 'created_by_membership_id'>): boolean {
  if (scope.role === 'admin') return true;
  if (evenement.created_by_membership_id === scope.membershipId) return true;
  return (
    scope.tous('event_organizers', [
      { colonne: 'event_id', operateur: '=', valeur: evenement.id },
      { colonne: 'membership_id', operateur: '=', valeur: scope.membershipId },
    ]).length > 0
  );
}

export type ProblemeReference = 'hote_introuvable' | 'hote_inactif' | 'devise_inconnue';

/**
 * Les références d'un événement qui ne sont pas des clés étrangères simples : l'hôte est un membre ACTIF DE CE GROUPE (la clé
 * composite refuserait un autre groupe, mais en erreur SQLite : on répond proprement avant), la devise existe.
 */
export function verifierReferences(scope: GroupScope, champs: { host_membership_id?: string | null | undefined; currency_code?: string | null | undefined }): ProblemeReference | undefined {
  if (champs.host_membership_id !== undefined && champs.host_membership_id !== null) {
    const hote = scope.un<{ status: string }>('memberships', champs.host_membership_id);
    if (hote === undefined) return 'hote_introuvable';
    if (hote.status !== 'active') return 'hote_inactif';
  }
  if (champs.currency_code !== undefined && champs.currency_code !== null) {
    // `currencies` est une table de référence, sans groupe (même contrôle que db/queries/groupes.ts).
    if (preparer(baseDeScope(scope), 'SELECT 1 FROM currencies WHERE code = ?').get(champs.currency_code) === undefined) return 'devise_inconnue';
  }
  return undefined;
}

/** Crée l'événement ET son fil de discussion (`threads.kind = 'event'`) dans la même transaction ; l'auteur vient du scope. */
export function creerEvenement(scope: GroupScope, champs: ChampsEvenement): { id: string; thread_id: string } {
  return scope.transaction(() => {
    const id = scope.inserer('events', { ...valeursDe(champs), status: 'published' });
    const threadId = scope.inserer('threads', { event_id: id, kind: 'event' });
    return { id, thread_id: threadId };
  });
}

/** Met à jour les champs fournis ; `false` si l'événement n'est pas (ou plus) dans ce groupe. */
export function modifierEvenement(scope: GroupScope, evenementId: string, champs: ModificationEvenement): boolean {
  return scope.modifier('events', evenementId, valeursDe(champs));
}

/** Annulation : le statut passe à `cancelled`, la ligne reste (et `deleted_at` aussi vide). */
export function annulerEvenement(scope: GroupScope, evenementId: string): boolean {
  return scope.modifier('events', evenementId, { status: 'cancelled' });
}

/** Le fil de discussion de l'événement (créé avec lui). */
export function filDeEvenement(scope: GroupScope, evenementId: string): string | undefined {
  const fils = scope.tous<{ id: string }>('threads', [
    { colonne: 'event_id', operateur: '=', valeur: evenementId },
    { colonne: 'kind', operateur: '=', valeur: 'event' },
  ]);
  return fils[0]?.id;
}

// --- Organisateurs ------------------------------------------------------------------------------------------------------

const ligneOrganisateur = z.object({ membership_id: z.string() });

export interface Organisateur {
  readonly membership_id: string;
  readonly display_name: string;
}

/** Co-organisateurs de l'événement, avec leur nom affiché (celui du compte), par ordre d'ajout. */
export function listerOrganisateurs(scope: GroupScope, evenementId: string): Organisateur[] {
  const lignes = scope
    .tous<unknown>('event_organizers', [{ colonne: 'event_id', operateur: '=', valeur: evenementId }], { ordre: [{ colonne: 'added_at' }, { colonne: 'membership_id' }] })
    .map((ligne) => ligneOrganisateur.parse(ligne));
  const noms = new Map(listerMembres(scope).map((m) => [m.id, m.display_name]));
  return lignes.map((l) => ({ membership_id: l.membership_id, display_name: noms.get(l.membership_id) ?? '' }));
}

/** L'auteur de l'événement, avec le nom affiché de son compte (il gère l'événement sans figurer parmi les co-organisateurs). */
export function auteurDe(scope: GroupScope, evenement: Pick<Evenement, 'created_by_membership_id'>): Organisateur {
  const nom = listerMembres(scope).find((m) => m.id === evenement.created_by_membership_id)?.display_name ?? '';
  return { membership_id: evenement.created_by_membership_id, display_name: nom };
}

export type ResultatOrganisateur = 'ajoute' | 'deja' | 'retire' | 'absent' | 'membre_introuvable' | 'membre_inactif';

/** Ajoute un co-organisateur (membre ACTIF du groupe) ; sans effet s'il l'est déjà. */
export function ajouterOrganisateur(scope: GroupScope, evenementId: string, membreId: string, maintenant: string): ResultatOrganisateur {
  return scope.transaction(() => {
    const membre = scope.un<{ status: string }>('memberships', membreId);
    if (membre === undefined) return 'membre_introuvable' as const;
    if (membre.status !== 'active') return 'membre_inactif' as const;
    const existant = scope.tous('event_organizers', [
      { colonne: 'event_id', operateur: '=', valeur: evenementId },
      { colonne: 'membership_id', operateur: '=', valeur: membreId },
    ]);
    if (existant.length > 0) return 'deja' as const;
    scope.inserer('event_organizers', { event_id: evenementId, membership_id: membreId, added_at: maintenant });
    return 'ajoute' as const;
  });
}

/** Retire un co-organisateur ; sans effet s'il ne l'est pas. Le membre doit exister dans CE groupe (sinon 404). */
export function retirerOrganisateur(scope: GroupScope, evenementId: string, membreId: string): ResultatOrganisateur {
  return scope.transaction(() => {
    if (scope.un('memberships', membreId) === undefined) return 'membre_introuvable' as const;
    return scope.supprimer('event_organizers', { event_id: evenementId, membership_id: membreId }) ? ('retire' as const) : ('absent' as const);
  });
}

// --- Présences ----------------------------------------------------------------------------------------------------------

const lignePresence = z.object({
  status: z.enum(['yes', 'maybe', 'no']),
  guests_count: z.number(),
  comment: z.string().nullable(),
  responded_at: z.string(),
  updated_at: z.string(),
});

export type Presence = z.infer<typeof lignePresence>;

/** Ma réponse à l'événement, ou `undefined` si je n'ai pas répondu. */
export function maPresence(scope: GroupScope, evenementId: string): Presence | undefined {
  const ligne = scope.tous<unknown>('event_attendances', [
    { colonne: 'event_id', operateur: '=', valeur: evenementId },
    { colonne: 'membership_id', operateur: '=', valeur: scope.membershipId },
  ])[0];
  return ligne === undefined ? undefined : lignePresence.parse(ligne);
}

/**
 * Pose MA réponse (jamais celle d'un autre : le moteur refuse une autre appartenance). La première réponse fixe `responded_at` ;
 * les suivantes ne changent que la réponse et `updated_at`.
 */
export function repondre(
  scope: GroupScope,
  evenementId: string,
  reponse: { readonly status: 'yes' | 'maybe' | 'no'; readonly guests_count: number; readonly comment: string | null },
  maintenant: string,
): void {
  scope.transaction(() => {
    if (maPresence(scope, evenementId) === undefined) {
      scope.inserer('event_attendances', { event_id: evenementId, membership_id: scope.membershipId, ...reponse, responded_at: maintenant });
    } else {
      scope.modifierPar('event_attendances', { event_id: evenementId, membership_id: scope.membershipId }, { ...reponse });
    }
  });
}

const ligneReponse = z.object({
  membership_id: z.string(),
  display_name: z.string(),
  status: z.enum(['yes', 'maybe', 'no']),
  guests_count: z.number(),
  comment: z.string().nullable(),
  responded_at: z.string(),
});

const ligneCompteurs = z.object({ yes: z.number(), maybe: z.number(), no: z.number(), invites_des_yes: z.number() });

export interface Presences {
  readonly compteurs: { readonly yes: number; readonly maybe: number; readonly no: number; readonly attendus: number; readonly sans_reponse: number };
  readonly reponses: Array<z.infer<typeof ligneReponse>>;
  readonly sans_reponse: Array<{ membership_id: string; display_name: string }>;
}

/**
 * Réponses et compteurs. Les compteurs se calculent EN SQL, dans le groupe du scope (`a.group_id = ?`), et ne comptent que les
 * membres ACTIFS : une personne retirée du groupe n'est plus attendue. Attendus = les « oui » + les invités des « oui ».
 * Les membres actifs sans réponse sont ceux de la liste du groupe qui ne figurent pas parmi les répondants.
 */
export function lirePresences(scope: GroupScope, evenementId: string): Presences {
  const base = baseDeScope(scope);
  const compteurs = ligneCompteurs.parse(
    preparer(
      base,
      `SELECT COALESCE(SUM(CASE WHEN a.status = 'yes' THEN 1 ELSE 0 END), 0) AS yes,
         COALESCE(SUM(CASE WHEN a.status = 'maybe' THEN 1 ELSE 0 END), 0) AS maybe,
         COALESCE(SUM(CASE WHEN a.status = 'no' THEN 1 ELSE 0 END), 0) AS no,
         COALESCE(SUM(CASE WHEN a.status = 'yes' THEN a.guests_count ELSE 0 END), 0) AS invites_des_yes
       FROM event_attendances AS a JOIN memberships AS m ON m.id = a.membership_id AND m.group_id = a.group_id
       WHERE a.group_id = ? AND a.event_id = ? AND m.status = 'active'`,
    ).get(scope.groupId, evenementId),
  );
  const reponses = preparer(
    base,
    `SELECT a.membership_id AS membership_id, u.display_name AS display_name, a.status AS status, a.guests_count AS guests_count,
       a.comment AS comment, a.responded_at AS responded_at
     FROM event_attendances AS a
     JOIN memberships AS m ON m.id = a.membership_id AND m.group_id = a.group_id
     JOIN users AS u ON u.id = m.user_id
     WHERE a.group_id = ? AND a.event_id = ? AND m.status = 'active'
     ORDER BY a.responded_at, a.membership_id`,
  )
    .all(scope.groupId, evenementId)
    .map((ligne) => ligneReponse.parse(ligne));
  const ontRepondu = new Set(reponses.map((r) => r.membership_id));
  const sansReponse = listerMembres(scope)
    .filter((m) => m.status === 'active' && !ontRepondu.has(m.id))
    .map((m) => ({ membership_id: m.id, display_name: m.display_name }));
  return {
    compteurs: {
      yes: compteurs.yes,
      maybe: compteurs.maybe,
      no: compteurs.no,
      attendus: compteurs.yes + compteurs.invites_des_yes,
      sans_reponse: sansReponse.length,
    },
    reponses,
    sans_reponse: sansReponse,
  };
}
