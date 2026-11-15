import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseTemporaire, type BaseTemporaire } from '../fixtures/base.js';
import { brut } from '../fixtures/brut.js';

// Les PRAGMA de connexion : foreign_keys n'est pas persistant, et sans lui la moitié du
// cloisonnement (clés étrangères composites, verrou n° 4) serait décorative.
describe('PRAGMA de connexion', () => {
  let t: BaseTemporaire;
  beforeAll(() => {
    t = baseTemporaire();
  });
  afterAll(() => t.nettoyer());

  it('foreign_keys est réellement actif', () => {
    expect(t.sql.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('journal_mode est WAL', () => {
    expect(t.sql.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('busy_timeout et synchronous sont posés', () => {
    expect(t.sql.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(t.sql.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
  });

  it('une clé étrangère simple est bien appliquée (preuve que le PRAGMA agit)', () => {
    expect(() =>
      t.sql
        .prepare(
          "INSERT INTO groups (id, name, slug, created_by_user_id, created_at, updated_at) VALUES ('g', 'G', 'g', 'inconnu', 'x', 'x')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('une réouverture pose de nouveau les PRAGMA', async () => {
    const { fermer, ouvrirEtMigrer } = await import('../../server/db/migrate.js');
    const base = ouvrirEtMigrer(t.chemin);
    try {
      expect(brut(base).pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      fermer(base);
    }
  });
});
