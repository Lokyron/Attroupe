import { z } from 'zod';
import { LONGUEUR_MAX } from '../../domain/mot-de-passe.js';
import { FORME_JETON } from '../../domain/jetons.js';

// Entrées de /api/auth et /api/moi. Objets STRICTS : un champ inattendu (ex. `is_instance_admin`) est refusé
// au lieu d'être ignoré, donc aucune affectation de masse possible.

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
/** Le test de force est dans domain/mot-de-passe.ts ; ici on borne seulement la taille avant tout calcul. */
const motDePasse = z.string().min(1).max(LONGUEUR_MAX * 4);
const jeton = z.string().regex(FORME_JETON);

export const schemaInscription = z.strictObject({
  email,
  username: z.string().trim().regex(/^[A-Za-z0-9_.-]{3,32}$/),
  display_name: z.string().trim().min(1).max(60).optional(),
  password: motDePasse,
});

export const schemaConnexion = z.strictObject({ email, password: motDePasse });
export const schemaOubli = z.strictObject({ email });
export const schemaReinitialisation = z.strictObject({ token: jeton, password: motDePasse });
export const schemaChangementMotDePasse = z.strictObject({ current_password: motDePasse, new_password: motDePasse });
export const schemaVerification = z.strictObject({ token: jeton });

export function fuseauValide(valeur: string): boolean {
  try {
    new Intl.DateTimeFormat('fr', { timeZone: valeur });
    return true;
  } catch (erreur) {
    if (erreur instanceof RangeError) return false; // fuseau inconnu
    throw erreur;
  }
}

/** `AAAA-MM-JJ` (date réelle, passée) ou `--MM-JJ` (sans année, 29 février admis). */
function anniversaireValide(valeur: string, aujourdhui: Date): boolean {
  const complet = valeur.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (complet !== null) {
    const [annee, mois, jour] = [Number(complet[1]), Number(complet[2]), Number(complet[3])];
    const date = new Date(Date.UTC(annee, mois - 1, jour));
    return annee >= 1900 && date.getUTCFullYear() === annee && date.getUTCMonth() === mois - 1 && date.getUTCDate() === jour && date.getTime() <= aujourdhui.getTime();
  }
  const sansAnnee = valeur.match(/^--(\d{2})-(\d{2})$/);
  if (sansAnnee === null) return false;
  const [mois, jour] = [Number(sansAnnee[1]), Number(sansAnnee[2])];
  const date = new Date(Date.UTC(2024, mois - 1, jour)); // 2024 est bissextile : le 29 février existe
  return date.getUTCMonth() === mois - 1 && date.getUTCDate() === jour;
}

export function schemaProfil(aujourdhui: Date) {
  return z
    .strictObject({
      display_name: z.string().trim().min(1).max(60),
      time_zone: z.string().min(1).max(64).refine(fuseauValide),
      birthday: z.string().refine((v) => anniversaireValide(v, aujourdhui)).nullable(),
    })
    .partial()
    .refine((v) => Object.keys(v).length > 0);
}
