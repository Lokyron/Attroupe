import { z } from 'zod';
import { instantValide } from '../../domain/evenements.js';

// Entrées de /api/groupes/:groupId/taches. Objets STRICTS. `done_at` n'existe pas ici : il se déduit de `status` (CHECK du schéma
// `(status = 'done') = (done_at IS NOT NULL)`, tenu par db/queries/taches.ts). Les seuls identifiants de ressource lus dans un corps sont
// `event_id` et `assignee_membership_id` : vérifiés contre le groupe du scope avant l'écriture.

const identifiant = z.string().min(1).max(64);
const titre = z.string().trim().min(1).max(140);
const details = z.string().trim().min(1).max(2000).nullable();
const echeance = z.string().refine(instantValide).nullable();
const statut = z.enum(['todo', 'doing', 'done', 'dropped']);

export const schemaNouvelleTache = z.strictObject({
  title: titre,
  details: details.default(null),
  event_id: identifiant.nullable().default(null),
  due_at: echeance.default(null),
});

export const schemaModificationTache = z
  .strictObject({ title: titre, details, event_id: identifiant.nullable(), due_at: echeance, status: statut })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined));

/** `?event_id=…` : les tâches d'un événement. */
export const schemaFiltreTaches = z.strictObject({ event_id: identifiant.optional() });

/** `assignee_membership_id` : mon appartenance (« je m'en occupe »), celle d'un autre membre actif (« désigner »), ou `null` (libérer). */
export const schemaAssignation = z.strictObject({ assignee_membership_id: identifiant.nullable() });
