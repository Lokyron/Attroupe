import { z } from 'zod';
import { baseDe, type PorteeUtilisateur } from '../portee-utilisateur.js';
import {
  baseDeScope,
  creerScope,
  ErreurAppartenance,
  type Condition,
  type GroupScope,
  type ValeurSql,
  type Valeurs,
} from '../scope.js';
import { preparer } from '../sql.js';
import { mesGroupes } from './transverse.js';

// Agenda personnel (lot 8, modèle §3.6, architecture §6 et §10).
// Deux portées distinctes :
//  - `PorteeUtilisateur` pour la gestion par le compte propriétaire (`personal_events`) ;
//  - `GroupScope` pour les partages (`personal_event_shares`), la visibilité par défaut (`memberships.default_personal_visibility`)
//    et les disponibilités lues par les membres actifs du groupe.
// Garde-fou critique : en visibilité `'busy'`, la requête SQL ne sélectionne JAMAIS `title`, `description` ni `location_name`.

export type VisibilitePartage = 'none' | 'busy' | 'details';
export type VisibiliteActive = 'busy' | 'details';

const ligneCreneauPersonnel = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  location_name: z.string().nullable(),
  all_day: z.union([z.literal(0), z.literal(1)]),
  starts_at: z.string(),
  ends_at: z.string().nullable(),
  time_zone: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type CreneauPersonnel = z.infer<typeof ligneCreneauPersonnel>;

const lignePartage = z.object({
  personal_event_id: z.string(),
  visibility: z.enum(['busy', 'details']),
});

export interface PartageCreneau {
  readonly group_id: string;
  readonly group_name: string;
  readonly visibility: VisibiliteActive;
}

export interface CreneauPersonnelAvecPartages extends CreneauPersonnel {
  readonly partages: PartageCreneau[];
}

export interface ChampsCreneauPersonnel {
  readonly title: string;
  readonly description: string | null;
  readonly location_name: string | null;
  readonly all_day: boolean;
  readonly starts_at: string;
  readonly ends_at: string | null;
  readonly time_zone: string;
}

export type ModificationCreneauPersonnel = {
  readonly [K in keyof ChampsCreneauPersonnel]?: ChampsCreneauPersonnel[K] | undefined;
};

const LIMITE_LISTE = 1000;
const ORDRE_CHRONOLOGIQUE = [{ colonne: 'starts_at' }, { colonne: 'id' }] as const;

function valeursDe(champs: ModificationCreneauPersonnel): Valeurs {
  const { all_day: journee, ...autres } = champs;
  const fournies = Object.entries(autres).filter((entree): entree is [string, string | null] => entree[1] !== undefined);
  return { ...Object.fromEntries(fournies), ...(journee === undefined ? {} : { all_day: journee ? 1 : 0 }) };
}

function partagesParCreneau(portee: PorteeUtilisateur): Map<string, PartageCreneau[]> {
  const base = baseDe(portee);
  const resultat = new Map<string, PartageCreneau[]>();
  for (const g of mesGroupes(portee)) {
    const scope = creerScope(base, portee.userId, g.group_id);
    const lignes = scope
      .tous<unknown>('personal_event_shares', [{ colonne: 'membership_id', operateur: '=', valeur: scope.membershipId }])
      .map((l) => lignePartage.parse(l));
    for (const l of lignes) {
      const liste = resultat.get(l.personal_event_id) ?? [];
      liste.push({ group_id: g.group_id, group_name: g.name, visibility: l.visibility });
      resultat.set(l.personal_event_id, liste);
    }
  }
  return resultat;
}

/** Un créneau personnel de CE compte avec ses partages actifs, ou `undefined` (404 `agenda.introuvable`). */
export function lireCreneauPersonnel(portee: PorteeUtilisateur, id: string): CreneauPersonnelAvecPartages | undefined {
  const ligne = portee.un<unknown>('personal_events', id);
  if (ligne === undefined) return undefined;
  const creneau = ligneCreneauPersonnel.parse(ligne);
  const partages = partagesParCreneau(portee).get(creneau.id) ?? [];
  return { ...creneau, partages };
}

/**
 * Créneaux personnels non supprimés du compte, triés par `starts_at` puis `id`, avec leurs partages dans les groupes
 * où le compte est membre actif. Si `fenetre` est fournie, ne retient que les créneaux qui la touchent.
 */
export function listerCreneauxPersonnels(
  portee: PorteeUtilisateur,
  fenetre?: { readonly du?: string | undefined; readonly au?: string | undefined },
): CreneauPersonnelAvecPartages[] {
  const borneAu =
    fenetre?.au === undefined ? undefined : fenetre.au.length === 10 ? `${fenetre.au}T23:59:59Z` : fenetre.au;
  const fin: Condition[] = borneAu === undefined ? [] : [{ colonne: 'starts_at', operateur: '<=', valeur: borneAu }];
  const debutDansFenetre: Condition[] =
    fenetre?.du === undefined ? [] : [{ colonne: 'starts_at', operateur: '>=', valeur: fenetre.du }];
  const lues = portee.tous<unknown>('personal_events', [...debutDansFenetre, ...fin], {
    ordre: ORDRE_CHRONOLOGIQUE,
    limite: LIMITE_LISTE,
  });
  if (fenetre?.du !== undefined) {
    lues.push(
      ...portee.tous<unknown>(
        'personal_events',
        [
          { colonne: 'starts_at', operateur: '<', valeur: fenetre.du },
          { colonne: 'ends_at', operateur: '>=', valeur: fenetre.du },
        ],
        { ordre: ORDRE_CHRONOLOGIQUE, limite: LIMITE_LISTE },
      ),
    );
  }
  const tousPartages = partagesParCreneau(portee);
  return lues
    .map((ligne) => ligneCreneauPersonnel.parse(ligne))
    .sort((x, y) => (x.starts_at < y.starts_at ? -1 : x.starts_at > y.starts_at ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .map((c) => ({ ...c, partages: tousPartages.get(c.id) ?? [] }));
}

const ligneVisibiliteMembre = z.object({
  default_personal_visibility: z.enum(['none', 'busy', 'details']),
});

/**
 * Insère un créneau personnel et crée automatiquement ses partages initiaux selon `default_personal_visibility`
 * de chaque appartenance active du compte (modèle §3.6).
 */
export function creerCreneauPersonnel(
  portee: PorteeUtilisateur,
  champs: ChampsCreneauPersonnel,
): CreneauPersonnelAvecPartages {
  const base = baseDe(portee);
  const id = portee.transaction(() => {
    const creneauId = portee.inserer('personal_events', valeursDe(champs));
    for (const g of mesGroupes(portee)) {
      const scope = creerScope(base, portee.userId, g.group_id);
      const membre = scope.un<unknown>('memberships', scope.membershipId);
      if (membre === undefined) continue;
      const { default_personal_visibility: visibilite } = ligneVisibiliteMembre.parse(membre);
      if (visibilite === 'busy' || visibilite === 'details') {
        scope.upsert('personal_event_shares', { personal_event_id: creneauId, visibility: visibilite });
      }
    }
    return creneauId;
  });
  const cree = lireCreneauPersonnel(portee, id);
  if (cree === undefined) throw new Error('Créneau personnel introuvable juste après sa création.');
  return cree;
}

/** Met à jour un créneau personnel du compte ; `false` s'il n'existe pas ou n'appartient pas à ce compte. */
export function modifierCreneauPersonnel(
  portee: PorteeUtilisateur,
  id: string,
  champs: ModificationCreneauPersonnel,
): boolean {
  return portee.modifier('personal_events', id, valeursDe(champs));
}

/** Suppression douce (`deleted_at`) d'un créneau personnel du compte ; `false` s'il n'appartient pas à ce compte. */
export function supprimerCreneauPersonnel(portee: PorteeUtilisateur, id: string): boolean {
  return portee.supprimerDoux('personal_events', id);
}

export type ResultatPartages = 'ok' | 'creneau_introuvable' | 'groupe_introuvable';

/**
 * Définit la visibilité d'un créneau personnel groupe par groupe :
 *  - vérifie d'abord que le créneau appartient au compte (`creneau_introuvable` → 404 `agenda.introuvable`) ;
 *  - vérifie ensuite que chaque `group_id` est un groupe actif du compte (`groupe_introuvable` → 404 `groupe.introuvable`) sans rien écrire ;
 *  - applique enfin chaque partage (`'none'` supprime la ligne, `'busy'` ou `'details'` fait un upsert).
 */
export function definirPartagesCreneau(
  portee: PorteeUtilisateur,
  creneauId: string,
  partages: ReadonlyArray<{ readonly group_id: string; readonly visibility: VisibilitePartage }>,
): ResultatPartages {
  const base = baseDe(portee);
  return portee.transaction(() => {
    if (portee.un('personal_events', creneauId) === undefined) return 'creneau_introuvable' as const;
    const operations: Array<{ readonly scope: GroupScope; readonly visibility: VisibilitePartage }> = [];
    for (const p of partages) {
      let scope: GroupScope;
      try {
        scope = creerScope(base, portee.userId, p.group_id);
      } catch (err) {
        if (err instanceof ErreurAppartenance) return 'groupe_introuvable' as const;
        throw err;
      }
      if (scope.groupe() === undefined) return 'groupe_introuvable' as const;
      operations.push({ scope, visibility: p.visibility });
    }
    for (const op of operations) {
      if (op.visibility === 'none') {
        op.scope.supprimer('personal_event_shares', { personal_event_id: creneauId });
      } else {
        op.scope.upsert('personal_event_shares', { personal_event_id: creneauId, visibility: op.visibility });
      }
    }
    return 'ok' as const;
  });
}

// --- Visibilité par défaut et disponibilités dans un groupe (GroupScope) --------------------------------------------

/** Réglage courant `default_personal_visibility` du membre dans ce groupe. */
export function lireMaVisibiliteDefaut(scope: GroupScope): VisibilitePartage {
  const membre = scope.un<unknown>('memberships', scope.membershipId);
  if (membre === undefined) return 'busy';
  return ligneVisibiliteMembre.parse(membre).default_personal_visibility;
}

/** Change `default_personal_visibility` pour l'appartenance courante dans ce groupe. */
export function modifierMaVisibiliteDefaut(scope: GroupScope, visibility: VisibilitePartage): boolean {
  return scope.modifier('memberships', scope.membershipId, { default_personal_visibility: visibility });
}

const ligneDisponibiliteOccupee = z.object({
  id: z.string(),
  membership_id: z.string(),
  display_name: z.string(),
  all_day: z.union([z.literal(0), z.literal(1)]),
  starts_at: z.string(),
  ends_at: z.string().nullable(),
  time_zone: z.string(),
});

const ligneDisponibiliteDetail = ligneDisponibiliteOccupee.extend({
  title: z.string(),
  description: z.string().nullable(),
  location_name: z.string().nullable(),
});

export type DisponibiliteMembre =
  | (z.infer<typeof ligneDisponibiliteOccupee> & {
      readonly visibility: 'busy';
      readonly title: null;
      readonly description: null;
      readonly location_name: null;
    })
  | (z.infer<typeof ligneDisponibiliteDetail> & {
      readonly visibility: 'details';
    });

/**
 * Disponibilités partagées avec ce groupe par ses membres ACTIFS dans la fenêtre `du` .. `au`.
 * Deux requêtes SQL distinctes :
 *  1. Pour `s.visibility = 'busy'`, ni `p.title`, ni `p.description`, ni `p.location_name` ne figurent dans le SELECT :
 *     ces colonnes ne quittent jamais SQLite.
 *  2. Pour `s.visibility = 'details'`, elles sont lues et exposées.
 */
export function listerDisponibilitesGroupe(
  scope: GroupScope,
  fenetre: { readonly du: string; readonly au?: string | undefined },
): DisponibiliteMembre[] {
  const base = baseDeScope(scope);
  const borneFin =
    fenetre.au === undefined ? undefined : fenetre.au.length === 10 ? `${fenetre.au}T23:59:59Z` : fenetre.au;
  const clauseFin = borneFin === undefined ? '' : ' AND p.starts_at <= ?';
  const paramsFin: ValeurSql[] = borneFin === undefined ? [] : [borneFin];

  const tablesEtFiltres =
    'FROM personal_event_shares AS s ' +
    'JOIN personal_events AS p ON s.personal_event_id = p.id ' +
    'JOIN memberships AS m ON m.id = s.membership_id AND m.group_id = s.group_id ' +
    'JOIN users AS u ON u.id = m.user_id ' +
    `WHERE s.group_id = ? AND m.status = ? AND s.visibility = ? AND p.deleted_at IS NULL AND COALESCE(p.ends_at, p.starts_at) >= ?${clauseFin} ` +
    'ORDER BY p.starts_at, s.membership_id, p.id LIMIT ?';

  const occupees: DisponibiliteMembre[] = preparer(
    base,
    `SELECT p.id AS id, s.membership_id AS membership_id, u.display_name AS display_name,
       p.all_day AS all_day, p.starts_at AS starts_at, p.ends_at AS ends_at, p.time_zone AS time_zone
     ${tablesEtFiltres}`,
  )
    .all(scope.groupId, 'active', 'busy', fenetre.du, ...paramsFin, LIMITE_LISTE)
    .map((ligne) => ({
      ...ligneDisponibiliteOccupee.parse(ligne),
      visibility: 'busy' as const,
      title: null,
      description: null,
      location_name: null,
    }));

  const detaillees: DisponibiliteMembre[] = preparer(
    base,
    `SELECT p.id AS id, s.membership_id AS membership_id, u.display_name AS display_name,
       p.all_day AS all_day, p.starts_at AS starts_at, p.ends_at AS ends_at, p.time_zone AS time_zone,
       p.title AS title, p.description AS description, p.location_name AS location_name
     ${tablesEtFiltres}`,
  )
    .all(scope.groupId, 'active', 'details', fenetre.du, ...paramsFin, LIMITE_LISTE)
    .map((ligne) => ({
      ...ligneDisponibiliteDetail.parse(ligne),
      visibility: 'details' as const,
    }));

  return [...occupees, ...detaillees].sort((x, y) =>
    x.starts_at < y.starts_at
      ? -1
      : x.starts_at > y.starts_at
        ? 1
        : x.membership_id < y.membership_id
          ? -1
          : x.membership_id > y.membership_id
            ? 1
            : x.id < y.id
              ? -1
              : x.id > y.id
                ? 1
                : 0,
  );
}
