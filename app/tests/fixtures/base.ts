import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Base } from '../../server/db/base.js';
import { fermer, ouvrirEtMigrer } from '../../server/db/migrate.js';
import { creerScope, type GroupScope } from '../../server/db/scope.js';
import { brut, type Sql } from './brut.js';

// Base de fichier temporaire, migrations jouées (architecture §8 : « une base de fichier temporaire »).
// `base` est la connexion OPAQUE de l'application ; `sql` la vraie connexion, pour amorcer et constater.
export type BaseTest = Base;

export interface BaseTemporaire {
  readonly base: BaseTest;
  readonly sql: Sql;
  readonly dossier: string;
  readonly chemin: string;
  readonly nettoyer: () => void;
}

export function baseTemporaire(): BaseTemporaire {
  const dossier = mkdtempSync(join(tmpdir(), 'attroupe-test-'));
  const chemin = join(dossier, 'test.sqlite');
  const base = ouvrirEtMigrer(chemin);
  return {
    base,
    sql: brut(base),
    dossier,
    chemin,
    nettoyer: () => {
      fermer(base);
      rmSync(dossier, { recursive: true, force: true });
    },
  };
}

const T0 = '2026-01-01T00:00:00Z';

export interface Groupe {
  readonly groupId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly eventId: string;
  readonly listId: string;
  readonly itemId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly expenseId: string;
}

export interface DeuxGroupes {
  readonly a: Groupe;
  readonly b: Groupe;
  readonly scopeA: GroupScope;
  readonly scopeB: GroupScope;
}

function peuplerGroupe(sql: Sql, k: string): Groupe {
  const g: Groupe = {
    groupId: `g${k}`,
    userId: `u${k}`,
    membershipId: `m${k}`,
    eventId: `e${k}`,
    listId: `l${k}`,
    itemId: `i${k}`,
    threadId: `t${k}`,
    messageId: `msg${k}`,
    expenseId: `x${k}`,
  };
  const nom = k.toLowerCase();
  sql
    .prepare(
      `INSERT INTO users (id, email, username, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(g.userId, `${nom}@exemple.test`, `user_${nom}`, `Membre ${k}`, T0, T0);
  sql
    .prepare(`INSERT INTO groups (id, name, slug, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(g.groupId, `Groupe ${k}`, `groupe-${nom}`, g.userId, T0, T0);
  sql
    .prepare(
      `INSERT INTO memberships (id, group_id, user_id, role, joined_at, created_at, updated_at) VALUES (?, ?, ?, 'admin', ?, ?, ?)`,
    )
    .run(g.membershipId, g.groupId, g.userId, T0, T0, T0);
  sql
    .prepare(
      `INSERT INTO events (id, group_id, title, starts_at, time_zone, created_by_membership_id, created_at, updated_at)
       VALUES (?, ?, ?, '2026-12-01T20:00:00Z', 'Europe/Paris', ?, ?, ?)`,
    )
    .run(g.eventId, g.groupId, `Soirée ${k}`, g.membershipId, T0, T0);
  sql
    .prepare(
      `INSERT INTO shopping_lists (id, group_id, title, created_by_membership_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(g.listId, g.groupId, `Courses ${k}`, g.membershipId, T0, T0);
  sql
    .prepare(
      `INSERT INTO shopping_items (id, shopping_list_id, group_id, label, position, created_by_membership_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(g.itemId, g.listId, g.groupId, `Article ${k}`, g.membershipId, T0, T0);
  sql
    .prepare(
      `INSERT INTO threads (id, group_id, title, kind, created_by_membership_id, created_at, updated_at) VALUES (?, ?, ?, 'free', ?, ?, ?)`,
    )
    .run(g.threadId, g.groupId, `Fil ${k}`, g.membershipId, T0, T0);
  sql
    .prepare(
      `INSERT INTO messages (id, thread_id, group_id, author_membership_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(g.messageId, g.threadId, g.groupId, g.membershipId, `Message ${k}`, T0);
  sql
    .prepare(
      `INSERT INTO expenses (id, group_id, label, spent_on, payer_membership_id, amount_minor, currency_code,
         target_currency_code, rate_ppm, rate_source, amount_target_minor, split_mode, created_by_membership_id, created_at, updated_at)
       VALUES (?, ?, ?, '2026-12-01', ?, 1000, 'EUR', 'EUR', 1000000, 'identity', 1000, 'equal', ?, ?, ?)`,
    )
    .run(g.expenseId, g.groupId, `Dépense ${k}`, g.membershipId, g.membershipId, T0, T0);
  return g;
}

/** Deux groupes étanches, A (Alice) et B (Bob), avec un exemplaire de chaque ressource dans chacun. */
export function deuxGroupes(base: BaseTest): DeuxGroupes {
  const sql = brut(base);
  const a = peuplerGroupe(sql, 'A');
  const b = peuplerGroupe(sql, 'B');
  const scopeDe = (g: Groupe): GroupScope => creerScope(base, g.userId, g.groupId);
  return { a, b, scopeA: scopeDe(a), scopeB: scopeDe(b) };
}
