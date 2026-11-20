// Les genres de notification connus du serveur : source unique, partagée par la base (CHECK de `notifications.kind`, migration 0006),
// les requêtes (`NotificationKind`) et la validation des genres coupés (`muted_kinds`) — une chaîne libre n'y a pas sa place.
export const GENRES_NOTIFICATION = [
  'invitation_received',
  'member_joined',
  'event_created',
  'event_updated',
  'event_cancelled',
  'poll_opened',
  'poll_closing',
  'item_claimed',
  'task_assigned',
  'message_posted',
  'expense_added',
  'expense_updated',
  'expense_deleted',
  'settlement_created',
  'settlement_confirmed',
  'accounts_closed',
] as const;

export type GenreNotification = (typeof GENRES_NOTIFICATION)[number];

export function estGenreNotification(valeur: unknown): valeur is GenreNotification {
  return typeof valeur === 'string' && (GENRES_NOTIFICATION as readonly string[]).includes(valeur);
}
