import { z } from 'zod';

export const schemaLectureNotifications = z
  .strictObject({
    ids: z.array(z.string().min(1)).min(1).max(100).optional(),
    tout: z.literal(true).optional(),
  })
  .refine((v) => v.ids !== undefined || v.tout === true, {
    message: 'Fournir ids ou tout: true.',
  });

export const schemaPreferenceNotification = z.strictObject({
  group_id: z.string().min(1),
  email_mode: z.enum(['immediate', 'daily', 'off']),
});
