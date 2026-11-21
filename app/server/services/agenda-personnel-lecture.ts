import type { PorteeUtilisateur } from '../db/portee-utilisateur.js';
import { lireCreneauPersonnel } from '../db/queries/agenda-personnel.js';
import { lireDetailsImportes } from '../db/queries/agenda-externe.js';
import { ErreurHttp } from '../http/erreurs.js';
import type { Journal } from '../http/middleware/journal.js';
import type { CreneauPersonnelPublic } from './agenda-personnel.js';

// Lecture d'UN créneau de l'agenda personnel (page d'événement personnel). Même règle que `listerMonAgenda` : le propriétaire
// retrouve les textes déchiffrés d'un créneau importé ; un blob illisible laisse le créneau sans texte, compté dans le journal.

/** Le créneau de CE compte, ou 404 `agenda.introuvable` (autre compte, identifiant forgé, créneau supprimé). */
export function lireMonCreneau(
  portee: PorteeUtilisateur,
  creneauId: string,
  cleChiffrement: string,
  journal: Journal,
): CreneauPersonnelPublic {
  const creneau = lireCreneauPersonnel(portee, creneauId);
  if (creneau === undefined) throw new ErreurHttp(404, 'agenda.introuvable');
  const complet =
    creneau.calendar_source_id === null
      ? creneau
      : (() => {
          const { details, illisibles } = lireDetailsImportes(portee, cleChiffrement, creneau.id);
          if (illisibles > 0) journal.warn('agenda.details_illisibles', { illisibles });
          const lus = details.get(creneau.id);
          return lus === undefined
            ? creneau
            : { ...creneau, title: lus.titre ?? '', description: lus.description ?? null, location_name: lus.lieu ?? null };
        })();
  return { ...complet, all_day: complet.all_day === 1 };
}
