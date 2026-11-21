// Visibilité de l'agenda personnel (ADR-0017). Module pur : l'ordre `none < busy < details` et la SEULE fonction de combinaison.
// Le réglage de compte (`users.personal_agenda_visibility`) plafonne le partage d'un créneau (`personal_event_shares.visibility`) ;
// aucun chemin n'a le droit d'écrire une seconde fonction de combinaison.

export type VisibilitePartage = 'none' | 'busy' | 'details';

/** Rang de chaque niveau : plus le rang est haut, plus on montre. */
export const RANG_VISIBILITE = { none: 0, busy: 1, details: 2 } as const satisfies Record<VisibilitePartage, number>;

/** La visibilité effective : le minimum du plafond de compte et de la visibilité demandée. */
export function plafonner(plafond: VisibilitePartage, demandee: VisibilitePartage): VisibilitePartage {
  return RANG_VISIBILITE[plafond] <= RANG_VISIBILITE[demandee] ? plafond : demandee;
}
