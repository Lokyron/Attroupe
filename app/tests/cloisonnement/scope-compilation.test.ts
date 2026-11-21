import { describe, expect, it } from 'vitest';
import { ouvrirEtMigrer } from '../../server/db/migrate.js';
import { creerPorteeUtilisateur, type PorteeUtilisateur } from '../../server/db/portee-utilisateur.js';
import { creerScope, DESCRIPTION_TABLES, ErreurScope, type GroupScope, type TableMetier } from '../../server/db/scope.js';
import { baseTemporaire } from '../fixtures/base.js';
import { listerTables } from '../fixtures/schema.js';

// Preuve À LA COMPILATION (architecture §4, verrous 2 et 5) : `npm run typecheck` échoue si l'un de
// ces `@ts-expect-error` cesse d'être une erreur, c'est-à-dire si le type devenait permissif.
// Vitest ne type-check pas : les appels ne s'exécutent donc que dans des fonctions jamais appelées.

/** Ressemble à une fonction de db/queries/ : elle EXIGE le scope en premier argument. */
function lireEvenements(scope: GroupScope): unknown[] {
  return scope.tous('events');
}

type Connexion = ReturnType<typeof ouvrirEtMigrer>;

function usagesInterdits(scope: GroupScope, compte: PorteeUtilisateur, base: Connexion): void {
  // @ts-expect-error -- une requête sans contexte de groupe ne compile pas
  lireEvenements();

  // @ts-expect-error -- un identifiant de groupe n'est pas un scope
  lireEvenements('gB');

  // @ts-expect-error -- un objet fabriqué à la main n'est pas un scope : la marque est inaccessible
  lireEvenements({ groupId: 'gB', membershipId: 'mB', role: 'admin' });

  // @ts-expect-error -- même complet, il manque la marque (Symbol non exporté)
  const faux: GroupScope = {
    groupId: 'gB',
    membershipId: 'mB',
    userId: 'uB',
    role: 'admin',
    groupe: () => undefined,
    tous: () => [],
    un: () => undefined,
    inserer: (() => undefined) as unknown as GroupScope['inserer'],
    modifier: () => false,
    modifierPar: () => false,
    upsert: () => false,
    supprimerDoux: () => false,
    supprimer: () => false,
    transaction: (fn) => fn(),
  };
  lireEvenements(faux);

  // @ts-expect-error -- seules les tables métier sont acceptées
  scope.tous('users');

  // @ts-expect-error -- les tables d'un compte ne sont pas des tables de groupe
  scope.tous('notifications');

  // @ts-expect-error -- idem pour une table inventée
  scope.inserer('table_inconnue', {});

  // @ts-expect-error -- `un` exige une table adressable par id (event_organizers a une clé composite)
  scope.un('event_organizers', 'x');

  // @ts-expect-error -- la suppression douce exige une table à deleted_at (memberships n'en a pas)
  scope.supprimerDoux('memberships', 'x');

  // @ts-expect-error -- la suppression réelle est réservée aux associations (events garde son historique)
  scope.supprimer('events', { id: 'x' });

  // @ts-expect-error -- upsert ne vaut que pour les clés composites (events a un identifiant généré)
  scope.upsert('events', {});

  // @ts-expect-error -- un montant flottant ou un objet n'est pas une valeur SQL
  scope.inserer('expenses', { amount_minor: { minor: 1 } });

  // @ts-expect-error -- plus de clause en chaîne libre : un filtre est une liste { colonne, operateur, valeur }
  scope.tous('events', 'id = 1', []);

  // @ts-expect-error -- l'opérateur vient d'un ensemble fermé
  scope.tous('events', [{ colonne: 'id', operateur: 'OR', valeur: 1 }]);

  // @ts-expect-error -- une condition « = » exige sa valeur
  scope.tous('events', [{ colonne: 'id', operateur: '=' }]);

  // @ts-expect-error -- creerScope ne prend plus une appartenance affirmée, mais (userId, groupId)
  creerScope(base, { id: 'mA', group_id: 'gB', user_id: 'uA', role: 'admin', status: 'active' });

  // @ts-expect-error -- la portée d'un compte ne connaît pas les tables de groupe
  compte.tous('events');

  // La connexion est opaque hors de db/ : aucune méthode, donc aucun moyen de contourner le scope.
  // @ts-expect-error -- pas de prepare()
  base.prepare('SELECT * FROM events');
  // @ts-expect-error -- pas d'exec()
  base.exec('DELETE FROM events');
  // @ts-expect-error -- pas de pragma()
  base.pragma('foreign_keys = OFF');
  // @ts-expect-error -- pas de transaction() brute
  base.transaction(() => 1);
  // @ts-expect-error -- ni de close() : on ferme par migrate.fermer()
  base.close();
}

describe('le type GroupScope ferme les contournements (preuve par typecheck)', () => {
  it('creerScope est la seule fabrique : son résultat est utilisable là où un scope est exigé', () => {
    const t = baseTemporaire();
    try {
      t.sql.prepare("INSERT INTO users (id, email, username, display_name, created_at, updated_at) VALUES ('u', 'u@exemple.test', 'utilisateur', 'U', 'x', 'x')").run();
      t.sql.prepare("INSERT INTO groups (id, name, slug, created_by_user_id, created_at, updated_at) VALUES ('g', 'G', 'g', 'u', 'x', 'x')").run();
      t.sql.prepare("INSERT INTO memberships (id, group_id, user_id, role, joined_at, created_at, updated_at) VALUES ('m', 'g', 'u', 'member', 'x', 'x', 'x')").run();
      expect(lireEvenements(creerScope(t.base, 'u', 'g'))).toEqual([]);
      expect(creerPorteeUtilisateur(t.base, 'u').userId).toBe('u');
    } finally {
      t.nettoyer();
    }
  });

  it('la connexion opaque n’expose aucune méthode à l’exécution non plus', () => {
    const t = baseTemporaire();
    try {
      const base: Record<string, unknown> = { ...t.base };
      expect(Object.getOwnPropertyNames(t.base)).toEqual([]);
      for (const nom of ['prepare', 'exec', 'pragma', 'transaction', 'close']) expect(base[nom]).toBeUndefined();
      expect(Object.isFrozen(t.base)).toBe(true);
    } finally {
      t.nettoyer();
    }
  });

  // Aucune table transverse ou de compte ne doit entrer dans TableMetier : vérifié à la compilation…
  const aucuneTransverse: Extract<
    TableMetier,
    'users' | 'sessions' | 'groups' | 'currencies' | 'schema_migrations' | 'personal_events' | 'notifications' | 'email_outbox'
  > extends never
    ? true
    : false = true;

  it('TableMetier ne contient aucune table transverse ou de compte (compilation)', () => {
    expect(aucuneTransverse).toBe(true);
    expect(typeof usagesInterdits).toBe('function'); // les @ts-expect-error ci-dessus sont gardés par `npm run typecheck`
  });

  // … et à l'exécution, à partir du schéma : toute table sans group_id NOT NULL est refusée par le scope.
  it('le scope refuse à l’exécution toute table de la base qui n’est pas une de ses tables', () => {
    const t = baseTemporaire();
    try {
      t.sql.prepare("INSERT INTO users (id, email, username, display_name, created_at, updated_at) VALUES ('u', 'u@exemple.test', 'utilisateur', 'U', 'x', 'x')").run();
      t.sql.prepare("INSERT INTO groups (id, name, slug, created_by_user_id, created_at, updated_at) VALUES ('g', 'G', 'g', 'u', 'x', 'x')").run();
      t.sql.prepare("INSERT INTO memberships (id, group_id, user_id, role, joined_at, created_at, updated_at) VALUES ('m', 'g', 'u', 'member', 'x', 'x', 'x')").run();
      const scope = creerScope(t.base, 'u', 'g');
      const etrangeres = listerTables(t.sql).filter((n) => !Object.hasOwn(DESCRIPTION_TABLES, n));
      expect(etrangeres.length).toBeGreaterThan(5);
      for (const table of etrangeres) {
        expect(() => scope.tous(table as TableMetier)).toThrow(ErreurScope);
      }
    } finally {
      t.nettoyer();
    }
  });
});
