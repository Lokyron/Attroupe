import { describe, expect, it, vi } from 'vitest';

// Simule une bibliothèque qui IGNORE `PRAGMA foreign_keys = ON` (relecture à 0) : l'ouverture
// doit échouer, et fermer la connexion, plutôt que de servir sans clés étrangères.
const fermetures = vi.hoisted(() => ({ nombre: 0 }));

vi.mock('better-sqlite3', () => ({
  default: class BaseSansCles {
    pragma(requete: string): unknown {
      if (requete === 'journal_mode = WAL') return 'wal';
      if (requete === 'foreign_keys') return 0;
      return undefined;
    }
    close(): void {
      fermetures.nombre++;
    }
  },
}));

describe('démarrage refusé si foreign_keys est ignoré', () => {
  it('lève ErreurBase et ferme la connexion', async () => {
    // Par migrate.ts : les tests n'ont pas le droit d'importer db/connection (verrou n° 5).
    const { ouvrirEtMigrer } = await import('../../server/db/migrate.js');
    expect(() => ouvrirEtMigrer('inutile.sqlite')).toThrow(expect.objectContaining({ name: 'ErreurBase' }));
    expect(() => ouvrirEtMigrer('inutile.sqlite')).toThrow(/foreign_keys inactif/);
    expect(fermetures.nombre).toBe(2);
  });
});
