import { z } from 'zod';
import { GENRES_NOTIFICATION } from '../../domain/notifications.js';

export const schemaLectureNotifications = z
  .strictObject({
    ids: z.array(z.string().min(1)).min(1).max(100).optional(),
    tout: z.literal(true).optional(),
  })
  .refine((v) => v.ids !== undefined || v.tout === true, {
    message: 'Fournir ids ou tout: true.',
  });

// `email_mode` et `muted_kinds` sont indépendants (au moins l'un des deux) ; les genres sont une liste fermée, sans doublon.
export const schemaPreferenceNotification = z
  .strictObject({
    group_id: z.string().min(1),
    email_mode: z.enum(['immediate', 'daily', 'off']).optional(),
    muted_kinds: z
      .array(z.enum(GENRES_NOTIFICATION))
      .max(GENRES_NOTIFICATION.length)
      .refine((genres) => new Set(genres).size === genres.length, { message: 'Genres en double.' })
      .optional(),
  })
  .refine((v) => v.email_mode !== undefined || v.muted_kinds !== undefined, {
    message: 'Fournir email_mode ou muted_kinds.',
  });
