import type { Sql } from './brut.js';

export interface ColonneSchema {
  readonly name: string;
  readonly notnull: number;
  readonly pk: number;
}

/** Noms des tables de la base (hors tables internes de SQLite), dérivés de `sqlite_master`. */
export function listerTables(sql: Sql): string[] {
  return sql
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .pluck()
    .all() as string[];
}

export function colonnesDe(sql: Sql, table: string): ColonneSchema[] {
  return sql.prepare('SELECT name, "notnull", pk FROM pragma_table_info(?)').all(table) as ColonneSchema[];
}

interface LigneCle {
  readonly id: number;
  readonly seq: number;
  readonly table: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Règle du modèle §4.1, dérivée de `pragma_foreign_key_list` : toute clé étrangère vers un parent qui
 * porte `group_id` doit être COMPOSITE et inclure (group_id → group_id). Renvoie les clés qui
 * l'enfreignent, au format « enfant(colonnes) → parent ».
 */
export function clesEtrangeresNonComposites(sql: Sql): string[] {
  const tables = listerTables(sql);
  const aGroupe = (table: string): boolean => colonnesDe(sql, table).some((c) => c.name === 'group_id');
  const fautives: string[] = [];
  for (const enfant of tables) {
    const lignes = sql.prepare('SELECT id, seq, "table", "from", "to" FROM pragma_foreign_key_list(?)').all(enfant) as LigneCle[];
    const parCle = new Map<number, LigneCle[]>();
    for (const l of lignes) parCle.set(l.id, [...(parCle.get(l.id) ?? []), l]);
    for (const colonnes of parCle.values()) {
      const parent = colonnes[0]?.table ?? '';
      if (!aGroupe(parent)) continue;
      const porteLeGroupe = colonnes.some((c) => c.from === 'group_id' && c.to === 'group_id');
      if (!porteLeGroupe) fautives.push(`${enfant}(${colonnes.map((c) => c.from).join(', ')}) → ${parent}`);
    }
  }
  return fautives.sort();
}
