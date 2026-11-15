import { z } from 'zod';
import { baseDe, type PorteeUtilisateur } from '../portee-utilisateur.js';
import { preparerTransverse } from '../sql.js';

// Lectures qui traversent les groupes par nature. Seul fichier autorisé à appeler
// `preparerTransverse` (ESLint + test) ; chaque texte SQL est figé dans `TEXTES_TRANSVERSES`
// (db/sql.ts) et un test compare cette liste aux appels de ce fichier.
// Toute fonction d'ici prend une `PorteeUtilisateur`, jamais un identifiant nu (une route ne peut pas
// lister les groupes d'un autre compte).

const MES_GROUPES = `SELECT g.id AS group_id, g.name AS name, g.slug AS slug, m.id AS membership_id, m.role AS role
   FROM memberships AS m JOIN groups AS g ON g.id = m.group_id
   WHERE m.user_id = ? AND m.status = 'active' AND g.deleted_at IS NULL
   ORDER BY g.name, g.id`;

const groupeDeLUtilisateur = z.object({
  group_id: z.string(),
  name: z.string(),
  slug: z.string(),
  membership_id: z.string(),
  role: z.enum(['admin', 'member']),
});

export type GroupeDeLUtilisateur = z.infer<typeof groupeDeLUtilisateur>;

/** « Mes groupes » : les groupes où ce compte a une appartenance ACTIVE (groupes supprimés exclus). */
export function mesGroupes(portee: PorteeUtilisateur): GroupeDeLUtilisateur[] {
  return preparerTransverse(baseDe(portee), MES_GROUPES)
    .all(portee.userId)
    .map((ligne) => groupeDeLUtilisateur.parse(ligne));
}
