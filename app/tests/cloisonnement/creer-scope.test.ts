import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErreurAppartenance, ErreurScope, creerScope } from '../../server/db/scope.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';

// Revue du lot 1 : `creerScope(base, { id: 'mA', group_id: 'gB', …, status: 'active' })` donnait un
// scope qui lisait tout le groupe B, parce que la fabrique croyait l'appartenance qu'on lui passait.
// Elle la lit désormais en base, à partir de (userId, groupId), et refuse sinon.
describe('creerScope lit l’appartenance en base et ne la croit jamais', () => {
  let t: BaseTemporaire;
  let d: DeuxGroupes;
  beforeAll(() => {
    t = baseTemporaire();
    d = deuxGroupes(t.base);
  });
  afterAll(() => t.nettoyer());

  it('produit le scope du groupe dont l’utilisateur est membre actif', () => {
    const scope = creerScope(t.base, d.a.userId, d.a.groupId);
    expect(scope.groupId).toBe(d.a.groupId);
    expect(scope.membershipId).toBe(d.a.membershipId);
    expect(scope.userId).toBe(d.a.userId);
    expect(scope.role).toBe('admin');
  });

  it('refuse un utilisateur qui n’est pas membre du groupe demandé (Alice vers le groupe de Bob)', () => {
    expect(() => creerScope(t.base, d.a.userId, d.b.groupId)).toThrow(ErreurAppartenance);
    expect(() => creerScope(t.base, d.b.userId, d.a.groupId)).toThrow(ErreurAppartenance);
  });

  it('refuse un groupe ou un utilisateur inconnu', () => {
    expect(() => creerScope(t.base, d.a.userId, 'inconnu')).toThrow(ErreurAppartenance);
    expect(() => creerScope(t.base, 'inconnu', d.a.groupId)).toThrow(ErreurAppartenance);
  });

  it('refuse une valeur qui n’est pas un identifiant, y compris un objet d’appartenance fabriqué', () => {
    const forge = { id: d.a.membershipId, group_id: d.b.groupId, user_id: d.a.userId, role: 'admin', status: 'active' };
    expect(() => (creerScope as (...a: unknown[]) => unknown)(t.base, forge)).toThrow(ErreurAppartenance);
    expect(() => (creerScope as (...a: unknown[]) => unknown)(t.base, d.a.userId, { toString: () => d.b.groupId })).toThrow(ErreurAppartenance);
  });

  it('le scope ne lit pas le groupe B quand on tente de le fabriquer avec les identifiants de B et de A', () => {
    // Aucune combinaison croisée ne produit un scope : il n'y a donc rien à lire.
    for (const [u, g] of [[d.a.userId, d.b.groupId], [d.b.userId, d.a.groupId]] as const) {
      expect(() => creerScope(t.base, u, g)).toThrow(ErreurScope);
    }
  });

  it('refuse une appartenance qui a pris fin (quittée ou retirée), puis la retrouve quand elle redevient active', () => {
    t.sql.prepare("UPDATE memberships SET status = 'left', ended_at = '2026-02-01T00:00:00Z' WHERE id = ?").run(d.a.membershipId);
    expect(() => creerScope(t.base, d.a.userId, d.a.groupId)).toThrow(ErreurAppartenance);
    t.sql.prepare("UPDATE memberships SET status = 'removed' WHERE id = ?").run(d.a.membershipId);
    expect(() => creerScope(t.base, d.a.userId, d.a.groupId)).toThrow(ErreurAppartenance);
    t.sql.prepare("UPDATE memberships SET status = 'active', ended_at = NULL WHERE id = ?").run(d.a.membershipId);
    expect(creerScope(t.base, d.a.userId, d.a.groupId).groupId).toBe(d.a.groupId);
  });

  it('un scope déjà fabriqué reste borné à son groupe', () => {
    const scope = creerScope(t.base, d.a.userId, d.a.groupId);
    expect(scope.un('events', d.b.eventId)).toBeUndefined();
    expect(scope.tous('events').length).toBe(1);
  });
});
