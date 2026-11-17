import { z } from 'zod';
import type { Base } from '../base.js';
import { preparer } from '../sql.js';

const schemaMigration = z.object({
  version: z.string(),
  applied_at: z.string(),
});

export interface DerniereMigration {
  readonly version: string;
  readonly nom: string;
  readonly applied_at: string;
}

/**
 * Lit la dernière migration appliquée dans `schema_migrations`, ou `undefined` si aucune.
 * `schema_migrations` n'est pas une table métier cloisonnée (`PORTEE_TABLES`), elle passe donc `preparer` librement.
 */
export function derniereMigration(base: Base): DerniereMigration | undefined {
  const existe = preparer(base, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (existe === undefined) return undefined;
  const ligne = preparer(base, 'SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 1').get();
  if (ligne === undefined) return undefined;
  const parsed = schemaMigration.parse(ligne);
  const separateur = parsed.version.indexOf('_');
  const numero = separateur === -1 ? parsed.version : parsed.version.slice(0, separateur);
  return {
    version: numero,
    nom: parsed.version,
    applied_at: parsed.applied_at,
  };
}
