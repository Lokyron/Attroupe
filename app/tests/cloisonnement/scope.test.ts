import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErreurScope } from '../../server/db/scope.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';

// Règle n° 1 du projet : un scope du groupe A ne lit ni n'écrit jamais une ligne du groupe B,
// même avec l'identifiant exact d'une ligne de B (architecture §4, verrou 2 ; ADR-0002).
interface Ligne {
  readonly id: string;
  readonly group_id: string;
  readonly [colonne: string]: unknown;
}

describe('GroupScope : cloisonnement', () => {
  let t: BaseTemporaire;
  let d: DeuxGroupes;
  beforeAll(() => {
    t = baseTemporaire();
    d = deuxGroupes(t.base);
  });
  afterAll(() => t.nettoyer());

  /** Relit une ligne SANS passer par le scope, pour constater l'état réel de la base. */
  const brut = (table: string, id: string): Ligne | undefined =>
    t.sql.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Ligne | undefined;

  describe('lecture', () => {
    it('tous() ne renvoie que les lignes du groupe', () => {
      const evenements = d.scopeA.tous<Ligne>('events');
      expect(evenements.map((e) => e.id)).toEqual([d.a.eventId]);
      expect(d.scopeB.tous<Ligne>('events').map((e) => e.id)).toEqual([d.b.eventId]);
    });

    it('tous() filtre aussi avec une condition qui vise une ligne de B', () => {
      expect(d.scopeA.tous('events', [{ colonne: 'id', operateur: '=', valeur: d.b.eventId }])).toEqual([]);
      // Même une condition qui couvre tout : elle est combinée par ET, après le filtre de groupe.
      const large = d.scopeA.tous<Ligne>('events', [{ colonne: 'id', operateur: 'IS NOT NULL' }]);
      expect(large.map((e) => e.group_id)).toEqual([d.a.groupId]);
      const dans = d.scopeA.tous<Ligne>('events', [{ colonne: 'id', operateur: 'IN', valeur: [d.a.eventId, d.b.eventId] }]);
      expect(dans.map((e) => e.id)).toEqual([d.a.eventId]);
    });

    it('tous() sait ordonner, limiter et combiner les opérateurs', () => {
      d.scopeA.inserer('shopping_items', { shopping_list_id: d.a.listId, label: 'Pain', position: 2 });
      d.scopeA.inserer('shopping_items', { shopping_list_id: d.a.listId, label: 'Lait', position: 3 });
      const labels = (lignes: Ligne[]): unknown[] => lignes.map((l) => l['label']);
      expect(labels(d.scopeA.tous<Ligne>('shopping_items', [{ colonne: 'position', operateur: '>=', valeur: 2 }], { ordre: [{ colonne: 'position', sens: 'DESC' }] }))).toEqual(['Lait', 'Pain']);
      expect(labels(d.scopeA.tous<Ligne>('shopping_items', [{ colonne: 'label', operateur: 'LIKE', valeur: 'P%' }]))).toEqual(['Pain']);
      expect(labels(d.scopeA.tous<Ligne>('shopping_items', [{ colonne: 'label', operateur: '<>', valeur: 'Pain' }], { ordre: [{ colonne: 'position' }], limite: 1 }))).toEqual(['Article A']);
      expect(d.scopeA.tous('shopping_items', [{ colonne: 'claimed_at', operateur: 'IS NULL' }]).length).toBe(3);
    });

    it('un() renvoie undefined pour l’identifiant exact d’une ligne de B', () => {
      expect(d.scopeA.un('events', d.b.eventId)).toBeUndefined();
      expect(d.scopeA.un('shopping_lists', d.b.listId)).toBeUndefined();
      expect(d.scopeA.un('shopping_items', d.b.itemId)).toBeUndefined();
      expect(d.scopeA.un('messages', d.b.messageId)).toBeUndefined();
      expect(d.scopeA.un('expenses', d.b.expenseId)).toBeUndefined();
      expect(d.scopeA.un('memberships', d.b.membershipId)).toBeUndefined();
    });

    it('un() renvoie la ligne quand elle est bien dans le groupe', () => {
      expect(d.scopeA.un<Ligne>('events', d.a.eventId)?.group_id).toBe(d.a.groupId);
      expect(d.scopeB.un<Ligne>('events', d.b.eventId)?.group_id).toBe(d.b.groupId);
    });
  });

  describe('écriture', () => {
    it('modifier() ne touche pas une ligne de B, même avec son identifiant exact', () => {
      expect(d.scopeA.modifier('events', d.b.eventId, { title: 'Piraté' })).toBe(false);
      expect(d.scopeA.modifierPar('shopping_items', { id: d.b.itemId }, { label: 'Piraté' })).toBe(false);
      expect(d.scopeA.modifier('shopping_items', d.b.itemId, { label: 'Piraté' })).toBe(false);
      expect(brut('events', d.b.eventId)?.['title']).toBe('Soirée B');
      expect(brut('shopping_items', d.b.itemId)?.['label']).toBe('Article B');
    });

    it('modifier() met à jour une ligne du groupe et pose updated_at', () => {
      expect(d.scopeA.modifier('events', d.a.eventId, { title: 'Renommée' })).toBe(true);
      const ligne = brut('events', d.a.eventId);
      expect(ligne?.['title']).toBe('Renommée');
      expect(ligne?.['updated_at']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(ligne?.['updated_at']).not.toBe('2026-01-01T00:00:00Z');
    });

    it('supprimerDoux() ne touche pas une ligne de B', () => {
      expect(d.scopeA.supprimerDoux('threads', d.b.threadId)).toBe(false);
      expect(brut('threads', d.b.threadId)?.['deleted_at']).toBeNull();
    });

    it('inserer() pose le groupe du scope : un groupe forgé dans les valeurs est refusé', () => {
      expect(() => d.scopeA.inserer('shopping_lists', { title: 'Pirate', group_id: d.b.groupId })).toThrow(ErreurScope);
      expect(t.sql.prepare("SELECT count(*) FROM shopping_lists WHERE title = 'Pirate'").pluck().get()).toBe(0);
    });

    it('inserer() pose l’auteur du scope : un auteur forgé est refusé', () => {
      expect(() => d.scopeA.inserer('shopping_lists', { title: 'Pirate', created_by_membership_id: d.b.membershipId })).toThrow(ErreurScope);
    });

    it('inserer() génère l’identifiant : un identifiant fourni est refusé', () => {
      expect(() => d.scopeA.inserer('shopping_lists', { id: 'lPirate', title: 'Pirate' })).toThrow(ErreurScope);
    });

    it('inserer() écrit dans le groupe du scope, avec son auteur, un UUID v7 et des instants UTC', () => {
      const id = d.scopeA.inserer('shopping_lists', { title: 'Nouvelle' });
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const ligne = brut('shopping_lists', id);
      expect(ligne?.['group_id']).toBe(d.a.groupId);
      expect(ligne?.['created_by_membership_id']).toBe(d.a.membershipId);
      expect(ligne?.['created_at']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(d.scopeB.un('shopping_lists', id)).toBeUndefined();
    });

    it('inserer() ne greffe pas sur un parent de B : la base refuse', () => {
      expect(() =>
        d.scopeA.inserer('shopping_items', { shopping_list_id: d.b.listId, label: 'Pirate', position: 9 }),
      ).toThrow(/FOREIGN KEY/);
      expect(t.sql.prepare("SELECT count(*) FROM shopping_items WHERE label = 'Pirate'").pluck().get()).toBe(0);
    });
  });

  describe('suppression douce', () => {
    it('masque la ligne à toutes les lectures du groupe, sans l’effacer', () => {
      const id = d.scopeA.inserer('events', {
        title: 'À supprimer',
        starts_at: '2026-12-02T20:00:00Z',
        time_zone: 'Europe/Paris',
      });
      expect(d.scopeA.un('events', id)).toBeDefined();
      expect(d.scopeA.supprimerDoux('events', id)).toBe(true);
      expect(d.scopeA.un('events', id)).toBeUndefined();
      expect(d.scopeA.tous<Ligne>('events').map((e) => e.id)).not.toContain(id);
      expect(brut('events', id)?.['deleted_at']).toMatch(/Z$/);
      expect(d.scopeA.supprimerDoux('events', id)).toBe(false);
      expect(d.scopeA.modifier('events', id, { title: 'Ressuscitée' })).toBe(false);
    });
  });

  describe('usage incorrect', () => {
    it('colonne, opérateur ou valeur hors liste : refusés', () => {
      const c = (condition: unknown): unknown[] => d.scopeA.tous('events', [condition as never]);
      expect(() => c({ colonne: 'inconnue', operateur: '=', valeur: 1 })).toThrow(ErreurScope);
      expect(() => c({ colonne: 'group_id', operateur: '=', valeur: d.b.groupId })).toThrow(ErreurScope);
      expect(() => c({ colonne: 'title', operateur: 'OR', valeur: 1 })).toThrow(ErreurScope);
      expect(() => c({ colonne: 'title', operateur: '=', valeur: { x: 1 } })).toThrow(ErreurScope);
      expect(() => c({ colonne: 'title', operateur: 'IN', valeur: [] })).toThrow(ErreurScope);
      expect(() => c('id = 1')).toThrow(ErreurScope);
    });

    it('nom de colonne, ordre et limite suspects refusés', () => {
      expect(() => d.scopeA.modifier('events', d.a.eventId, { 'title = 1, group_id': 'x' })).toThrow(ErreurScope);
      expect(() => d.scopeA.tous('events', [], { ordre: [{ colonne: 'id; DROP TABLE events' }] })).toThrow(ErreurScope);
      expect(() => d.scopeA.tous('events', [], { limite: 0 })).toThrow(ErreurScope);
      expect(() => d.scopeA.modifier('events', d.a.eventId, {})).toThrow(ErreurScope);
    });

    it('une table hors liste est refusée à l’exécution aussi (appelant JavaScript)', () => {
      expect(() => d.scopeA.tous('users' as never)).toThrow(ErreurScope);
      expect(() => d.scopeA.tous('__proto__' as never)).toThrow(ErreurScope);
    });

    it('modifier() refuse de déplacer une ligne vers un autre groupe', () => {
      expect(() => d.scopeA.modifier('events', d.a.eventId, { group_id: d.b.groupId })).toThrow(ErreurScope);
    });

    it('le scope est figé', () => {
      expect(Object.isFrozen(d.scopeA)).toBe(true);
    });
  });
});
