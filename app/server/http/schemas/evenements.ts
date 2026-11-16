import { z } from 'zod';
import { champsHoraireInvalides, dateValide, fenetreValide } from '../../domain/evenements.js';
import { fuseauValide } from './auth.js';

// Entrées de /api/groupes/:groupId/evenements. Objets STRICTS : un champ inattendu est refusé, jamais ignoré. Les colonnes
// réservées V2 (`recurrence_*`, `occurrence_date`) et `source_date_poll_id` (lot 7), `status` (l'annulation passe par DELETE)
// n'existent pas ici : les envoyer est une erreur 400. Aucun identifiant d'auteur n'entre par un corps ; `host_membership_id`
// est le seul identifiant de ressource, vérifié contre le groupe du scope avant l'écriture.

const texteCourt = (max: number) => z.string().trim().min(1).max(max).nullable();
const devise = z.string().regex(/^[A-Z]{3}$/);

const champsEvenement = {
  title: z.string().trim().min(1).max(140),
  description: texteCourt(5000),
  location_name: texteCourt(140),
  location_address: texteCourt(300),
  location_lat: z.number().min(-90).max(90).nullable(),
  location_lon: z.number().min(-180).max(180).nullable(),
  all_day: z.boolean(),
  starts_at: z.string(),
  ends_at: z.string().nullable(),
  time_zone: z.string().min(1).max(64).refine(fuseauValide),
  arrival_note: texteCourt(500),
  host_membership_id: z.string().min(1).max(64).nullable(),
  currency_code: devise.nullable(),
  capacity: z.number().int().min(1).max(100_000).nullable(),
};

export const schemaNouvelEvenement = z
  .strictObject({
    ...champsEvenement,
    description: champsEvenement.description.default(null),
    location_name: champsEvenement.location_name.default(null),
    location_address: champsEvenement.location_address.default(null),
    location_lat: champsEvenement.location_lat.default(null),
    location_lon: champsEvenement.location_lon.default(null),
    all_day: champsEvenement.all_day.default(false),
    ends_at: champsEvenement.ends_at.default(null),
    arrival_note: champsEvenement.arrival_note.default(null),
    host_membership_id: champsEvenement.host_membership_id.default(null),
    currency_code: champsEvenement.currency_code.default(null),
    capacity: champsEvenement.capacity.default(null),
  })
  .superRefine((evenement, ctx) => {
    for (const champ of champsHoraireInvalides(evenement)) ctx.addIssue({ code: 'custom', path: [champ], message: 'horaire invalide' });
  });

/** Modification : n'importe quel sous-ensemble ; la cohérence de l'horaire se vérifie sur l'événement FUSIONNÉ (services/evenements.ts). */
export const schemaModificationEvenement = z
  .strictObject(champsEvenement)
  .partial()
  .refine((v) => Object.keys(v).length > 0);

export const schemaPresence = z
  .strictObject({
    status: z.enum(['yes', 'maybe', 'no']),
    guests_count: z.number().int().min(0).max(20).default(0),
    comment: z.string().trim().min(1).max(500).nullable().default(null),
  })
  // Des invités n'ont de sens que pour quelqu'un qui vient ou qui hésite.
  .superRefine((presence, ctx) => {
    if (presence.status === 'no' && presence.guests_count > 0) ctx.addIssue({ code: 'custom', path: ['guests_count'], message: 'invités sans présence' });
  });

const jour = z.string().refine(dateValide);

/** `?du=AAAA-MM-JJ&au=AAAA-MM-JJ` : `du` est OBLIGATOIRE (sans lui, une limite muette cacherait les événements à venir) ; `au` facultatif ; 400 jours au plus. */
export const schemaFenetre = z
  .strictObject({ du: jour, au: jour.optional() })
  .superRefine((fenetre, ctx) => {
    if (fenetre.du !== undefined && fenetre.au !== undefined && !fenetreValide(fenetre.du, fenetre.au)) {
      ctx.addIssue({ code: 'custom', path: ['au'], message: 'fenêtre invalide' });
    }
  });
