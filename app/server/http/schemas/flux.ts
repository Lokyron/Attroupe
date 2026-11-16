import { z } from 'zod';

// Entrée de POST /api/moi/flux-ical. Objet STRICT : un champ inattendu est refusé. `group_id` est un identifiant de groupe que
// la route ne croit pas : elle exige l'appartenance ACTIVE (404 sinon, jamais 403).

// eslint-disable-next-line no-control-regex -- on refuse précisément les caractères de contrôle
const SANS_CONTROLE = /^[^\u0000-\u001f\u007f]*$/;

export const schemaCreationFlux = z.strictObject({
  label: z.string().trim().min(1).max(80).regex(SANS_CONTROLE).nullable().default(null),
  group_id: z.string().min(1).max(64).nullable().default(null),
  include_personal: z.boolean().default(false),
  include_declined: z.boolean().default(true),
});
