import { z } from 'zod';
import { champsHoraireInvalides, dateValide, fenetreValide } from '../../domain/evenements.js';
import { fuseauValide } from './auth.js';

// Entrées de l'agenda personnel (/api/moi/agenda et /api/groupes/:groupId/ma-visibilite, lot 8).
// Objets STRICTS : aucun champ inattendu ni colonne réservée V2 (`recurrence_rule`, `deleted_at`) n'est accepté.

const texteCourt = (max: number) => z.string().trim().min(1).max(max).nullable();

const champsCreneauPersonnel = {
  title: z.string().trim().min(1).max(140),
  description: texteCourt(5000),
  location_name: texteCourt(140),
  all_day: z.boolean(),
  starts_at: z.string(),
  ends_at: z.string().nullable(),
  time_zone: z.string().min(1).max(64).refine(fuseauValide),
};

export const schemaNouveauCreneauPersonnel = z
  .strictObject({
    ...champsCreneauPersonnel,
    description: champsCreneauPersonnel.description.default(null),
    location_name: champsCreneauPersonnel.location_name.default(null),
    all_day: champsCreneauPersonnel.all_day.default(false),
    ends_at: champsCreneauPersonnel.ends_at.default(null),
  })
  .superRefine((creneau, ctx) => {
    for (const champ of champsHoraireInvalides(creneau)) {
      ctx.addIssue({ code: 'custom', path: [champ], message: 'horaire invalide' });
    }
  });

export const schemaModificationCreneauPersonnel = z
  .strictObject(champsCreneauPersonnel)
  .partial()
  .refine((v) => Object.keys(v).length > 0);

export const schemaVisibilitePartage = z.enum(['none', 'busy', 'details']);

const schemaUnPartage = z.strictObject({
  group_id: z.string().min(1).max(64),
  visibility: schemaVisibilitePartage,
});

export const schemaPartagesCreneau = z.union([
  z.strictObject({ partages: z.array(schemaUnPartage).max(100) }),
  schemaUnPartage,
]);

export const schemaVisibiliteDefaut = z.strictObject({
  visibility: schemaVisibilitePartage,
});

const jour = z.string().refine(dateValide);

export const schemaFenetreAgendaPersonnel = z
  .strictObject({ du: jour.optional(), au: jour.optional() })
  .superRefine((fenetre, ctx) => {
    if (fenetre.du !== undefined && fenetre.au !== undefined && !fenetreValide(fenetre.du, fenetre.au)) {
      ctx.addIssue({ code: 'custom', path: ['au'], message: 'fenêtre invalide' });
    }
  });
