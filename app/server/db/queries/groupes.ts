import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { nouvelIdentifiant } from '../identifiant.js';
import { baseDe, type PorteeUtilisateur } from '../portee-utilisateur.js';
import { baseDeScope, type GroupScope } from '../scope.js';
import { executerEnTransaction, preparer } from '../sql.js';

// Le groupe lui-même (lot 3). Toutes les fonctions prennent un `GroupScope` : le groupe visé est celui du scope,
// jamais un identifiant passé en paramètre. Les écritures sur `groups` (hors du moteur du scope, qui ne couvre que
// les tables enfants) passent par la garde du SQL brut : `groups AS g … WHERE g.id = ?`, lié à `scope.groupId`.

const ligneGroupe = z.object({
  name: z.string(),
  slug: z.string(),
  default_currency_code: z.string(),
  time_zone: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  archived_at: z.string().nullable(),
});

export type Groupe = z.infer<typeof ligneGroupe>;

/** SON groupe (jamais celui d'un autre), sans l'identifiant du créateur. `undefined` si le groupe est supprimé. */
export function lireGroupe(scope: GroupScope): Groupe | undefined {
  const ligne = scope.groupe<unknown>();
  return ligne === undefined ? undefined : ligneGroupe.parse(ligne);
}

export interface ModificationGroupe {
  readonly name?: string | undefined;
  readonly default_currency_code?: string | undefined;
  readonly time_zone?: string | undefined;
}

export type ResultatModificationGroupe = 'modifie' | 'devise_inconnue' | 'introuvable';

/** Renomme, change la devise par défaut ou le fuseau de SON groupe. L'appelant a vérifié le rôle d'administrateur. */
export function modifierGroupe(scope: GroupScope, champs: ModificationGroupe, maintenant: string): ResultatModificationGroupe {
  const base = baseDeScope(scope);
  if (champs.default_currency_code !== undefined) {
    // `currencies` est une table de référence, sans groupe : on refuse proprement au lieu de laisser la clé étrangère lever.
    if (preparer(base, 'SELECT 1 FROM currencies WHERE code = ?').get(champs.default_currency_code) === undefined) return 'devise_inconnue';
  }
  const sets: string[] = [];
  const valeurs: string[] = [];
  if (champs.name !== undefined) {
    sets.push('name = ?');
    valeurs.push(champs.name);
  }
  if (champs.default_currency_code !== undefined) {
    sets.push('default_currency_code = ?');
    valeurs.push(champs.default_currency_code);
  }
  if (champs.time_zone !== undefined) {
    sets.push('time_zone = ?');
    valeurs.push(champs.time_zone);
  }
  if (sets.length === 0) return 'modifie';
  // Les noms de colonnes viennent du code ci-dessus, jamais de la requête ; les valeurs sont liées.
  const modifie = preparer(base, `UPDATE groups AS g SET ${sets.join(', ')}, updated_at = ? WHERE g.id = ? AND g.deleted_at IS NULL`).run(
    ...valeurs,
    maintenant,
    scope.groupId,
  );
  return modifie.changes === 1 ? 'modifie' : 'introuvable';
}

export interface NouveauGroupe {
  readonly name: string;
  readonly default_currency_code: string;
  readonly time_zone: string;
}

export type ResultatCreation = { readonly groupId: string; readonly membershipId: string } | 'devise_inconnue';

/** `Les potes de l'été` → `les-potes-de-l-ete` : ASCII minuscule, tirets ; vide devient `groupe`. */
function racineDeSlug(nom: string): string {
  const racine = nom
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return racine === '' ? 'groupe' : racine;
}

/**
 * Crée un groupe et fait de son créateur (le compte de la portée) son administrateur, en une transaction. Le `slug` porte un
 * suffixe aléatoire : il révélerait sinon l'existence d'un nom (modèle §3.3). C'est le seul point d'entrée de création d'un
 * groupe : `INSERT INTO groups` est l'une des trois exceptions nommées de la garde du SQL brut (db/sql.ts).
 */
export function creerGroupe(portee: PorteeUtilisateur, nouveau: NouveauGroupe, maintenant: string): ResultatCreation {
  const base = baseDe(portee);
  return executerEnTransaction(base, () => {
    if (preparer(base, 'SELECT 1 FROM currencies WHERE code = ?').get(nouveau.default_currency_code) === undefined) return 'devise_inconnue' as const;
    const groupId = nouvelIdentifiant();
    const membershipId = nouvelIdentifiant();
    const slug = `${racineDeSlug(nouveau.name)}-${randomBytes(4).toString('hex')}`;
    preparer(
      base,
      `INSERT INTO groups (id, name, slug, default_currency_code, time_zone, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(groupId, nouveau.name, slug, nouveau.default_currency_code, nouveau.time_zone, portee.userId, maintenant, maintenant);
    preparer(
      base,
      `INSERT INTO memberships (id, group_id, user_id, role, status, joined_at, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', 'active', ?, ?, ?)`,
    ).run(membershipId, groupId, portee.userId, maintenant, maintenant, maintenant);
    return { groupId, membershipId };
  });
}
