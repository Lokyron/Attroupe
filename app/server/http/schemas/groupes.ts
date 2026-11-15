import { z } from 'zod';
import { fuseauValide, schemaInscription } from './auth.js';

// Entrées de /api/groupes. Objets STRICTS (comme schemas/auth.ts) : un champ inattendu est refusé, jamais ignoré,
// donc aucune affectation de masse. Aucun identifiant de groupe, d'appartenance ou d'auteur n'entre par un corps :
// le groupe vient de l'URL (prouvé par exigerAppartenance), l'auteur du scope.

/** Nom d'un groupe : 1 à 80 caractères, sans caractère de contrôle (il part dans l'objet d'un e-mail). */
// eslint-disable-next-line no-control-regex -- on refuse précisément les caractères de contrôle
const SANS_CONTROLE = /^[^\u0000-\u001f\u007f]*$/;
const nomGroupe = z.string().trim().min(1).max(80).regex(SANS_CONTROLE);
const devise = z.string().regex(/^[A-Z]{3}$/);
const fuseau = z.string().min(1).max(64).refine(fuseauValide);

export const schemaModificationGroupe = z
  .strictObject({ name: nomGroupe, default_currency_code: devise, time_zone: fuseau })
  .partial()
  .refine((v) => Object.keys(v).length > 0);

export const schemaChangementRole = z.strictObject({ role: z.enum(['admin', 'member']) });

const role = z.enum(['admin', 'member']).default('member');
const mot = z.string().trim().min(1).max(500).nullable().default(null);

/** Invitation : par e-mail OU par nom d'utilisateur exact, jamais les deux, jamais une recherche. */
export const schemaInvitation = z.union([
  z.strictObject({ email: schemaInscription.shape.email, role, message: mot }),
  z.strictObject({ username: schemaInscription.shape.username, role, message: mot }),
]);

export const schemaCreationGroupe = z.strictObject({
  name: nomGroupe,
  default_currency_code: devise.default('EUR'),
  time_zone: fuseau.default('Europe/Paris'),
});
