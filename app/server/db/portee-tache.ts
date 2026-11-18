import type { Base } from './base.js';
import { creerPorteeUtilisateur, type PorteeUtilisateur } from './portee-utilisateur.js';
import type { SourceAgendaAFaire } from './queries/transverse.js';

// Portée d'une TÂCHE DE FOND (ADR-0013) : l'import des agendas externes traverse les comptes, mais chaque source se traite ensuite avec la
// portée de SON propriétaire, comme une requête de ce compte. `creerPorteeUtilisateur` n'est importable que par les intergiciels
// (verrou d'identité) : cette fonction est l'unique porte de service pour une tâche, et elle ne prend qu'une source désignée par le
// sélecteur transverse `sourcesAFaire` — jamais un identifiant de compte libre.

/**
 * Portée du propriétaire de cette source, relue en base (compte suspendu ou anonymisé : refus).
 * @throws ErreurCompte si le compte n'existe pas ou n'est plus actif.
 */
export function porteeDeLaSource(base: Base, source: SourceAgendaAFaire): PorteeUtilisateur {
  return creerPorteeUtilisateur(base, source.user_id);
}
