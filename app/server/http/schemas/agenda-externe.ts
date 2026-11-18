import { z } from 'zod';

// Entrées des sources d'agenda externe (/api/moi/agenda/sources, ADR-0013). Objets STRICTS.
// L'URL n'est volontairement contrainte que par son type : sa forme (schéma, port, identifiants, longueur) est jugée par
// `normaliserUrlSource`, pour que TOUTE cause de refus donne la même réponse `source.url_invalide`.

const libelle = z.string().trim().min(1).max(60);

export const schemaNouvelleSource = z.strictObject({
  url: z.string(),
  label: libelle.optional(),
});

export const schemaModificationSource = z
  .strictObject({
    label: libelle,
    disabled: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0);
