import { z } from 'zod';

export const schemaCreationFil = z.object({
  title: z.string().trim().min(1).max(200),
});

export const schemaRequeteMessages = z.object({
  avant: z.string().trim().min(1).optional(),
  limite: z.coerce.number().int().min(1).max(100).optional(),
});

export const schemaMessage = z.object({
  body: z.string().trim().min(1).max(8000),
});
