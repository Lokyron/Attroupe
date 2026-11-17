import { z } from 'zod';
import { champsHoraireInvalides, instantValide } from '../../domain/evenements.js';
import { fuseauValide } from './auth.js';

// Entrées de /api/groupes/:groupId/sondages (lot 7). Objets STRICTS : un champ inattendu est refusé.
// Aucun identifiant de membre ne transite par le corps : l'auteur d'un sondage et le votant viennent de la session.

const texteCourt = (max: number) => z.string().trim().min(1).max(max).nullable();

export const schemaOptionSondage = z
  .strictObject({
    all_day: z.boolean().default(false),
    starts_at: z.string(),
    ends_at: z.string().nullable().default(null),
  })
  .superRefine((option, ctx) => {
    for (const champ of champsHoraireInvalides(option)) {
      ctx.addIssue({ code: 'custom', path: [champ], message: 'horaire invalide' });
    }
  });

export const schemaNouveauSondage = z.strictObject({
  title: z.string().trim().min(1).max(140),
  description: texteCourt(5000).default(null),
  closes_at: z.string().refine(instantValide).nullable().default(null),
  options: z.array(schemaOptionSondage).min(1).max(50),
});

export const schemaModificationSondage = z
  .strictObject({
    title: z.string().trim().min(1).max(140),
    description: texteCourt(5000),
    closes_at: z.string().refine(instantValide).nullable(),
    status: z.enum(['open', 'closed']),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0);

export const schemaVoteSondage = z.strictObject({
  value: z.enum(['yes', 'maybe', 'no']),
});

export const schemaConversionSondage = z.strictObject({
  option_id: z.string().min(1).max(64).optional(),
  time_zone: z.string().min(1).max(64).refine(fuseauValide).optional(),
  location_name: texteCourt(140).optional(),
  description: texteCourt(5000).optional(),
});
