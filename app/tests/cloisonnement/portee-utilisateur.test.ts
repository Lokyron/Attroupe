import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { creerPorteeUtilisateur, ErreurCompte, type PorteeUtilisateur } from '../../server/db/portee-utilisateur.js';
import { listerDisponibilitesGroupe } from '../../server/db/queries/agenda-personnel.js';
import { creerScope, ErreurScope } from '../../server/db/scope.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';

// Modèle §3.6 et §3.12 : l'agenda personnel, les notifications et les jetons de flux appartiennent à un
// COMPTE. Sans portée dédiée, rien n'empêcherait de lire par identifiant la ligne d'un autre compte.
const T0 = '2026-01-01T00:00:00Z';

describe('PorteeUtilisateur : un compte ne lit ni n’écrit les lignes d’un autre', () => {
  let t: BaseTemporaire;
  let d: DeuxGroupes;
  let alice: PorteeUtilisateur;
  let bob: PorteeUtilisateur;
  beforeEach(() => {
    t = baseTemporaire();
    d = deuxGroupes(t.base);
    alice = creerPorteeUtilisateur(t.base, d.a.userId);
    bob = creerPorteeUtilisateur(t.base, d.b.userId);
  });
  afterEach(() => t.nettoyer());

  it('refuse un compte inconnu, désactivé ou anonymisé', () => {
    expect(() => creerPorteeUtilisateur(t.base, 'inconnu')).toThrow(ErreurCompte);
    t.sql.prepare("UPDATE users SET disabled_at = '2026-02-01T00:00:00Z' WHERE id = ?").run(d.a.userId);
    expect(() => creerPorteeUtilisateur(t.base, d.a.userId)).toThrow(ErreurCompte);
    t.sql.prepare("UPDATE users SET disabled_at = NULL, anonymized_at = '2026-02-01T00:00:00Z' WHERE id = ?").run(d.a.userId);
    expect(() => creerPorteeUtilisateur(t.base, d.a.userId)).toThrow(ErreurCompte);
  });

  it('la portée est figée et ne connaît que les tables de compte', () => {
    expect(Object.isFrozen(alice)).toBe(true);
    expect(() => alice.tous('events' as never)).toThrow(ErreurScope);
    expect(() => alice.tous('email_outbox' as never)).toThrow(ErreurScope);
  });

  describe.each([
    ['notifications', { kind: 'event_created', payload_json: '{}' }],
    ['calendar_feed_tokens', { token_hash: 'hash-a' }],
  ] as const)('%s', (table, valeurs) => {
    it('lecture par identifiant forgé, lecture de liste, modification et suppression : rien d’un autre compte', () => {
      const idA = alice.inserer(table, valeurs);
      const idB = bob.inserer(table, { ...valeurs, ...(table === 'calendar_feed_tokens' ? { token_hash: 'hash-b' } : {}) });
      expect(alice.un<{ user_id: string }>(table, idA)?.user_id).toBe(d.a.userId);
      expect(alice.un(table, idB)).toBeUndefined();
      expect(alice.tous<{ id: string }>(table).map((l) => l.id)).toEqual([idA]);
      expect(alice.tous(table, [{ colonne: 'id', operateur: '=', valeur: idB }])).toEqual([]);
      const marqueur = table === 'notifications' ? { read_at: T0 } : { revoked_at: T0 };
      expect(alice.modifier(table, idB, marqueur)).toBe(false);
      expect(t.sql.prepare(`SELECT count(*) FROM ${table} WHERE id = ? AND ${Object.keys(marqueur)[0] ?? ''} IS NOT NULL`).pluck().get(idB)).toBe(0);
      expect(alice.modifier(table, idA, marqueur)).toBe(true);
    });

    it('le propriétaire ne se forge pas', () => {
      expect(() => alice.inserer(table, { ...valeurs, user_id: d.b.userId })).toThrow(ErreurScope);
      expect(() => alice.modifierPar(table, { id: 'x' }, { user_id: d.b.userId })).toThrow(ErreurScope);
    });
  });

  it('notifications : suppression réelle bornée au compte', () => {
    const idB = bob.inserer('notifications', { kind: 'member_joined', payload_json: '{}' });
    expect(alice.supprimer('notifications' as never, { id: idB })).toBe(false);
    expect(t.sql.prepare('SELECT count(*) FROM notifications WHERE id = ?').pluck().get(idB)).toBe(1);
    expect(bob.supprimer('notifications', { id: idB })).toBe(true);
  });

  it('notification_preferences : upsert par clé (compte, groupe) sans toucher au compte voisin', () => {
    // Depuis la migration 0008, la ligne globale doit poser ses trois colonnes (plus de valeurs par défaut en base).
    alice.inserer('notification_preferences', { group_id: '*', channel_email: 1, digest: 'daily', muted_kinds: '[]' });
    bob.inserer('notification_preferences', { group_id: '*', channel_email: 0, digest: 'off', muted_kinds: '[]' });
    expect(alice.modifierPar('notification_preferences', { group_id: '*' }, { digest: 'instant' })).toBe(true);
    expect(bob.tous<{ digest: string }>('notification_preferences')[0]?.digest).toBe('off');
    expect(alice.tous<{ digest: string }>('notification_preferences')[0]?.digest).toBe('instant');
  });

  describe('agenda personnel (personal_events)', () => {
    const creneau = { title: 'Rendez-vous médecin', starts_at: '2026-12-01T09:00:00Z', ends_at: '2026-12-01T10:00:00Z', time_zone: 'Europe/Paris' };

    it('un autre compte ne lit pas le titre privé, même avec l’identifiant exact', () => {
      const id = alice.inserer('personal_events', creneau);
      expect(bob.un('personal_events', id)).toBeUndefined();
      expect(JSON.stringify(bob.tous('personal_events'))).not.toContain('médecin');
      expect(alice.un<{ title: string }>('personal_events', id)?.title).toBe('Rendez-vous médecin');
      expect(bob.modifier('personal_events', id, { title: 'Piraté' })).toBe(false);
      expect(bob.supprimerDoux('personal_events', id)).toBe(false);
      expect(alice.supprimerDoux('personal_events', id)).toBe(true);
      expect(alice.un('personal_events', id)).toBeUndefined();
    });

    describe('partage vers un groupe et projection « occupé »', () => {
      it('le groupe voit l’intervalle, jamais le titre ; seuls les membres actifs comptent', () => {
        const id = alice.inserer('personal_events', { ...creneau, description: 'Cabinet du Dr X', location_name: 'Rue secrète' });
        d.scopeA.inserer('personal_event_shares', { personal_event_id: id, visibility: 'busy' });
        // Le plafond de compte vaut « busy » par défaut (migration 0009) : la projection est celle de `listerDisponibilitesGroupe`.
        const occupes = listerDisponibilitesGroupe(d.scopeA, { du: '2026-12-01', au: '2026-12-02' });
        expect(occupes).toEqual([
          {
            id,
            membership_id: d.a.membershipId,
            display_name: expect.any(String),
            all_day: 0,
            starts_at: creneau.starts_at,
            ends_at: creneau.ends_at,
            time_zone: 'Europe/Paris',
            visibility: 'busy',
            title: null,
            description: null,
            location_name: null,
          },
        ]);
        const brut = JSON.stringify(occupes);
        for (const secret of ['médecin', 'Cabinet', 'secrète']) expect(brut).not.toContain(secret);
        // Le groupe B ne voit rien du groupe A, et A hors de la plage ne voit rien.
        expect(listerDisponibilitesGroupe(d.scopeB, { du: '2026-12-01', au: '2026-12-02' })).toEqual([]);
        expect(listerDisponibilitesGroupe(d.scopeA, { du: '2026-12-02', au: '2026-12-03' })).toEqual([]);
        expect(listerDisponibilitesGroupe(d.scopeA, { du: '2026-12-01T09:30:00Z', au: '2026-12-01T09:45:00Z' }).length).toBe(1);
        // Créneau supprimé ou membre parti : disparaît de la projection.
        t.sql.prepare("UPDATE memberships SET status = 'left', ended_at = '2026-02-01T00:00:00Z' WHERE id = ?").run(d.a.membershipId);
        expect(listerDisponibilitesGroupe(d.scopeA, { du: '2026-12-01', au: '2026-12-02' })).toEqual([]);
      });

      it('on ne partage que son propre créneau, et seulement vers son propre groupe', () => {
        const idB = bob.inserer('personal_events', creneau);
        expect(() => d.scopeA.inserer('personal_event_shares', { personal_event_id: idB, visibility: 'busy' })).toThrow(/votre agenda/);
        expect(listerDisponibilitesGroupe(d.scopeA, { du: '2026-12-01', au: '2026-12-02' })).toEqual([]);
        // Le scope de B ne peut pas pousser le créneau d'Alice dans le groupe B non plus.
        const idA = alice.inserer('personal_events', creneau);
        expect(() => d.scopeB.inserer('personal_event_shares', { personal_event_id: idA, visibility: 'busy' })).toThrow(ErreurScope);
        expect(listerDisponibilitesGroupe(d.scopeB, { du: '2026-12-01', au: '2026-12-02' })).toEqual([]);
      });

      it('un partage n’appartient qu’à son membre : un autre membre du groupe ne le modifie ni ne le retire', () => {
        t.sql.prepare("INSERT INTO users (id, email, username, display_name, created_at, updated_at) VALUES ('uA2', 'a2@exemple.test', 'user_a2', 'Autre A', ?, ?)").run(T0, T0);
        t.sql.prepare("INSERT INTO memberships (id, group_id, user_id, role, joined_at, created_at, updated_at) VALUES ('mA2', ?, 'uA2', 'member', ?, ?, ?)").run(d.a.groupId, T0, T0, T0);
        const autre = creerScope(t.base, 'uA2', d.a.groupId);
        const id = alice.inserer('personal_events', creneau);
        d.scopeA.inserer('personal_event_shares', { personal_event_id: id, visibility: 'busy' });
        expect(autre.modifierPar('personal_event_shares', { personal_event_id: id }, { visibility: 'details' })).toBe(false);
        expect(autre.supprimer('personal_event_shares', { personal_event_id: id })).toBe(false);
        expect(t.sql.prepare('SELECT visibility FROM personal_event_shares WHERE personal_event_id = ?').pluck().get(id)).toBe('busy');
        expect(d.scopeA.modifierPar('personal_event_shares', { personal_event_id: id }, { visibility: 'details' })).toBe(true);
        expect(d.scopeA.supprimer('personal_event_shares', { personal_event_id: id })).toBe(true);
      });
    });
  });
});
