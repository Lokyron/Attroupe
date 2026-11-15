import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseTemporaire, type BaseTemporaire } from '../fixtures/base.js';
import { clesEtrangeresNonComposites, colonnesDe, listerTables } from '../fixtures/schema.js';

// Modèle §4.1 : « toute référence vers un parent métier est une clé étrangère composite
// (id, group_id) ». La règle est dérivée de pragma_foreign_key_list : une migration future qui
// l'enfreindrait fait échouer ce test, sans qu'on ait à penser à ajouter un essai à la main.
describe('clés étrangères : la règle est générale, pas une liste d’exemples', () => {
  let t: BaseTemporaire;
  beforeAll(() => {
    t = baseTemporaire();
  });
  afterAll(() => t.nettoyer());

  it('toute clé étrangère vers un parent à group_id est composite et porte group_id', () => {
    expect(clesEtrangeresNonComposites(t.sql)).toEqual([]);
  });

  it('le contrôle voit bien les clés étrangères (il n’est pas vide)', () => {
    const nombre = listerTables(t.sql).reduce(
      (n, table) => n + (t.sql.prepare('SELECT count(DISTINCT id) FROM pragma_foreign_key_list(?)').pluck().get(table) as number),
      0,
    );
    expect(nombre).toBeGreaterThan(60);
    expect(colonnesDe(t.sql, 'memberships').some((c) => c.name === 'group_id')).toBe(true);
  });

  it('le contrôle détecte une clé simple vers un parent à groupe (preuve par une migration qui l’enfreindrait)', () => {
    t.sql.exec(`
      CREATE TABLE faux_parent (id TEXT NOT NULL PRIMARY KEY, group_id TEXT NOT NULL, UNIQUE (id, group_id)) STRICT;
      CREATE TABLE faux_enfant_simple (id TEXT NOT NULL PRIMARY KEY, group_id TEXT NOT NULL, parent_id TEXT REFERENCES faux_parent (id)) STRICT;
      CREATE TABLE faux_enfant_compose (id TEXT NOT NULL PRIMARY KEY, group_id TEXT NOT NULL, parent_id TEXT,
        FOREIGN KEY (parent_id, group_id) REFERENCES faux_parent (id, group_id)) STRICT;
    `);
    try {
      expect(clesEtrangeresNonComposites(t.sql)).toEqual(['faux_enfant_simple(parent_id) → faux_parent']);
    } finally {
      t.sql.exec('DROP TABLE faux_enfant_simple; DROP TABLE faux_enfant_compose; DROP TABLE faux_parent;');
    }
  });
});
