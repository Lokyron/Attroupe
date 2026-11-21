import { corpsPreference, estGenreNotification, type ChangementPreference, type EmailMode, type GenreNotification } from '../lib/preferences-notifications';
import type { StatutInvitation } from '../lib/notifications-vue';
import { appeler, booleen, champ, liste, nombre, texte, texteOuNul } from './client';

export type { EmailMode, GenreNotification };

export type { StatutInvitation };

export type FiltreNotifications = 'non_lues' | 'toutes';

export interface Notification {
  id: string;
  group_id: string | null;
  group_name: string | null;
  kind: string;
  subject_type: string | null;
  subject_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  read_at: string | null;
  /** État de l'invitation visée par une notification `invitation_received` ; `null` pour tout autre genre. */
  invitation_statut: StatutInvitation | null;
}

export interface ListeNotifications {
  notifications: Notification[];
  /** Non lues du compte, tous filtres confondus. */
  non_lues: number;
  /** Il reste des notifications au-delà de la page demandée. */
  a_suite: boolean;
  /** Curseur à passer en `avant` pour la page suivante ; `null` s'il n'y en a pas. */
  curseur_suivant: string | null;
}

export interface PreferenceNotification {
  group_id: string;
  group_name: string | null;
  /** Mode posé par cette ligne ; `null` : le groupe hérite du mode global (jamais `null` pour `'*'`). */
  email_mode: EmailMode | null;
  /** Genres coupés par cette ligne (aucune notification de ce genre n'est créée) ; `null` : hérités de la ligne globale (jamais `null` pour `'*'`). */
  muted_kinds: GenreNotification[] | null;
  updated_at: string;
}

function statutInvitation(valeur: unknown): StatutInvitation | null {
  if (valeur === null) return null;
  if (valeur !== 'pending' && valeur !== 'accepted' && valeur !== 'declined' && valeur !== 'revoked' && valeur !== 'expired') {
    throw new Error("État d'invitation inconnu.");
  }
  return valeur;
}

function notification(n: unknown): Notification {
  const payload = champ(n, 'payload');
  return {
    id: texte(champ(n, 'id')),
    group_id: texteOuNul(champ(n, 'group_id')),
    group_name: texteOuNul(champ(n, 'group_name')),
    kind: texte(champ(n, 'kind')),
    subject_type: texteOuNul(champ(n, 'subject_type')),
    subject_id: texteOuNul(champ(n, 'subject_id')),
    payload: typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {},
    created_at: texte(champ(n, 'created_at')),
    read_at: texteOuNul(champ(n, 'read_at')),
    invitation_statut: statutInvitation(champ(n, 'invitation_statut')),
  };
}

function preference(p: unknown): PreferenceNotification {
  const mode = champ(p, 'email_mode');
  if (mode !== null && mode !== 'immediate' && mode !== 'daily' && mode !== 'off') throw new Error('Mode e-mail inconnu.');
  const brut = champ(p, 'muted_kinds');
  const coupes =
    brut === null
      ? null
      : liste(brut).map((g) => {
          if (!estGenreNotification(g)) throw new Error('Genre de notification inconnu.');
          return g;
        });
  return {
    group_id: texte(champ(p, 'group_id')),
    group_name: texteOuNul(champ(p, 'group_name')),
    email_mode: mode,
    muted_kinds: coupes,
    updated_at: texte(champ(p, 'updated_at')),
  };
}

/** Une page de `limite` notifications ; `avant` (le `curseur_suivant` de la page précédente) demande la suivante. */
export async function listerNotifications(filtre: FiltreNotifications = 'toutes', limite = 50, avant?: string): Promise<ListeNotifications> {
  const curseur = avant === undefined ? '' : `&avant=${encodeURIComponent(avant)}`;
  const r = await appeler('GET', `/api/moi/notifications?filtre=${filtre}&limite=${String(limite)}${curseur}`);
  return {
    notifications: liste(champ(r, 'notifications')).map(notification),
    non_lues: nombre(champ(r, 'non_lues')),
    a_suite: booleen(champ(r, 'a_suite')),
    curseur_suivant: texteOuNul(champ(r, 'curseur_suivant')),
  };
}

export async function marquerNotificationsLues(ids?: string[]): Promise<number> {
  const r = await appeler('POST', '/api/moi/notifications/lecture', ids === undefined ? { tout: true } : { ids });
  return nombre(champ(r, 'lues'));
}

export async function listerPreferencesNotifications(): Promise<PreferenceNotification[]> {
  const r = await appeler('GET', '/api/moi/preferences-notifications');
  return liste(champ(r, 'preferences')).map(preference);
}

/** Envoie seulement les champs fournis : un champ absent n'est pas modifié côté serveur. */
export async function definirPreferenceNotification(groupId: string, changement: ChangementPreference): Promise<PreferenceNotification[]> {
  const r = await appeler('PUT', '/api/moi/preferences-notifications', corpsPreference(groupId, changement));
  return liste(champ(r, 'preferences')).map(preference);
}

/** « Reprendre le réglage global » : supprime la ligne du groupe, qui suit alors la ligne globale (champs à NULL), sans recopie. */
export async function reprendreReglageGlobal(groupId: string): Promise<PreferenceNotification[]> {
  const r = await appeler('DELETE', `/api/moi/preferences-notifications/${encodeURIComponent(groupId)}`);
  return liste(champ(r, 'preferences')).map(preference);
}

export interface ClePush {
  cle_publique: string;
  nb_appareils: number;
}

export interface AbonnementPushPayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/**
 * Accusé neutre : le serveur envoie la notification en arrière-plan et ne dit pas si la cible a
 * répondu — révéler ce résultat en ferait un oracle de balayage réseau. On ne connaît donc que
 * le nombre d'appareils enregistrés.
 */
export interface ResultatTestPush {
  appareils: number;
}

export async function lireClePush(): Promise<ClePush> {
  const r = await appeler('GET', '/api/moi/push/cle');
  return {
    cle_publique: texte(champ(r, 'cle_publique')),
    nb_appareils: nombre(champ(r, 'nb_appareils')),
  };
}

export async function enregistrerAbonnementPush(abonnement: AbonnementPushPayload): Promise<string> {
  const r = await appeler('POST', '/api/moi/push/abonnement', abonnement);
  return texte(champ(r, 'id'));
}

export async function supprimerAbonnementPush(endpoint?: string): Promise<number> {
  const r = await appeler('DELETE', '/api/moi/push/abonnement', endpoint !== undefined ? { endpoint } : {});
  return nombre(champ(r, 'supprimes'));
}

export async function testerNotificationPush(): Promise<ResultatTestPush> {
  const r = await appeler('POST', '/api/moi/push/test', {});
  return { appareils: nombre(champ(r, 'appareils')) };
}
