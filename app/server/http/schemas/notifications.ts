import { z } from 'zod';
import { GENRES_NOTIFICATION } from '../../domain/notifications.js';

/** Historique des notifications : `filtre` (non lues ou toutes) et taille de page. Paramètres de requête, donc des chaînes. */
export const LIMITE_DEFAUT_NOTIFICATIONS = 50;
export const LIMITE_MAX_NOTIFICATIONS = 200;

/** Curseur de pagination : `<created_at>|<id>` de la dernière notification reçue (instant `AAAA-MM-JJTHH:MM:SSZ`, identifiant sobre). */
const CURSEUR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\|([A-Za-z0-9_-]{1,64})$/;

export const schemaListeNotifications = z.strictObject({
  filtre: z.enum(['non_lues', 'toutes']).default('toutes'),
  limite: z.coerce.number().int().min(1).max(LIMITE_MAX_NOTIFICATIONS).default(LIMITE_DEFAUT_NOTIFICATIONS),
  // Absent : première page. Présent : les notifications STRICTEMENT plus anciennes que ce couple, dans l'ordre (created_at, id) décroissant.
  avant: z
    .string()
    .regex(CURSEUR, 'Curseur invalide.')
    .transform((brut) => {
      const [created_at = '', id = ''] = brut.split('|');
      return { created_at, id };
    })
    .optional(),
});

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
