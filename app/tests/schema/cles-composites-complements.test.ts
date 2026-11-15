import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';

// Couples parent / enfant que les essais du lot 1 ne couvraient pas (revue du lot 1) : invitations,
// votes de sondage, remboursements, tâches, albums, et les deux liens corrigés dans 0001
// (date_polls → events, personal_event_shares → memberships). Chaque refus est la base elle-même.
const T0 = '2026-01-01T00:00:00Z';
const FK = /FOREIGN KEY constraint failed/;

describe('clés étrangères composites : couples complémentaires', () => {
  let t: BaseTemporaire;
  let d: DeuxGroupes;
  beforeEach(() => {
    t = baseTemporaire();
    d = deuxGroupes(t.base);
    // Un sondage et une option dans A ; un album dans A.
    t.sql.prepare(`INSERT INTO date_polls (id, group_id, title, created_by_membership_id, created_at, updated_at) VALUES ('pA', ?, 'Sondage', ?, ?, ?)`).run(d.a.groupId, d.a.membershipId, T0, T0);
    t.sql.prepare(`INSERT INTO date_poll_options (id, date_poll_id, group_id, starts_at, position, created_at) VALUES ('oA', 'pA', ?, '2026-12-01T20:00:00Z', 1, ?)`).run(d.a.groupId, T0);
    t.sql.prepare(`INSERT INTO albums (id, group_id, title, immich_album_id, created_by_membership_id, created_at, updated_at) VALUES ('alA', ?, 'Album', 'imm', ?, ?, ?)`).run(d.a.groupId, d.a.membershipId, T0, T0);
    t.sql.prepare(`INSERT INTO personal_events (id, user_id, title, starts_at, time_zone, created_at, updated_at) VALUES ('peA', ?, 'Privé', '2026-12-01T09:00:00Z', 'Europe/Paris', ?, ?)`).run(d.a.userId, T0, T0);
  });
  afterEach(() => t.nettoyer());

  const invitation = (groupe: string, par: string, resultat: string | null): void => {
    t.sql
      .prepare(`INSERT INTO invitations (id, group_id, invited_by_membership_id, kind, email, token_hash, created_at, expires_at, resulting_membership_id)
                VALUES ('inv', ?, ?, 'email', 'x@exemple.test', 'th', ?, '2027-01-01T00:00:00Z', ?)`)
      .run(groupe, par, T0, resultat);
  };

  it('invitations → memberships : l’invitant d’un autre groupe est refusé', () => {
    expect(() => invitation(d.a.groupId, d.b.membershipId, null)).toThrow(FK);
  });
  it('invitations → memberships : l’appartenance résultante d’un autre groupe est refusée', () => {
    expect(() => invitation(d.a.groupId, d.a.membershipId, d.b.membershipId)).toThrow(FK);
  });
  it('invitations → memberships : les deux colonnes dans le bon groupe sont acceptées', () => {
    expect(() => invitation(d.a.groupId, d.a.membershipId, d.a.membershipId)).not.toThrow();
  });

  const vote = (option: string, groupe: string, membre: string): void => {
    t.sql.prepare(`INSERT INTO date_poll_votes (date_poll_option_id, group_id, membership_id, value, created_at, updated_at) VALUES (?, ?, ?, 'yes', ?, ?)`).run(option, groupe, membre, T0, T0);
  };
  it('date_poll_votes → date_poll_options : le vote du groupe B sur l’option de A est refusé', () => {
    expect(() => vote('oA', d.b.groupId, d.b.membershipId)).toThrow(FK);
  });
  it('date_poll_votes → date_poll_options : le vote d’un membre de B sur l’option de A est refusé', () => {
    expect(() => vote('oA', d.a.groupId, d.b.membershipId)).toThrow(FK);
  });
  it('date_poll_votes : le vote d’un membre de A sur l’option de A est accepté', () => {
    expect(() => vote('oA', d.a.groupId, d.a.membershipId)).not.toThrow();
  });

  it('settlements.to_membership_id : un destinataire d’un autre groupe est refusé', () => {
    const regler = (a: string, vers: string): void => {
      t.sql.prepare(`INSERT INTO settlements (id, group_id, from_membership_id, to_membership_id, amount_minor, currency_code, target_currency_code, rate_ppm, amount_target_minor, settled_on, recorded_by_membership_id, created_at, updated_at)
                     VALUES ('s', ?, ?, ?, 100, 'EUR', 'EUR', 1000000, 100, '2026-12-01', ?, ?, ?)`).run(d.a.groupId, a, vers, d.a.membershipId, T0, T0);
    };
    t.sql.prepare(`INSERT INTO users (id, email, username, display_name, created_at, updated_at) VALUES ('uA2', 'a2@exemple.test', 'user_a2', 'Autre A', ?, ?)`).run(T0, T0);
    t.sql.prepare(`INSERT INTO memberships (id, group_id, user_id, role, joined_at, created_at, updated_at) VALUES ('mA2', ?, 'uA2', 'member', ?, ?, ?)`).run(d.a.groupId, T0, T0, T0);
    expect(() => regler(d.a.membershipId, d.b.membershipId)).toThrow(FK);
    expect(() => regler(d.a.membershipId, 'mA2')).not.toThrow();
  });

  it('event_tasks.assignee_membership_id : un assigné d’un autre groupe est refusé', () => {
    const tache = (assigne: string): void => {
      t.sql.prepare(`INSERT INTO event_tasks (id, group_id, title, assignee_membership_id, position, created_by_membership_id, created_at, updated_at)
                     VALUES ('tk', ?, 'Tâche', ?, 1, ?, ?, ?)`).run(d.a.groupId, assigne, d.a.membershipId, T0, T0);
    };
    expect(() => tache(d.b.membershipId)).toThrow(FK);
    expect(() => tache(d.a.membershipId)).not.toThrow();
  });

  it('album_assets → albums : un média du groupe B rattaché à l’album de A est refusé', () => {
    const media = (groupe: string): void => {
      t.sql.prepare(`INSERT INTO album_assets (album_id, group_id, immich_asset_id, kind, created_at, updated_at) VALUES ('alA', ?, 'a1', 'image', ?, ?)`).run(groupe, T0, T0);
    };
    expect(() => media(d.b.groupId)).toThrow(FK);
    expect(() => media(d.a.groupId)).not.toThrow();
  });

  describe('date_polls.resulting_event_id → events (clé composite, circulaire avec events.source_date_poll_id)', () => {
    it('un sondage de A ne peut pas pointer vers un événement de B', () => {
      expect(() => t.sql.prepare(`UPDATE date_polls SET resulting_event_id = ? WHERE id = 'pA'`).run(d.b.eventId)).toThrow(FK);
    });
    it('un sondage de A pointe vers un événement de A, qui pointe en retour vers le sondage', () => {
      t.sql.prepare(`UPDATE events SET source_date_poll_id = 'pA' WHERE id = ?`).run(d.a.eventId);
      expect(() => t.sql.prepare(`UPDATE date_polls SET resulting_event_id = ?, status = 'converted' WHERE id = 'pA'`).run(d.a.eventId)).not.toThrow();
    });
    it('un événement inexistant est refusé', () => {
      expect(() => t.sql.prepare(`UPDATE date_polls SET resulting_event_id = 'fantome' WHERE id = 'pA'`).run()).toThrow(FK);
    });
  });

  describe('personal_event_shares (membership_id, group_id) → memberships', () => {
    const partager = (membre: string, groupe: string): void => {
      t.sql.prepare(`INSERT INTO personal_event_shares (personal_event_id, membership_id, group_id, visibility, created_at) VALUES ('peA', ?, ?, 'busy', ?)`).run(membre, groupe, T0);
    };
    it('publier un créneau vers un groupe dont on n’est pas membre est refusé', () => {
      expect(() => partager(d.a.membershipId, d.b.groupId)).toThrow(FK);
    });
    it('usurper l’appartenance d’un autre groupe est refusé', () => {
      expect(() => partager(d.b.membershipId, d.a.groupId)).toThrow(FK);
    });
    it('partager vers son propre groupe est accepté', () => {
      expect(() => partager(d.a.membershipId, d.a.groupId)).not.toThrow();
    });
  });
});
