import { z } from 'zod';
import fr from '../../i18n/fr.json' with { type: 'json' };
import type { Base } from '../base.js';
import { nouvelIdentifiant } from '../identifiant.js';
import type { PorteeUtilisateur } from '../portee-utilisateur.js';
import { baseDeScope, type GroupScope } from '../scope.js';
import { executerEnTransaction, preparer } from '../sql.js';
import { enfilerEmail, listerNotificationsEnAttenteResume, mesGroupes } from './transverse.js';

// Notifications en application et préférences d'envoi par e-mail (modèle §3.12, architecture §7.3).
//  - Lectures/modifications de l'utilisateur connecté : PorteeUtilisateur (`notifications`, `notification_preferences`).
//  - Diffusion lors d'une action dans un groupe : `notifierMembresGroupe` sous `GroupScope`.
//  - Résumé quotidien : `envoyerResumesQuotidiens` appelé par les tâches périodiques.

export type EmailMode = 'immediate' | 'daily' | 'off';

export type NotificationKind =
  | 'invitation_received'
  | 'member_joined'
  | 'event_created'
  | 'event_updated'
  | 'event_cancelled'
  | 'poll_opened'
  | 'poll_closing'
  | 'item_claimed'
  | 'task_assigned'
  | 'message_posted'
  | 'expense_added'
  | 'accounts_closed';

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
}

export interface ListeNotifications {
  readonly notifications: NotificationVue[];
  readonly non_lues: number;
}

const lignePreference = z.object({
  group_id: z.string(),
  channel_email: z.union([z.literal(0), z.literal(1)]),
  digest: z.enum(['instant', 'daily', 'off']),
  created_at: z.string(),
  updated_at: z.string(),
});

export interface PreferenceNotificationVue {
  readonly group_id: string;
  readonly group_name: string | null;
  readonly email_mode: EmailMode;
  readonly updated_at: string;
}

function versEmailMode(channelEmail: 0 | 1, digest: 'instant' | 'daily' | 'off'): EmailMode {
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

/** Liste les notifications du compte connecté (plus récentes d'abord) et le compteur de non lues. */
export function listerMesNotifications(portee: PorteeUtilisateur, limite = 50): ListeNotifications {
  const noms = new Map(mesGroupes(portee).map((g) => [g.group_id, g.name]));
  const lignes = portee
    .tous<unknown>('notifications', undefined, { ordre: [{ colonne: 'created_at', sens: 'DESC' }, { colonne: 'id', sens: 'DESC' }], limite })
    .map((l) => ligneNotification.parse(l));
  const nonLues = portee.tous<{ id: string }>('notifications', [{ colonne: 'read_at', operateur: 'IS NULL' }]).length;
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
    })),
    non_lues: nonLues,
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
      email_mode: versEmailMode(p.channel_email, p.digest),
      updated_at: p.updated_at,
    }));
}

/** Définit la préférence de notification par e-mail pour `'*'` ou un groupe dont le compte est membre actif. */
export function definirPreferenceNotification(
  portee: PorteeUtilisateur,
  groupIdOrStar: string,
  emailMode: EmailMode,
): PreferenceNotificationVue[] | 'groupe_introuvable' {
  if (groupIdOrStar !== '*') {
    const membre = mesGroupes(portee).some((g) => g.group_id === groupIdOrStar);
    if (!membre) return 'groupe_introuvable';
  }
  const { channel_email, digest } = versColonnesPreference(emailMode);
  portee.transaction(() => {
    const existante = portee.tous<unknown>('notification_preferences', [{ colonne: 'group_id', operateur: '=', valeur: groupIdOrStar }]);
    if (existante.length > 0) {
      portee.modifierPar('notification_preferences', { group_id: groupIdOrStar }, { channel_email, digest });
    } else {
      portee.inserer('notification_preferences', { group_id: groupIdOrStar, channel_email, digest, muted_kinds: '[]' });
    }
  });
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
  channel_email: z.union([z.literal(0), z.literal(1)]),
  digest: z.enum(['instant', 'daily', 'off']),
});

function resoudreModeEmail(base: Base, userId: string, groupId: string): EmailMode {
  const prefs = preparer(base, 'SELECT group_id, channel_email, digest FROM notification_preferences WHERE user_id = ?')
    .all(userId)
    .map((l) => prefLigneCourte.parse(l));
  const specifique = prefs.find((p) => p.group_id === groupId);
  if (specifique !== undefined) return versEmailMode(specifique.channel_email, specifique.digest);
  const global = prefs.find((p) => p.group_id === '*');
  if (global !== undefined) return versEmailMode(global.channel_email, global.digest);
  return 'immediate';
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
    const mode = resoudreModeEmail(base, dest.compte_id, scope.groupId);
    const envoiImmediat = mode === 'immediate' && dest.email_verified_at !== null;
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
      if (resoudreModeEmail(base, premier.user_id, premier.group_id) !== 'daily') continue;

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
