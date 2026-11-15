import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';

// Verrou n° 4 (architecture §4, modèle de données §4.1) : la base elle-même refuse qu'un enfant
// du groupe X se rattache à un parent du groupe Y. Ces essais sont ceux faits à la main lors de
// la conception (modèle §5.1), automatisés et étendus à d'autres couples parent/enfant.
const T0 = '2026-01-01T00:00:00Z';

interface Essai {
  readonly nom: string;
  readonly sql: string;
  readonly params: (d: DeuxGroupes) => unknown[];
}

describe('clés étrangères composites : la base refuse l’incohérence de groupe', () => {
  let t: BaseTemporaire;
  let d: DeuxGroupes;

  // Une base neuve par essai : un essai légitime ne doit pas dépendre de l'ordre des autres.
  beforeEach(() => {
    t?.nettoyer();
    t = baseTemporaire();
    d = deuxGroupes(t.base);
  });
  afterAll(() => t?.nettoyer());

  const refuses: Essai[] = [
    {
      nom: 'un article du groupe B greffé sur une liste du groupe A',
      sql: `INSERT INTO shopping_items (id, shopping_list_id, group_id, label, position, created_by_membership_id, created_at, updated_at)
            VALUES ('i2', ?, ?, 'Pirate', 2, ?, '${T0}', '${T0}')`,
      params: (g) => [g.a.listId, g.b.groupId, g.b.membershipId],
    },
    {
      nom: 'un article du groupe A créé par un membre du groupe B',
      sql: `INSERT INTO shopping_items (id, shopping_list_id, group_id, label, position, created_by_membership_id, created_at, updated_at)
            VALUES ('i2', ?, ?, 'Pirate', 2, ?, '${T0}', '${T0}')`,
      params: (g) => [g.a.listId, g.a.groupId, g.b.membershipId],
    },
    {
      nom: 'un membre du groupe B qui réclame un article du groupe A',
      sql: `UPDATE shopping_items SET claimed_by_membership_id = ?, claimed_at = '${T0}' WHERE id = ?`,
      params: (g) => [g.b.membershipId, g.a.itemId],
    },
    {
      nom: 'la présence d’un membre de B à un événement de A',
      sql: `INSERT INTO event_attendances (event_id, group_id, membership_id, status, responded_at, updated_at)
            VALUES (?, ?, ?, 'yes', '${T0}', '${T0}')`,
      params: (g) => [g.a.eventId, g.a.groupId, g.b.membershipId],
    },
    {
      nom: 'une présence de B rattachée à un événement de A',
      sql: `INSERT INTO event_attendances (event_id, group_id, membership_id, status, responded_at, updated_at)
            VALUES (?, ?, ?, 'yes', '${T0}', '${T0}')`,
      params: (g) => [g.a.eventId, g.b.groupId, g.b.membershipId],
    },
    {
      nom: 'un événement de A organisé par un membre de B',
      sql: `UPDATE events SET host_membership_id = ? WHERE id = ?`,
      params: (g) => [g.b.membershipId, g.a.eventId],
    },
    {
      nom: 'une liste de courses de A rattachée à un événement de B',
      sql: `UPDATE shopping_lists SET event_id = ? WHERE id = ?`,
      params: (g) => [g.b.eventId, g.a.listId],
    },
    {
      nom: 'une dépense de A réglée par un membre de B',
      sql: `UPDATE expenses SET payer_membership_id = ? WHERE id = ?`,
      params: (g) => [g.b.membershipId, g.a.expenseId],
    },
    {
      nom: 'une dépense de A rattachée à un événement de B',
      sql: `UPDATE expenses SET event_id = ? WHERE id = ?`,
      params: (g) => [g.b.eventId, g.a.expenseId],
    },
    {
      nom: 'la part d’un membre de B sur une dépense de A',
      sql: `INSERT INTO expense_shares (expense_id, group_id, membership_id, share_minor, share_target_minor, created_at, updated_at)
            VALUES (?, ?, ?, 500, 500, '${T0}', '${T0}')`,
      params: (g) => [g.a.expenseId, g.a.groupId, g.b.membershipId],
    },
    {
      nom: 'une part du groupe B sur une dépense de A',
      sql: `INSERT INTO expense_shares (expense_id, group_id, membership_id, share_minor, share_target_minor, created_at, updated_at)
            VALUES (?, ?, ?, 500, 500, '${T0}', '${T0}')`,
      params: (g) => [g.a.expenseId, g.b.groupId, g.b.membershipId],
    },
    {
      nom: 'un message du groupe B dans un fil de A',
      sql: `INSERT INTO messages (id, thread_id, group_id, author_membership_id, body, created_at)
            VALUES ('msg2', ?, ?, ?, 'Pirate', '${T0}')`,
      params: (g) => [g.a.threadId, g.b.groupId, g.b.membershipId],
    },
    {
      nom: 'un message du groupe A écrit par un membre de B',
      sql: `INSERT INTO messages (id, thread_id, group_id, author_membership_id, body, created_at)
            VALUES ('msg2', ?, ?, ?, 'Pirate', '${T0}')`,
      params: (g) => [g.a.threadId, g.a.groupId, g.b.membershipId],
    },
    {
      nom: 'une réponse de A à un message de B',
      sql: `INSERT INTO messages (id, thread_id, group_id, author_membership_id, reply_to_message_id, body, created_at)
            VALUES ('msg2', ?, ?, ?, ?, 'Pirate', '${T0}')`,
      params: (g) => [g.a.threadId, g.a.groupId, g.a.membershipId, g.b.messageId],
    },
    {
      nom: 'un fil de A rattaché à un événement de B',
      sql: `INSERT INTO threads (id, group_id, event_id, kind, created_by_membership_id, created_at, updated_at)
            VALUES ('t2', ?, ?, 'event', ?, '${T0}', '${T0}')`,
      params: (g) => [g.a.groupId, g.b.eventId, g.a.membershipId],
    },
  ];

  it.each(refuses)('refusé : $nom', (essai) => {
    expect(() => t.sql.prepare(essai.sql).run(...essai.params(d))).toThrow(/FOREIGN KEY constraint failed/);
  });

  const acceptes: Essai[] = [
    {
      nom: 'un article de A sur une liste de A, créé par un membre de A',
      sql: `INSERT INTO shopping_items (id, shopping_list_id, group_id, label, position, created_by_membership_id, created_at, updated_at)
            VALUES ('i2', ?, ?, 'Légitime', 2, ?, '${T0}', '${T0}')`,
      params: (g) => [g.a.listId, g.a.groupId, g.a.membershipId],
    },
    {
      nom: 'un membre de A qui réclame un article de A',
      sql: `UPDATE shopping_items SET claimed_by_membership_id = ?, claimed_at = '${T0}' WHERE id = ?`,
      params: (g) => [g.a.membershipId, g.a.itemId],
    },
    {
      nom: 'la présence d’un membre de A à un événement de A',
      sql: `INSERT INTO event_attendances (event_id, group_id, membership_id, status, responded_at, updated_at)
            VALUES (?, ?, ?, 'yes', '${T0}', '${T0}')`,
      params: (g) => [g.a.eventId, g.a.groupId, g.a.membershipId],
    },
    {
      nom: 'une dépense de A réglée par un membre de A, avec sa part',
      sql: `INSERT INTO expense_shares (expense_id, group_id, membership_id, share_minor, share_target_minor, created_at, updated_at)
            VALUES (?, ?, ?, 1000, 1000, '${T0}', '${T0}')`,
      params: (g) => [g.a.expenseId, g.a.groupId, g.a.membershipId],
    },
    {
      nom: 'une réponse de A à un message de A',
      sql: `INSERT INTO messages (id, thread_id, group_id, author_membership_id, reply_to_message_id, body, created_at)
            VALUES ('msg2', ?, ?, ?, ?, 'Légitime', '${T0}')`,
      params: (g) => [g.a.threadId, g.a.groupId, g.a.membershipId, g.a.messageId],
    },
  ];

  it.each(acceptes)('accepté : $nom', (essai) => {
    expect(() => t.sql.prepare(essai.sql).run(...essai.params(d))).not.toThrow();
  });
});
