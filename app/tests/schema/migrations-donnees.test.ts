import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOSSIER_MIGRATIONS, fermer, ouvrirEtMigrer } from '../../server/db/migrate.js';
import { brut } from '../fixtures/brut.js';

// Les migrations qui TOUCHENT des données (0006 reconstruit `notifications`, 0007 réécrit des titres, 0008 reconstruit `notification_preferences`) : on joue le schéma jusqu'à la
// veille, on y insère des lignes comme une base en production, puis on joue la migration et on relit. Les tests de `migrations.test.ts`
// ne couvrent que le mécanisme (versions, checksums, sauvegarde), pas ce que la migration fait aux lignes existantes.
describe('migrations qui réécrivent des données', () => {
  let dossier: string;
  let migrations: string;
  let chemin: string;

  /** Copie dans le dossier de travail les migrations dont le numéro vérifie `garder`. */
  const copier = (garder: (numero: number) => boolean): void => {
    for (const f of readdirSync(DOSSIER_MIGRATIONS)) {
      if (garder(Number.parseInt(f.slice(0, 4), 10))) copyFileSync(join(DOSSIER_MIGRATIONS, f), join(migrations, f));
    }
  };

  beforeEach(() => {
    dossier = mkdtempSync(join(tmpdir(), 'attroupe-migr-donnees-'));
    migrations = join(dossier, 'migrations');
    mkdirSync(migrations);
    chemin = join(dossier, 'base.sqlite');
  });
  afterEach(() => rmSync(dossier, { recursive: true, force: true }));

  const T = '2026-10-01T10:00:00Z';

  it('0006 : toutes les notifications d’avant sont conservées, avec leurs colonnes, et les règlements deviennent acceptés', () => {
    copier((n) => n <= 5);
    const avant = ouvrirEtMigrer(chemin, { dossierMigrations: migrations });
    const sqlAvant = brut(avant);
    sqlAvant.prepare("INSERT INTO users (id, email, username, display_name, created_at, updated_at) VALUES ('u1', 'u1@exemple.test', 'user1', 'Un', ?, ?)").run(T, T);
    sqlAvant.prepare("INSERT INTO groups (id, name, slug, created_by_user_id, created_at, updated_at) VALUES ('g1', 'Groupe', 'groupe-1', 'u1', ?, ?)").run(T, T);
    const inserer = sqlAvant.prepare(
      'INSERT INTO notifications (id, user_id, group_id, kind, subject_type, subject_id, payload_json, created_at, read_at, email_queued_at, email_sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const lignes = [
      ['n1', 'u1', 'g1', 'message_posted', 'message', 'm1', '{"thread_title":"Idées"}', '2026-10-01T10:00:00Z', null, '2026-10-01T10:00:00Z', '2026-10-01T10:01:00Z'],
      ['n2', 'u1', 'g1', 'expense_added', 'expense', 'e1', '{}', '2026-10-02T10:00:00Z', '2026-10-02T11:00:00Z', null, null],
      ['n3', 'u1', null, 'invitation_received', 'invitation', 'i1', '{"a":"b"}', '2026-10-03T10:00:00Z', null, null, null],
      ['n4', 'u1', 'g1', 'accounts_closed', null, null, '{}', '2026-10-04T10:00:00Z', null, null, null],
    ] as const;
    for (const l of lignes) inserer.run(...l);
    const lues = (sql: ReturnType<typeof brut>): unknown[] =>
      sql
        .prepare('SELECT id, user_id, group_id, kind, subject_type, subject_id, payload_json, created_at, read_at, email_queued_at, email_sent_at FROM notifications ORDER BY id')
        .all();
    const attendu = lues(sqlAvant);
    expect(attendu).toHaveLength(4);
    // Avant 0006, un règlement n'est pas un genre admis.
    expect(() => inserer.run('x', 'u1', 'g1', 'settlement_created', 'settlement', 's1', '{}', T, null, null, null)).toThrow(/CHECK/);
    fermer(avant);

    copier(() => true);
    const apres = ouvrirEtMigrer(chemin, { dossierMigrations: migrations });
    const sqlApres = brut(apres);
    try {
      expect(lues(sqlApres)).toEqual(attendu);
      expect(attendu[0]).toMatchObject({ id: 'n1', payload_json: '{"thread_title":"Idées"}', read_at: null, email_sent_at: '2026-10-01T10:01:00Z' });
      expect(attendu[1]).toMatchObject({ id: 'n2', read_at: '2026-10-02T11:00:00Z' });
      sqlApres
        .prepare('INSERT INTO notifications (id, user_id, group_id, kind, subject_type, subject_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('n5', 'u1', 'g1', 'settlement_created', 'settlement', 's1', '{}', T);
      expect(sqlApres.prepare('SELECT count(*) FROM notifications').pluck().get()).toBe(5);
      // L'index de lecture des notifications d'un compte est recréé.
      expect(sqlApres.prepare("SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_notifications_user'").pluck().get()).toBe(1);
      expect(sqlApres.pragma('foreign_key_check')).toEqual([]);
    } finally {
      fermer(apres);
    }
  });

  it('0007 : le type de liste sort du titre (« Tâches : Courses » devient kind=taches, titre « Courses »)', () => {
    copier((n) => n <= 6);
    const avant = ouvrirEtMigrer(chemin, { dossierMigrations: migrations });
    const sqlAvant = brut(avant);
    sqlAvant.prepare("INSERT INTO users (id, email, username, display_name, created_at, updated_at) VALUES ('u1', 'u1@exemple.test', 'user1', 'Un', ?, ?)").run(T, T);
    sqlAvant.prepare("INSERT INTO groups (id, name, slug, created_by_user_id, created_at, updated_at) VALUES ('g1', 'Groupe', 'groupe-1', 'u1', ?, ?)").run(T, T);
    sqlAvant
      .prepare("INSERT INTO memberships (id, group_id, user_id, role, status, joined_at, created_at, updated_at) VALUES ('m1', 'g1', 'u1', 'admin', 'active', ?, ?, ?)")
      .run(T, T, T);
    const inserer = sqlAvant.prepare('INSERT INTO shopping_lists (id, group_id, title, created_by_membership_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [id, titre] of [
      ['l-taches', 'Tâches : Courses'],
      ['l-affaires', 'Affaires : Valise'],
      ['l-courses', 'Courses du samedi'],
      ['l-seul', 'Tâches : '], // préfixe seul : titre conservé tel quel (un titre ne peut pas être vide)
      ['l-milieu', 'Mes Tâches : à faire'], // le préfixe ne compte qu'en tête de titre
    ] as const) {
      inserer.run(id, 'g1', titre, 'm1', T, T);
    }
    fermer(avant);

    copier(() => true);
    const apres = ouvrirEtMigrer(chemin, { dossierMigrations: migrations });
    const sqlApres = brut(apres);
    try {
      const lire = (id: string): unknown => sqlApres.prepare('SELECT kind, title FROM shopping_lists WHERE id = ?').get(id);
      expect(lire('l-taches')).toEqual({ kind: 'taches', title: 'Courses' });
      expect(lire('l-affaires')).toEqual({ kind: 'affaires', title: 'Valise' });
      expect(lire('l-courses')).toEqual({ kind: 'courses', title: 'Courses du samedi' });
      expect(lire('l-seul')).toEqual({ kind: 'courses', title: 'Tâches : ' });
      expect(lire('l-milieu')).toEqual({ kind: 'courses', title: 'Mes Tâches : à faire' });
    } finally {
      fermer(apres);
    }
  });

  it('0008 : les préférences d’avant gardent toutes leurs valeurs (pas de NULL rétroactif) ; la ligne d’un groupe peut ensuite hériter, pas la globale', () => {
    copier((n) => n <= 7);
    const avant = ouvrirEtMigrer(chemin, { dossierMigrations: migrations });
    const sqlAvant = brut(avant);
    for (const u of ['u1', 'u2']) {
      sqlAvant.prepare('INSERT INTO users (id, email, username, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(u, `${u}@exemple.test`, `user-${u}`, u, T, T);
    }
    const inserer = sqlAvant.prepare('INSERT INTO notification_preferences (user_id, group_id, channel_email, digest, muted_kinds, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const lignes = [
      ['u1', '*', 1, 'daily', '["message_posted"]', T, '2026-10-02T10:00:00Z'],
      ['u1', 'g1', 0, 'off', '[]', T, '2026-10-03T10:00:00Z'],
      ['u2', 'g1', 1, 'instant', '["event_created","expense_added"]', '2026-10-04T10:00:00Z', '2026-10-05T10:00:00Z'],
    ] as const;
    for (const l of lignes) inserer.run(...l);
    const lues = (sql: ReturnType<typeof brut>): unknown[] =>
      sql.prepare('SELECT user_id, group_id, channel_email, digest, muted_kinds, created_at, updated_at FROM notification_preferences ORDER BY user_id, group_id').all();
    const attendu = lues(sqlAvant);
    expect(attendu).toHaveLength(3);
    // Avant 0008, une ligne de groupe ne peut pas hériter.
    expect(() => inserer.run('u2', 'g2', null, null, null, T, T)).toThrow(/NOT NULL/);
    fermer(avant);

    copier(() => true);
    const apres = ouvrirEtMigrer(chemin, { dossierMigrations: migrations });
    const sqlApres = brut(apres);
    try {
      expect(lues(sqlApres)).toEqual(attendu);
      const insererApres = sqlApres.prepare('INSERT INTO notification_preferences (user_id, group_id, channel_email, digest, muted_kinds, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      // Un groupe peut tout laisser à NULL (hérite), ou ne poser que les genres.
      insererApres.run('u2', 'g2', null, null, null, T, T);
      insererApres.run('u2', 'g3', null, null, '["member_joined"]', T, T);
      // Mais pas le mode e-mail à moitié, ni la ligne globale, qui n'hérite de rien.
      expect(() => insererApres.run('u2', 'g4', 1, null, null, T, T)).toThrow(/CHECK/);
      expect(() => insererApres.run('u2', '*', null, null, null, T, T)).toThrow(/CHECK/);
      expect(() => insererApres.run('u2', '*', 1, 'instant', null, T, T)).toThrow(/CHECK/);
      expect(sqlApres.pragma('foreign_key_check')).toEqual([]);
    } finally {
      fermer(apres);
    }
  });
});
