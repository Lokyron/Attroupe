import { z } from 'zod';

// Entrées de /api/groupes/:groupId/listes. Objets STRICTS : un champ inattendu est refusé, jamais ignoré. Les colonnes d'état
// (`claimed_*`, `is_done`, `done_at`, `position`) et `category` (réservée V2) n'y existent pas : les envoyer est une erreur 400, et les
// contraintes du schéma (`(is_done = 1) = (done_at IS NOT NULL)`…) ne sont jamais à portée d'un client. Les seuls identifiants de ressource
// lus dans un corps sont `event_id` et `after_item_id` : vérifiés contre le groupe du scope avant l'écriture. Aucun identifiant d'auteur
// ni de preneur n'entre par un corps : c'est toujours l'appartenance de l'appelant.

const identifiant = z.string().min(1).max(64);
const titre = z.string().trim().min(1).max(120);
const libelle = z.string().trim().min(1).max(120);
const quantite = z.string().trim().min(1).max(40).nullable();

export const schemaNouvelleListe = z.strictObject({ title: titre, event_id: identifiant.nullable().default(null) });

export const schemaRenommageListe = z.strictObject({ title: titre });

/** `?event_id=…` : les listes d'un événement. */
export const schemaFiltreListes = z.strictObject({ event_id: identifiant.optional() });

export const schemaNouvelArticle = z.strictObject({ label: libelle, quantity: quantite.default(null) });

/** Libellé, quantité et/ou place : `after_item_id` = après cet article, `null` = en tête. Au moins un champ. */
export const schemaModificationArticle = z
  .strictObject({ label: libelle, quantity: quantite, after_item_id: identifiant.nullable() })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined));

export const schemaPreneur = z.strictObject({ prend: z.boolean() });

export const schemaFait = z.strictObject({ fait: z.boolean() });
