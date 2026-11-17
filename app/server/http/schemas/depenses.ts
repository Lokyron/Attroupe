import { z } from 'zod';

// Entrées de /api/groupes/:groupId/depenses, /remboursements et /soldes. Objets STRICTS.

const identifiant = z.string().min(1).max(64);
const dateCivile = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const codeDevise = z.string().regex(/^[A-Z]{3}$/);
const entierPositif = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const entierPositifOuNul = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// Borne large sur le nombre de parts d'une dépense (un groupe n'approche pas cette taille).
const MAX_PARTS = 200;
// `provider` est refusé tant qu'aucun fournisseur de taux n'existe : la valeur serait trompeuse (rate_fetched_at reste null).
const modeRepartition = z.enum(['equal', 'weights', 'exact']);

const schemaPart = z.strictObject({
  membership_id: identifiant,
  weight: entierPositifOuNul.optional(),
  share_minor: entierPositifOuNul.optional(),
});

export const schemaNouvelleDepense = z.strictObject({
  event_id: identifiant.nullable().default(null),
  label: z.string().trim().min(1).max(140),
  spent_on: dateCivile,
  payer_membership_id: identifiant,
  amount_minor: entierPositif,
  currency_code: codeDevise,
  rate_ppm: entierPositif.optional(),
  rate_source: z.enum(['manual']).optional(),
  split_mode: modeRepartition,
  note: z.string().trim().min(1).max(1000).nullable().default(null),
  shares: z.array(schemaPart).min(1).max(MAX_PARTS),
});

export const schemaModificationDepense = z
  .strictObject({
    event_id: identifiant.nullable(),
    label: z.string().trim().min(1).max(140),
    spent_on: dateCivile,
    payer_membership_id: identifiant,
    amount_minor: entierPositif,
    currency_code: codeDevise,
    rate_ppm: entierPositif,
    rate_source: z.enum(['manual']),
    split_mode: modeRepartition,
    note: z.string().trim().min(1).max(1000).nullable(),
    shares: z.array(schemaPart).min(1).max(MAX_PARTS),
  })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined));

export const schemaFiltreDepenses = z.strictObject({
  event_id: identifiant.optional(),
  payer_membership_id: identifiant.optional(),
  du: dateCivile.optional(),
  au: dateCivile.optional(),
});

export const schemaFiltreSoldes = z.strictObject({
  evenement: identifiant.optional(),
});

export const schemaFiltreRemboursements = z.strictObject({
  event_id: identifiant.optional(),
});

export const schemaNouveauRemboursement = z.strictObject({
  event_id: identifiant.nullable().default(null),
  from_membership_id: identifiant,
  to_membership_id: identifiant,
  amount_minor: entierPositif,
  currency_code: codeDevise,
  rate_ppm: entierPositif.optional(),
  settled_on: dateCivile,
  method_note: z.string().trim().min(1).max(200).nullable().default(null),
});
