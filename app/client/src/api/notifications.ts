import { appeler, champ, liste, nombre, texte, texteOuNul } from './client';

export type EmailMode = 'immediate' | 'daily' | 'off';

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
}

export interface ListeNotifications {
  notifications: Notification[];
  non_lues: number;
}

export interface PreferenceNotification {
  group_id: string;
  group_name: string | null;
  email_mode: EmailMode;
  updated_at: string;
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
  };
}

function preference(p: unknown): PreferenceNotification {
  const mode = champ(p, 'email_mode');
  if (mode !== 'immediate' && mode !== 'daily' && mode !== 'off') throw new Error('Mode e-mail inconnu.');
  return {
    group_id: texte(champ(p, 'group_id')),
    group_name: texteOuNul(champ(p, 'group_name')),
    email_mode: mode,
    updated_at: texte(champ(p, 'updated_at')),
  };
}

export async function listerNotifications(): Promise<ListeNotifications> {
  const r = await appeler('GET', '/api/moi/notifications');
  return {
    notifications: liste(champ(r, 'notifications')).map(notification),
    non_lues: nombre(champ(r, 'non_lues')),
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

export async function definirPreferenceNotification(groupId: string, emailMode: EmailMode): Promise<PreferenceNotification[]> {
  const r = await appeler('PUT', '/api/moi/preferences-notifications', { group_id: groupId, email_mode: emailMode });
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
