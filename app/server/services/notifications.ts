import { z } from 'zod';
import fr from '../i18n/fr.json' with { type: 'json' };
import type { PorteeUtilisateur } from '../db/portee-utilisateur.js';
import {
  definirPreferenceNotification,
  lirePreferencesNotifications,
  listerMesNotifications,
  marquerNotificationsLues,
  type DestinatairePush,
  type EmailMode,
  type NotificationKind,
  type ListeNotifications,
  type PreferenceNotificationVue,
} from '../db/queries/notifications.js';
import { versInstant } from '../domain/instant.js';
import type { Contexte } from '../http/contexte.js';
import { ErreurHttp } from '../http/erreurs.js';
import { envoyerNotificationPush } from './push.js';

const LIBELLES_PUSH = z
  .object({
    event_created: z.string(),
    expense_added: z.string(),
    expense_updated: z.string(),
    expense_deleted: z.string(),
    settlement_created: z.string(),
    settlement_confirmed: z.string(),
  })
  .parse(fr.notifications_push);

export function mesNotifications(portee: PorteeUtilisateur): ListeNotifications {
  return listerMesNotifications(portee);
}

export function marquerLues(contexte: Contexte, portee: PorteeUtilisateur, ids?: readonly string[]): number {
  return marquerNotificationsLues(portee, ids, versInstant(contexte.horloge()));
}

export function mesPreferencesNotifications(portee: PorteeUtilisateur): PreferenceNotificationVue[] {
  return lirePreferencesNotifications(portee);
}

export function definirMaPreferenceNotification(
  portee: PorteeUtilisateur,
  groupIdOrStar: string,
  emailMode: EmailMode,
): PreferenceNotificationVue[] {
  const resultat = definirPreferenceNotification(portee, groupIdOrStar, emailMode);
  if (resultat === 'groupe_introuvable') throw new ErreurHttp(404, 'groupe.introuvable');
  return resultat;
}

/** Texte d'une notification Web Push d'après le genre et le contenu de la notification en application (clés fournies par l'appelant). */
export function libelleNotificationPush(kind: NotificationKind, payload: Readonly<Record<string, string>>): string {
  const filTitre = payload['thread_title'];
  if (kind === 'message_posted') {
    return filTitre !== undefined && filTitre !== '' ? `Nouveau message dans « ${filTitre} »` : 'Nouveau message dans le groupe';
  }
  // Libellés génériques : ni titre, ni montant, ni nom (même discipline que le message, dont le texte ne part jamais).
  if (kind === 'event_created') return LIBELLES_PUSH.event_created;
  if (kind === 'expense_added') return LIBELLES_PUSH.expense_added;
  if (kind === 'expense_updated') return LIBELLES_PUSH.expense_updated;
  if (kind === 'expense_deleted') return LIBELLES_PUSH.expense_deleted;
  if (kind === 'settlement_created') return LIBELLES_PUSH.settlement_created;
  if (kind === 'settlement_confirmed') return LIBELLES_PUSH.settlement_confirmed;
  return 'Nouvelle activité dans le groupe';
}

/**
 * Envoie les notifications Web Push d'une action de groupe, EN ARRIÈRE-PLAN et APRÈS le commit de la transaction qui a créé les
 * notifications (jamais depuis db/ ni depuis l'intérieur d'une transaction). Ne bloque pas la réponse HTTP ; tout échec est journalisé
 * (jamais avalé) : un service push lent ou en panne ne doit ni retarder ni faire échouer l'action de l'utilisateur.
 */
export function pousserNotificationsWebPush(
  contexte: Contexte,
  destinataires: readonly DestinatairePush[],
  libelle: string,
): void {
  for (const dest of destinataires) {
    envoyerNotificationPush(
      contexte.base,
      dest.compteId,
      { title: dest.titre, body: libelle, url: dest.lien, tag: dest.tag },
      { env: contexte.env, journal: contexte.journal, maintenant: contexte.horloge() },
    ).then(
      (resultat) => {
        if (resultat.echecs > 0) contexte.journal.warn('push.envoi_partiel', { envoyes: resultat.envoyes, echecs: resultat.echecs });
      },
      (erreur: unknown) => {
        contexte.journal.error('push.envoi_impossible', { erreur: erreur instanceof Error ? erreur.message : String(erreur) });
      },
    );
  }
}
