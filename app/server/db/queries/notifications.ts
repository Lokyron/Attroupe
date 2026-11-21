import { z } from 'zod';
import fr from '../../i18n/fr.json' with { type: 'json' };
import { estGenreNotification, type GenreNotification } from '../../domain/notifications.js';
import type { Base } from '../base.js';
import { nouvelIdentifiant } from '../identifiant.js';
import { baseDe, type PorteeUtilisateur } from '../portee-utilisateur.js';
import { baseDeScope, type Condition, type GroupScope } from '../scope.js';
import { executerEnTransaction, preparer } from '../sql.js';
import { enfilerEmail, listerNotificationsEnAttenteResume, mesGroupes } from './transverse.js';

// Notifications en application et préférences d'envoi par e-mail (modèle §3.12, architecture §7.3).
//  - Lectures/modifications de l'utilisateur connecté : PorteeUtilisateur (`notifications`, `notification_preferences`).
//  - Diffusion lors d'une action dans un groupe : `notifierMembresGroupe` sous `GroupScope`.
//  - Résumé quotidien : `envoyerResumesQuotidiens` appelé par les tâches périodiques.

export type EmailMode = 'immediate' | 'daily' | 'off';

export type NotificationKind = GenreNotification;

export type SubjectType =
  | 'group'
  | 'invitation'
  | 'event'
  | 'date_poll'
  | 'shopping_item'
  | 'event_task'
  | 'thread'
  | 'message'
  | 'expense'
  | 'settlement'
  | 'album';

const ligneNotification = z.object({
  id: z.string(),
  group_id: z.string().nullable(),
  kind: z.string(),
  subject_type: z.string().nullable(),
  subject_id: z.string().nullable(),
  payload_json: z.string(),
  created_at: z.string(),
  read_at: z.string().nullable(),
});

export interface NotificationVue {
  readonly id: string;
  readonly group_id: string | null;
  readonly group_name: string | null;
  readonly kind: string;
  readonly subject_type: string | null;
  readonly subject_id: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly created_at: string;
  readonly read_at: string | null;
  /**
   * État de l'invitation visée, pour une notification `invitation_received` (`subject_type = 'invitation'`) : `'pending'` tant qu'elle
   * peut être acceptée ou refusée, sinon son issue (`'expired'` aussi pour une invitation en attente dont l'échéance est passée).
   * `null` : pas une notification d'invitation, ou invitation qui n'est pas adressée à CE compte.
   */
  readonly invitation_statut: StatutInvitation | null;
}

export type StatutInvitation = 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';

export interface ListeNotifications {
  readonly notifications: NotificationVue[];
  /** Notifications non lues du compte, tous filtres confondus. */
  readonly non_lues: number;
  /** Vrai s'il reste des notifications au-delà de `limite` pour le filtre demandé. */
  readonly a_suite: boolean;
  /** Curseur (`created_at|id` de la dernière notification de la page) à passer en `avant` pour la page suivante ; `null` s'il n'y en a pas. */
  readonly curseur_suivant: string | null;
}

/** Position dans l'ordre total (created_at, id) décroissant : deux notifications de même date restent distinguées par leur identifiant. */
export interface CurseurNotification {
  readonly created_at: string;
  readonly id: string;
}

export interface OptionsListeNotifications {
  /** `'non_lues'` : seulement celles sans `read_at` ; `'toutes'` : l'historique complet. */
  readonly filtre: 'non_lues' | 'toutes';
  readonly limite: number;
  /** Page suivante : seulement les notifications strictement après ce curseur dans l'ordre d'affichage. */
  readonly avant?: CurseurNotification | undefined;
}

const ligneInvitationVisee = z.object({
  status: z.enum(['pending', 'accepted', 'declined', 'revoked', 'expired']),
  expires_at: z.string(),
});

// Une colonne NULL n'existe que sur la ligne d'un GROUPE (migration 0008) : « hérite de la ligne globale '*' », champ par champ.
const lignePreference = z.object({
  group_id: z.string(),
  channel_email: z.union([z.literal(0), z.literal(1)]).nullable(),
  digest: z.enum(['instant', 'daily', 'off']).nullable(),
  muted_kinds: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export interface PreferenceNotificationVue {
  readonly group_id: string;
  readonly group_name: string | null;
  /** Mode e-mail posé par cette ligne ; `null` : le groupe hérite du mode de la ligne globale (jamais `null` pour `'*'`). */
  readonly email_mode: EmailMode | null;
  /**
   * Genres de notification coupés (aucune notification de ces genres, ni en application ni par e-mail) ; `null` : le groupe hérite des
   * genres coupés de la ligne globale (jamais `null` pour `'*'`).
   */
  readonly muted_kinds: readonly NotificationKind[] | null;
  readonly updated_at: string;
}

/** Mode e-mail posé par une ligne, ou `null` si elle ne le pose pas (colonnes NULL : hérité). */
function versEmailMode(channelEmail: 0 | 1 | null, digest: 'instant' | 'daily' | 'off' | null): EmailMode | null {
  if (channelEmail === null || digest === null) return null;
  if (channelEmail === 0 || digest === 'off') return 'off';
  return digest === 'daily' ? 'daily' : 'immediate';
}

function versColonnesPreference(mode: EmailMode): { readonly channel_email: 0 | 1; readonly digest: 'instant' | 'daily' | 'off' } {
  if (mode === 'off') return { channel_email: 0, digest: 'off' };
  if (mode === 'daily') return { channel_email: 1, digest: 'daily' };
  return { channel_email: 1, digest: 'instant' };
}

function parserPayload(payloadJson: string): Readonly<Record<string, unknown>> {
  try {
    const brut: unknown = JSON.parse(payloadJson);
    return typeof brut === 'object' && brut !== null && !Array.isArray(brut) ? (brut as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * État de l'invitation visée par une notification, lue sur `target_user_id = ce compte` : l'identifiant d'une invitation adressée à
 * quelqu'un d'autre (ou inexistante) donne `null`, sans rien révéler.
 */
function statutInvitationVisee(portee: PorteeUtilisateur, n: { kind: string; subject_type: string | null; subject_id: string | null }, maintenant: string | undefined): StatutInvitation | null {
  if (n.kind !== 'invitation_received' || n.subject_type !== 'invitation' || n.subject_id === null) return null;
  const ligne = preparer(baseDe(portee), 'SELECT status, expires_at FROM invitations WHERE id = ? AND target_user_id = ?').get(n.subject_id, portee.userId);
  if (ligne === undefined) return null;
  const invitation = ligneInvitationVisee.parse(ligne);
  return invitation.status === 'pending' && maintenant !== undefined && invitation.expires_at <= maintenant ? 'expired' : invitation.status;
}

/**
 * Liste les notifications du compte connecté (plus récentes d'abord) et le compteur de non lues. `filtre` et `limite` bornent la page ;
 * on lit `limite + 1` lignes pour savoir s'il en reste (`a_suite`). `maintenant` (instant du modèle) sert à voir une invitation échue ;
 * absent, seul le statut en base compte.
 */
export function listerMesNotifications(
  portee: PorteeUtilisateur,
  options: OptionsListeNotifications = { filtre: 'toutes', limite: 50 },
  maintenant?: string,
): ListeNotifications {
  const noms = new Map(mesGroupes(portee).map((g) => [g.group_id, g.name]));
  const nonLuesSeulement: Condition[] = [{ colonne: 'read_at', operateur: 'IS NULL' }];
  // Ordre d'affichage = ordre du curseur : (created_at DESC, id DESC). Le moteur de portée n'admet pas de OU : la page suivante se lit en
  // deux temps, d'abord les ex æquo de la date du curseur (id plus petit), puis les dates strictement plus anciennes. Le filtre de compte
  // (`user_id`) est posé par la portée dans les deux lectures.
  const ordre = [{ colonne: 'created_at', sens: 'DESC' as const }, { colonne: 'id', sens: 'DESC' as const }];
  const taille = options.limite + 1;
  const lire = (filtres: readonly Condition[], limite: number): z.infer<typeof ligneNotification>[] =>
    portee
      .tous<unknown>('notifications', [...(options.filtre === 'non_lues' ? nonLuesSeulement : []), ...filtres], { ordre, limite })
      .map((l) => ligneNotification.parse(l));
  const { avant } = options;
  const lues =
    avant === undefined
      ? lire([], taille)
      : (() => {
          const memeDate = lire(
            [{ colonne: 'created_at', operateur: '=', valeur: avant.created_at }, { colonne: 'id', operateur: '<', valeur: avant.id }],
            taille,
          );
          return memeDate.length >= taille
            ? memeDate
            : [...memeDate, ...lire([{ colonne: 'created_at', operateur: '<', valeur: avant.created_at }], taille - memeDate.length)];
        })();
  const lignes = lues.slice(0, options.limite);
  const derniere = lignes.at(-1);
  const nonLues = portee.tous<{ id: string }>('notifications', nonLuesSeulement).length;
  return {
    notifications: lignes.map((n) => ({
      id: n.id,
      group_id: n.group_id,
      group_name: n.group_id === null ? null : (noms.get(n.group_id) ?? null),
      kind: n.kind,
      subject_type: n.subject_type,
      subject_id: n.subject_id,
      payload: parserPayload(n.payload_json),
      created_at: n.created_at,
      read_at: n.read_at,
      invitation_statut: statutInvitationVisee(portee, n, maintenant),
    })),
    non_lues: nonLues,
    a_suite: lues.length > options.limite,
    curseur_suivant: lues.length > options.limite && derniere !== undefined ? `${derniere.created_at}|${derniere.id}` : null,
  };
}

/** Marque les notifications demandées (ou toutes les non-lues si `ids` est absent) comme lues. */
export function marquerNotificationsLues(portee: PorteeUtilisateur, ids: readonly string[] | undefined, maintenant: string): number {
  return portee.transaction(() => {
    let compteur = 0;
    if (ids !== undefined) {
      for (const id of ids) {
        const existante = portee.un<{ id: string; read_at: string | null }>('notifications', id);
        if (existante !== undefined && existante.read_at === null) {
          if (portee.modifier('notifications', id, { read_at: maintenant })) compteur++;
        }
      }
      return compteur;
    }
    const nonLues = portee.tous<{ id: string }>('notifications', [{ colonne: 'read_at', operateur: 'IS NULL' }]);
    for (const n of nonLues) {
      if (portee.modifier('notifications', n.id, { read_at: maintenant })) compteur++;
    }
    return compteur;
  });
}

/** Préférences de notification par e-mail du compte connecté (`'*'` ou par groupe). */
export function lirePreferencesNotifications(portee: PorteeUtilisateur): PreferenceNotificationVue[] {
  const noms = new Map(mesGroupes(portee).map((g) => [g.group_id, g.name]));
  return portee
    .tous<unknown>('notification_preferences')
    .map((l) => lignePreference.parse(l))
    .map((p) => ({
      group_id: p.group_id,
      group_name: p.group_id === '*' ? null : (noms.get(p.group_id) ?? null),
      // La ligne globale n'hérite de rien : un NULL y est traité comme le défaut (la base l'interdit, mais le code ne s'y fie pas).
      email_mode: versEmailMode(p.channel_email, p.digest) ?? (p.group_id === '*' ? 'immediate' : null),
      muted_kinds: p.muted_kinds === null ? (p.group_id === '*' ? [] : null) : [...parserMutedKinds(p.muted_kinds)].filter(estGenreNotification),
      updated_at: p.updated_at,
    }));
}

/**
 * Ce que la pastille de l'entrée « Notifs » doit afficher. Source unique de vérité (le client n'additionne rien) :
 * les notifications non lues dont le sujet n'est PAS une invitation en attente, plus les invitations en attente elles-mêmes.
 * Une invitation en attente compte ainsi exactement une fois, que sa notification soit lue ou non : tant qu'on n'y a pas répondu,
 * rien d'autre ne la signale (plus d'entrée « Invitations » dans la navigation), et sa notification ne s'ajoute jamais à elle.
 * `invitationsEnAttente` : identifiants des invitations en attente de CE compte (relues par l'appelant avec la preuve `target_user_id`).
 */
export function compterNotificationsAVoir(portee: PorteeUtilisateur, invitationsEnAttente: readonly string[]): number {
  const enAttente = new Set(invitationsEnAttente);
  const nonLues = portee
    .tous<{ kind: string; subject_id: string | null }>('notifications', [{ colonne: 'read_at', operateur: 'IS NULL' }])
    .filter((n) => !(n.kind === 'invitation_received' && n.subject_id !== null && enAttente.has(n.subject_id)));
  return nonLues.length + enAttente.size;
}

const ligneNomInviteur = z.object({ display_name: z.string() });

export interface OptionsNotificationInvitation {
  readonly destinataireId: string;
  readonly invitationId: string;
  readonly role: 'admin' | 'member';
  readonly maintenant: string;
}

/**
 * Écrit la notification `invitation_received` d'une invitation envoyée à un COMPTE existant (`existing_user`), dans la transaction de
 * l'envoi. `group_id` reste NULL : le destinataire n'est pas membre, la notification ne doit ni lier à une page du groupe ni entrer dans
 * le résumé quotidien (qui joint l'appartenance). Aucun e-mail : `email_queued_at` reste NULL, le chemin e-mail n'existait pas pour ce genre.
 * Respecte les préférences : un genre coupé (ligne globale `'*'`) n'écrit rien, l'invitation reste alors comptée à part par la pastille.
 * Rend faux si rien n'a été écrit.
 */
export function notifierInvitation(scope: GroupScope, options: OptionsNotificationInvitation): boolean {
  const base = baseDeScope(scope);
  const groupe = scope.groupe<{ name: string }>();
  if (groupe === undefined) return false;
  if (resoudrePreferenceNotification(base, options.destinataireId, scope.groupId).mutedKinds.has('invitation_received')) return false;
  const inviteur = preparer(
    base,
    'SELECT u.display_name AS display_name FROM memberships AS m JOIN users AS u ON u.id = m.user_id WHERE m.id = ? AND m.group_id = ?',
  ).get(scope.membershipId, scope.groupId);
  preparer(
    base,
    `INSERT INTO notifications (id, user_id, group_id, kind, subject_type, subject_id, payload_json, created_at, email_queued_at)
     VALUES (?, ?, NULL, 'invitation_received', 'invitation', ?, ?, ?, NULL)`,
  ).run(
    nouvelIdentifiant(),
    options.destinataireId,
    options.invitationId,
    JSON.stringify({
      group_name: groupe.name,
      invited_by_name: inviteur === undefined ? '' : ligneNomInviteur.parse(inviteur).display_name,
      role: options.role,
    }),
    options.maintenant,
  );
  return true;
}

/**
 * Retire des comptes du groupe les notifications d'un genre portant sur un sujet qui n'existe plus (règlement annulé). Sous `GroupScope` :
 * seuls les comptes membres de CE groupe sont visés, et la ligne doit porter ce `group_id`.
 */
export function retirerNotificationsDuSujet(scope: GroupScope, kind: NotificationKind, subjectType: SubjectType, subjectId: string): number {
  const base = baseDeScope(scope);
  const supprimer = preparer(
    base,
    'DELETE FROM notifications WHERE user_id = ? AND group_id = ? AND kind = ? AND subject_type = ? AND subject_id = ?',
  );
  let total = 0;
  for (const membre of scope.tous<{ user_id: string }>('memberships')) {
    total += supprimer.run(membre.user_id, scope.groupId, kind, subjectType, subjectId).changes;
  }
  return total;
}

/**
 * Définit la préférence de notification pour `'*'` ou un groupe dont le compte est membre actif. `emailMode` et `mutedKinds` sont
 * indépendants : un champ absent n'est pas modifié. Sur la ligne d'un groupe, un champ jamais posé reste à NULL = « hérite de la
 * ligne `'*'` » : la résolution se fait champ par champ à la lecture (`resoudrePreferenceNotification`), il n'y a donc AUCUNE copie
 * des valeurs globales — couper un genre globalement atteint tous les groupes qui n'ont pas posé leurs propres genres. Sur la ligne
 * `'*'`, qui n'hérite de rien, un champ absent à la création prend le défaut (e-mail immédiat, rien de coupé).
 */
export function definirPreferenceNotification(
  portee: PorteeUtilisateur,
  groupIdOrStar: string,
  emailMode: EmailMode | undefined,
  mutedKinds?: readonly NotificationKind[],
): PreferenceNotificationVue[] | 'groupe_introuvable' {
  if (groupIdOrStar !== '*') {
    const membre = mesGroupes(portee).some((g) => g.group_id === groupIdOrStar);
    if (!membre) return 'groupe_introuvable';
  }
  const mutedJson = mutedKinds === undefined ? undefined : JSON.stringify([...new Set(mutedKinds)]);
  portee.transaction(() => {
    const existe = portee.tous<unknown>('notification_preferences', [{ colonne: 'group_id', operateur: '=', valeur: groupIdOrStar }]).length > 0;
    if (existe) {
      portee.modifierPar('notification_preferences', { group_id: groupIdOrStar }, {
        ...(emailMode === undefined ? {} : versColonnesPreference(emailMode)),
        ...(mutedJson === undefined ? {} : { muted_kinds: mutedJson }),
      });
      return;
    }
    const global = groupIdOrStar === '*';
    const colonnes =
      emailMode !== undefined
        ? versColonnesPreference(emailMode)
        : global
          ? versColonnesPreference('immediate')
          : { channel_email: null, digest: null };
    portee.inserer('notification_preferences', { group_id: groupIdOrStar, ...colonnes, muted_kinds: mutedJson ?? (global ? '[]' : null) });
  });
  return lirePreferencesNotifications(portee);
}

/**
 * « Reprendre le réglage global » : supprime la ligne du groupe, qui n'a alors plus rien de propre et suit la ligne `'*'` sur les deux
 * champs. Le groupe doit être l'un de ceux dont le compte est membre actif (sinon `'groupe_introuvable'`, comme `definirPreferenceNotification`) ;
 * sans ligne propre, c'est un succès sans effet. `'*'` n'a pas de niveau au-dessus à reprendre : refusé.
 */
export function reprendreReglageGlobal(portee: PorteeUtilisateur, groupId: string): PreferenceNotificationVue[] | 'groupe_introuvable' {
  if (groupId === '*' || !mesGroupes(portee).some((g) => g.group_id === groupId)) return 'groupe_introuvable';
  portee.supprimer('notification_preferences', { group_id: groupId });
  return lirePreferencesNotifications(portee);
}

const destinataireLigne = z.object({
  membership_id: z.string(),
  compte_id: z.string(),
  email: z.string(),
  email_verified_at: z.string().nullable(),
  display_name: z.string(),
});

const prefLigneCourte = z.object({
  group_id: z.string(),
  channel_email: z.union([z.literal(0), z.literal(1)]).nullable(),
  digest: z.enum(['instant', 'daily', 'off']).nullable(),
  muted_kinds: z.string().nullable(),
});

function parserMutedKinds(brut: string): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(brut);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

/**
 * Résolution CHAMP PAR CHAMP : pour le mode e-mail comme pour les genres coupés, la valeur du groupe si elle est posée (colonne non
 * NULL), sinon celle de la ligne globale `'*'`, sinon le défaut (e-mail immédiat, rien de coupé). Un NULL sur la ligne globale vaut
 * le défaut (la base l'interdit pour `'*'`, mais on ne s'y fie pas). Le client reproduit cette règle (`preferenceEffective`).
 */
function resoudrePreferenceNotification(
  base: Base,
  userId: string,
  groupId: string,
): { readonly emailMode: EmailMode; readonly mutedKinds: ReadonlySet<string> } {
  const prefs = preparer(
    base,
    'SELECT group_id, channel_email, digest, muted_kinds FROM notification_preferences WHERE user_id = ?',
  )
    .all(userId)
    .map((l) => prefLigneCourte.parse(l));
  const specifique = prefs.find((p) => p.group_id === groupId);
  const global = prefs.find((p) => p.group_id === '*');
  const mutedBrut = specifique?.muted_kinds ?? global?.muted_kinds ?? null;
  return {
    emailMode:
      (specifique === undefined ? null : versEmailMode(specifique.channel_email, specifique.digest)) ??
      (global === undefined ? null : versEmailMode(global.channel_email, global.digest)) ??
      'immediate',
    mutedKinds: mutedBrut === null ? new Set() : parserMutedKinds(mutedBrut),
  };
}

export interface OptionsNotificationGroupe {
  readonly kind: NotificationKind;
  readonly subjectType: SubjectType;
  readonly subjectId: string;
  readonly payload: Readonly<Record<string, string>>;
  readonly baseUrl: string;
  readonly lienChemin: string;
  readonly maintenant: string;
  /**
   * Restreint la diffusion à ces memberships. Ce n'est PAS un contournement du cloisonnement : la liste n'est qu'un second filtre,
   * appliqué APRÈS la sélection `m.group_id = scope.groupId` — un identifiant d'un autre groupe (ou forgé) n'y retrouve personne.
   * Absente : tous les membres actifs. Fournie vide : personne.
   */
  readonly destinataires?: ReadonlySet<string>;
  /** Gabarit d'e-mail immédiat (clé de `emails.*` dans i18n/fr.json). Par défaut `notification_immediate`. */
  readonly gabaritEmail?: keyof typeof fr.emails;
}

/** Un destinataire de notification Web Push : db/ ne fait que le désigner, l'envoi réseau se fait en service, après le commit. */
export interface DestinatairePush {
  readonly compteId: string;
  /** Nom du groupe, titre de la notification. */
  readonly titre: string;
  readonly lien: string;
  readonly tag: string;
}

/**
 * Crée une notification pour chaque membre actif du groupe (sauf l'auteur du scope ; `options.destinataires` peut restreindre) et enfile
 * un e-mail minimal immédiat si la préférence du destinataire est `immediate` et son adresse vérifiée.
 * Rend les destinataires à notifier en Web Push : db/ n'appelle jamais le réseau. L'appelant (service) les passe à l'envoi APRÈS le
 * commit de sa transaction, pour qu'une transaction annulée ne laisse pas partir de notification.
 */
export function notifierMembresGroupe(scope: GroupScope, options: OptionsNotificationGroupe): DestinatairePush[] {
  const base = baseDeScope(scope);
  const groupe = scope.groupe<{ name: string }>();
  if (groupe === undefined) return [];
  const destinataires = preparer(
    base,
    `SELECT m.id AS membership_id, u.id AS compte_id, u.email AS email, u.email_verified_at AS email_verified_at,
            u.display_name AS display_name
     FROM memberships AS m
     JOIN users AS u ON u.id = m.user_id
     WHERE m.group_id = ? AND m.status = 'active' AND u.disabled_at IS NULL AND u.anonymized_at IS NULL`,
  )
    .all(scope.groupId)
    .map((l) => destinataireLigne.parse(l))
    .filter((d) => d.membership_id !== scope.membershipId)
    .filter((d) => options.destinataires === undefined || options.destinataires.has(d.membership_id));

  const lien = new URL(options.lienChemin, options.baseUrl).toString();
  const payloadJson = JSON.stringify(options.payload);
  const insererNotif = preparer(
    base,
    `INSERT INTO notifications (id, user_id, group_id, kind, subject_type, subject_id, payload_json, created_at, email_queued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const aPousser: DestinatairePush[] = [];
  for (const dest of destinataires) {
    const pref = resoudrePreferenceNotification(base, dest.compte_id, scope.groupId);
    if (pref.mutedKinds.has(options.kind)) continue;
    const envoiImmediat = pref.emailMode === 'immediate' && dest.email_verified_at !== null;
    insererNotif.run(
      nouvelIdentifiant(),
      dest.compte_id,
      scope.groupId,
      options.kind,
      options.subjectType,
      options.subjectId,
      payloadJson,
      options.maintenant,
      envoiImmediat ? options.maintenant : null,
    );
    if (envoiImmediat) {
      enfilerEmail(
        base,
        {
          to: dest.email,
          templateKey: options.gabaritEmail ?? 'notification_immediate',
          payload: { nom: dest.display_name, groupe: groupe.name, lien },
        },
        options.maintenant,
      );
    }
    aPousser.push({
      compteId: dest.compte_id,
      titre: groupe.name,
      lien,
      tag: `${options.subjectType}:${options.subjectId}`,
    });
  }
  return aPousser;
}

function heureDansFuseau(date: Date, fuseau: string): number {
  try {
    const texte = new Intl.DateTimeFormat('en-US', { timeZone: fuseau, hour: 'numeric', hour12: false }).format(date);
    const h = Number.parseInt(texte, 10);
    return Number.isNaN(h) ? date.getUTCHours() : h % 24;
  } catch {
    return date.getUTCHours();
  }
}

/**
 * Regroupe par (compte, groupe) les notifications non lues en attente de résumé quotidien,
 * et enfile un e-mail récapitulatif dès qu'il est au moins 19 h dans le fuseau du groupe.
 */
export function envoyerResumesQuotidiens(base: Base, baseUrl: string, maintenantDate: Date): number {
  return executerEnTransaction(base, () => {
    const enAttente = listerNotificationsEnAttenteResume(base);
    if (enAttente.length === 0) return 0;

    const maintenant = maintenantDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const lots = new Map<string, typeof enAttente>();
    for (const item of enAttente) {
      const cle = `${item.user_id}\0${item.group_id}`;
      const liste = lots.get(cle) ?? [];
      liste.push(item);
      lots.set(cle, liste);
    }

    const marquerEnfilee = preparer(base, 'UPDATE notifications SET email_queued_at = ? WHERE id = ? AND user_id = ?');
    let emailsEnfiles = 0;

    for (const items of lots.values()) {
      const premier = items[0];
      if (premier === undefined) continue;
      if (heureDansFuseau(maintenantDate, premier.time_zone) < 19) continue;
      if (resoudrePreferenceNotification(base, premier.user_id, premier.group_id).emailMode !== 'daily') continue;

      const lien = new URL(`/#/groupe/${encodeURIComponent(premier.group_id)}/fils`, baseUrl).toString();
      enfilerEmail(
        base,
        {
          to: premier.email,
          templateKey: 'resume_quotidien',
          payload: {
            nom: premier.display_name,
            groupe: premier.group_name,
            nombre: String(items.length),
            lien,
          },
        },
        maintenant,
      );
      for (const item of items) {
        marquerEnfilee.run(maintenant, item.notification_id, item.user_id);
      }
      emailsEnfiles++;
    }

    return emailsEnfiles;
  });
}
