// Logique pure de la page Notifications : invitations et notifications partagent le même historique (le badge, lui, est calculé par le serveur).
// Types d'entrée structurels et minimaux (`Notification` et `InvitationRecue` de api/ les satisfont) : ce fichier n'importe rien,
// pour rester chargeable par les tests sous Node.

export type StatutInvitation = 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';

interface NotificationEntree {
  readonly kind: string;
  readonly subject_id: string | null;
  readonly invitation_statut: StatutInvitation | null;
}

/** Clés de fr.json des issues d'une invitation traitée. */
export type CleStatutInvitation =
  | 'notifications.invitation_acceptee'
  | 'notifications.invitation_refusee'
  | 'notifications.invitation_revoquee'
  | 'notifications.invitation_expiree';

/**
 * Invitations en attente à montrer à part : celles que NE porte pas déjà une notification de la liste (sinon elle serait affichée
 * deux fois). Le serveur écrit une notification à chaque invitation envoyée à un compte : ce sont donc surtout des invitations plus anciennes
 * que le déploiement, ou dont le genre est coupé dans les préférences.
 */
export function invitationsSansNotification<I extends { readonly id: string }>(
  invitations: readonly I[],
  notifications: readonly NotificationEntree[],
): I[] {
  const portees = new Set(
    notifications.filter((n) => n.kind === 'invitation_received' && n.subject_id !== null).map((n) => n.subject_id),
  );
  return invitations.filter((i) => !portees.has(i.id));
}

/** Notification d'invitation sur laquelle on peut répondre ici : l'invitation est encore en attente (`subject_id` est son identifiant). */
export function invitationActionnable(n: NotificationEntree): string | null {
  return n.kind === 'invitation_received' && n.subject_id !== null && n.invitation_statut === 'pending' ? n.subject_id : null;
}

const LIBELLES_STATUT: Readonly<Record<Exclude<StatutInvitation, 'pending'>, CleStatutInvitation>> = {
  accepted: 'notifications.invitation_acceptee',
  declined: 'notifications.invitation_refusee',
  revoked: 'notifications.invitation_revoquee',
  expired: 'notifications.invitation_expiree',
};

/** Libellé de l'issue d'une invitation traitée ; `null` si elle est en attente ou si la notification n'en est pas une. */
export function cleStatutInvitation(n: NotificationEntree): CleStatutInvitation | null {
  if (n.kind !== 'invitation_received' || n.invitation_statut === null || n.invitation_statut === 'pending') return null;
  return LIBELLES_STATUT[n.invitation_statut];
}

/** Ce que la charge utile d'une notification d'invitation dit de l'invitation (écrite par le serveur à l'envoi). */
export interface DetailInvitation {
  readonly invitant: string;
  readonly groupe: string;
  readonly role: 'admin' | 'member';
}

/**
 * Détail d'une notification `invitation_received` d'après sa charge utile ; `null` si un champ manque ou est mal typé (notification
 * ancienne ou écrite autrement) : l'appelant garde alors le libellé générique.
 */
export function detailInvitation(n: { readonly kind: string; readonly payload: Readonly<Record<string, unknown>> }): DetailInvitation | null {
  if (n.kind !== 'invitation_received') return null;
  const { invited_by_name: invitant, group_name: groupe, role } = n.payload;
  if (typeof invitant !== 'string' || invitant === '' || typeof groupe !== 'string' || groupe === '') return null;
  if (role !== 'admin' && role !== 'member') return null;
  return { invitant, groupe, role };
}
