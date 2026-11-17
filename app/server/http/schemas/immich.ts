import { z } from 'zod';

export const schemaConfigImmich = z.strictObject({
  base_url: z.string().trim().min(1).max(500),
  api_key: z.string().trim().min(1).max(500),
});

export const schemaCreationAlbum = z.strictObject({
  title: z.string().trim().min(1).max(200),
  event_id: z.string().trim().min(1).nullable().optional(),
});

export const schemaModificationAlbum = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    cover_immich_asset_id: z.string().trim().min(1).nullable().optional(),
  })
  .refine((v) => v.title !== undefined || v.cover_immich_asset_id !== undefined, {
    message: 'Au moins un champ doit être fourni.',
  });

export const schemaRequetePhotos = z.strictObject({
  sync: z.enum(['true', 'false']).optional(),
});

export const schemaTeleversementJson = z.strictObject({
  files: z
    .array(
      z.strictObject({
        filename: z.string().trim().min(1).max(255),
        mime_type: z
          .string()
          .trim()
          .refine((m) => m.startsWith('image/') || m.startsWith('video/'), {
            message: 'Seules les images et vidéos sont acceptées.',
          }),
        content_base64: z.string().min(1),
      }),
    )
    .min(1)
    .max(20),
});

export const schemaRequeteMedia = z.strictObject({
  exp: z.string().regex(/^\d+$/),
  sig: z.string().regex(/^[0-9a-fA-F]{64}$/),
});
