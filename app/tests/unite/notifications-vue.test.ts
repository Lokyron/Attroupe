import { describe, expect, it } from 'vitest';
import {
  cleStatutInvitation,
  detailInvitation,
  invitationActionnable,
  invitationsSansNotification,
  type StatutInvitation,
} from '../../client/src/lib/notifications-vue.js';

interface Notification {
  id: string;
  kind: string;
  subject_id: string | null;
  invitation_statut: StatutInvitation | null;
}
interface InvitationRecue {
  id: string;
}

const notif = (extra: Partial<Notification> = {}): Notification => ({
  id: 'n1',
  kind: 'event_created',
  subject_id: null,
  invitation_statut: null,
  ...extra,
});

const invitationNotif = (statut: StatutInvitation | null, sujet: string | null = 'i1'): Notification =>
  notif({ kind: 'invitation_received', subject_id: sujet, invitation_statut: statut });

const recue = (id: string): InvitationRecue => ({ id });

// Le badge n'est plus calculé ici : `GET /api/moi` → `notifications_a_voir` (test : integration/notifications-invitation.test.ts).

describe('invitationsSansNotification', () => {
  it('garde toutes les invitations quand aucune notification ne les porte', () => {
    expect(invitationsSansNotification([recue('i1'), recue('i2')], [notif()]).map((i) => i.id)).toEqual(['i1', 'i2']);
  });

  it('écarte celles déjà portées par une notification d’invitation (pas de doublon)', () => {
    expect(invitationsSansNotification([recue('i1'), recue('i2')], [invitationNotif('pending', 'i1')]).map((i) => i.id)).toEqual(['i2']);
  });

  it('ne tient pas compte d’une notification d’un autre genre qui porte le même identifiant', () => {
    expect(invitationsSansNotification([recue('i1')], [notif({ subject_id: 'i1' })]).map((i) => i.id)).toEqual(['i1']);
  });
});

describe('invitationActionnable', () => {
  it('rend l’identifiant de l’invitation tant qu’elle est en attente', () => {
    expect(invitationActionnable(invitationNotif('pending', 'i9'))).toBe('i9');
  });

  it('ne propose rien pour une invitation traitée, expirée, inconnue ou sans sujet', () => {
    for (const statut of ['accepted', 'declined', 'revoked', 'expired', null] as const) {
      expect(invitationActionnable(invitationNotif(statut))).toBeNull();
    }
    expect(invitationActionnable(invitationNotif('pending', null))).toBeNull();
  });

  it('ne propose rien pour une autre notification', () => {
    expect(invitationActionnable(notif())).toBeNull();
  });
});

describe('cleStatutInvitation', () => {
  it('donne le libellé de chaque issue', () => {
    expect(cleStatutInvitation(invitationNotif('accepted'))).toBe('notifications.invitation_acceptee');
    expect(cleStatutInvitation(invitationNotif('declined'))).toBe('notifications.invitation_refusee');
    expect(cleStatutInvitation(invitationNotif('revoked'))).toBe('notifications.invitation_revoquee');
    expect(cleStatutInvitation(invitationNotif('expired'))).toBe('notifications.invitation_expiree');
  });

  it('n’en donne pas pour une invitation en attente ou une autre notification', () => {
    expect(cleStatutInvitation(invitationNotif('pending'))).toBeNull();
    expect(cleStatutInvitation(notif())).toBeNull();
  });
});

describe('detailInvitation', () => {
  const payload = { group_name: 'Famille', invited_by_name: 'Alice', role: 'member' };

  it('lit invitant, groupe et rôle dans la charge utile', () => {
    expect(detailInvitation({ kind: 'invitation_received', payload })).toEqual({ invitant: 'Alice', groupe: 'Famille', role: 'member' });
  });

  it('rend null (libellé générique) si un champ manque, est vide ou mal typé, ou pour un autre genre', () => {
    expect(detailInvitation({ kind: 'invitation_received', payload: { ...payload, invited_by_name: '' } })).toBeNull();
    expect(detailInvitation({ kind: 'invitation_received', payload: { group_name: 'Famille', role: 'member' } })).toBeNull();
    expect(detailInvitation({ kind: 'invitation_received', payload: { ...payload, role: 'roi' } })).toBeNull();
    expect(detailInvitation({ kind: 'invitation_received', payload: { ...payload, group_name: 3 } })).toBeNull();
    expect(detailInvitation({ kind: 'event_created', payload })).toBeNull();
  });
});
