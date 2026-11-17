import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DescriptionTable } from '../../server/db/moteur.js';
import { DESCRIPTION_TABLES_COMPTE } from '../../server/db/portee-utilisateur.js';
import { DESCRIPTION_TABLES } from '../../server/db/scope.js';
import { PORTEE_TABLES } from '../../server/db/sql.js';
import { baseTemporaire, type BaseTemporaire } from '../fixtures/base.js';
import { colonnesDe, listerTables } from '../fixtures/schema.js';

// Verrou n° 5 (architecture §4) : le test de schéma. La liste des tables métier est dérivée de
// sqlite_master ; ajouter une table sans décider de son sort fait échouer ce test.

/**
 * Tables sans portée de groupe (modèle de données §2, colonne « Portée groupe » = « — », plus la
 * racine `groups`). Une table qui n'est pas ici est une table métier et DOIT porter `group_id`.
 */
const TABLES_TRANSVERSES = [
  'currencies',
  'email_verification_tokens',
  'groups',
  'password_reset_tokens',
  'push_config',
  'schema_migrations',
  'sessions',
  'user_identities',
  'users',
];

/**
 * Les tables métier qui appartiennent à un compte, pas à un groupe
 * (`personal_events` : modèle §3.6 ; `push_subscriptions` : abonnements Web Push).
 */
const EXCEPTIONS_SANS_GROUPE = ['personal_events', 'push_subscriptions'];

/**
 * Table à `group_id` qu'aucune portée n'ouvre : `email_outbox` n'a ni `group_id` NOT NULL ni colonne
 * de compte, c'est une file interne (accès futur par le seul canal transverse).
 */
const HORS_PORTEE = ['email_outbox'];

describe('schéma : cloisonnement structurel', () => {
  let t: BaseTemporaire;
  beforeAll(() => {
    t = baseTemporaire();
  });
  afterAll(() => t.nettoyer());

  const metier = (): string[] =>
    listerTables(t.sql).filter((n) => !TABLES_TRANSVERSES.includes(n));
  const aGroupe = (table: string): boolean => colonnesDe(t.sql, table).some((c) => c.name === 'group_id');

  it('la base compte les 36 tables du modèle', () => {
    expect(listerTables(t.sql)).toHaveLength(36);
  });

  it('chaque table métier porte group_id, sauf l’exception inscrite en dur', () => {
    const sans = metier().filter((n) => !aGroupe(n));
    expect(sans).toEqual(EXCEPTIONS_SANS_GROUPE);
  });

  it('les tables transverses n’ont pas de group_id (sinon elles seraient métier)', () => {
    expect(TABLES_TRANSVERSES.filter((n) => n !== 'groups').filter(aGroupe)).toEqual([]);
  });

  it('les clés primaires métier sont opaques : TEXT, jamais un compteur', () => {
    const entiers = metier().flatMap((n) =>
      t.sql
        .prepare("SELECT ? AS table_name, name FROM pragma_table_info(?) WHERE pk > 0 AND type <> 'TEXT'")
        .all(n, n),
    );
    expect(entiers).toEqual([]);
  });

  it('la garde du SQL brut (sql.ts) classe exactement les tables métier, avec la bonne colonne de portée', () => {
    const attendues = [...listerTables(t.sql).filter(aGroupe), ...EXCEPTIONS_SANS_GROUPE, 'groups'].sort();
    expect(Object.keys(PORTEE_TABLES).sort()).toEqual(attendues);
    for (const [table, colonne] of Object.entries(PORTEE_TABLES)) {
      if (colonne === null) expect(HORS_PORTEE).toContain(table);
      else expect(colonnesDe(t.sql, table).map((c) => c.name)).toContain(colonne);
    }
  });

  it('chaque table métier est dans exactement une portée (groupe ou compte), sauf la file interne', () => {
    const groupe = Object.keys(DESCRIPTION_TABLES);
    const compte = Object.keys(DESCRIPTION_TABLES_COMPTE);
    expect(groupe.filter((n) => compte.includes(n))).toEqual([]);
    const reelles = [...listerTables(t.sql).filter(aGroupe), ...EXCEPTIONS_SANS_GROUPE].filter((n) => n !== 'groups');
    expect(reelles.filter((n) => !groupe.includes(n) && !compte.includes(n))).toEqual(HORS_PORTEE);
  });

  /** Une description doit dire vrai sur le schéma : drapeaux, clé primaire, colonnes d'auteur. */
  const verifier = (table: string, d: DescriptionTable, portee: 'group_id' | 'user_id'): void => {
    const colonnes = colonnesDe(t.sql, table);
    const noms = colonnes.map((c) => c.name);
    expect(PORTEE_TABLES[table]).toBe(portee);
    expect(colonnes.find((c) => c.name === portee)?.notnull).toBe(1);
    expect(noms.includes('deleted_at')).toBe(d.supprimable);
    expect(noms.includes('created_at')).toBe(d.creeLe);
    expect(noms.includes('updated_at')).toBe(d.majLe);
    const pk = colonnes.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    expect(pk.includes(portee)).toBe(d.pkContientPortee);
    expect(pk.filter((c) => c !== portee).sort()).toEqual([...d.cle].sort());
    expect(d.avecId).toBe(d.cle.length === 1 && d.cle[0] === 'id');
    if (d.auteur !== null) expect(colonnes.find((c) => c.name === d.auteur)?.notnull ?? 0).toBeGreaterThanOrEqual(0);
    if (d.auteur !== null) expect(noms).toContain(d.auteur);
    if (d.auteurFacultatif !== null) expect(colonnes.find((c) => c.name === d.auteurFacultatif)?.notnull).toBe(0);
    if (d.reserveAuMembre !== null) expect(noms).toContain(d.reserveAuMembre);
  };

  describe('le GroupScope décrit les tables telles qu’elles sont en base', () => {
    it.each(Object.keys(DESCRIPTION_TABLES))('%s', (table) => {
      verifier(table, DESCRIPTION_TABLES[table as keyof typeof DESCRIPTION_TABLES], 'group_id');
    });
  });

  describe('la PorteeUtilisateur décrit les tables telles qu’elles sont en base', () => {
    it.each(Object.keys(DESCRIPTION_TABLES_COMPTE))('%s', (table) => {
      verifier(table, DESCRIPTION_TABLES_COMPTE[table as keyof typeof DESCRIPTION_TABLES_COMPTE], 'user_id');
    });
  });
});
