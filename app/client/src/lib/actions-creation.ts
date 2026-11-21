import { groupeCible } from '../pages/tableau/selecteurs.js';

// Actions de création qui exigent un groupe cible : partagées par les raccourcis du tableau de bord et par la feuille « Créer »
// du bandeau du bas. La règle de cible (`groupeCible`, dans `pages/tableau/selecteurs`) n'existe qu'une fois.

export type ActionCreation = 'evenement' | 'depense' | 'liste';

export const ACTIONS_CREATION: readonly ActionCreation[] = ['evenement', 'depense', 'liste'];

const SUFFIXE_ROUTE: Readonly<Record<ActionCreation, string>> = {
  evenement: 'evenement-nouveau',
  depense: 'depenses',
  liste: 'listes',
};

/** Lien de l'action dans un groupe (la création d'une dépense ou d'une liste se fait depuis la page du groupe). */
export function lienActionCreation(action: ActionCreation, groupId: string): string {
  return `#/groupe/${encodeURIComponent(groupId)}/${SUFFIXE_ROUTE[action]}`;
}

/** Pourquoi une action est indisponible : aucun groupe du tout, ou plusieurs groupes sans choix. */
export type RaisonBlocage = 'aucun_groupe' | 'choisir_groupe';

export interface EtatActionCreation {
  readonly action: ActionCreation;
  /** `null` : l'action est désactivée, voir `raison`. */
  readonly lien: string | null;
  readonly raison: RaisonBlocage | null;
  /** Groupe visé quand l'action est possible. */
  readonly groupe: { readonly group_id: string; readonly name: string } | null;
}

/** État des trois actions pour des groupes et un choix de groupe (`''` : aucun choix). */
export function etatActionsCreation(
  groupes: ReadonlyArray<{ readonly group_id: string; readonly name: string }>,
  choix: string,
): EtatActionCreation[] {
  const cible = groupeCible(groupes, choix);
  return ACTIONS_CREATION.map((action) =>
    cible === null
      ? { action, lien: null, raison: groupes.length === 0 ? 'aucun_groupe' : 'choisir_groupe', groupe: null }
      : { action, lien: lienActionCreation(action, cible.group_id), raison: null, groupe: cible },
  );
}
