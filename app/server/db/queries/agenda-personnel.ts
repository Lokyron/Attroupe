import { z } from 'zod';
import { baseDe, type PorteeUtilisateur } from '../portee-utilisateur.js';
import { baseDeScope, creerScope, type Condition, type GroupScope, type ValeurSql, type Valeurs } from '../scope.js';
import { preparer } from '../sql.js';
import { plafonner, type VisibilitePartage } from '../../domain/visibilite-personnelle.js';
import { mesGroupes } from './transverse.js';

// Agenda personnel (lot 8, modèle §3.6, architecture §6 et §10).
// Deux portées distinctes :
//  - `PorteeUtilisateur` pour la gestion par le compte propriétaire (`personal_events`) et son réglage de visibilité ;
//  - `GroupScope` pour les partages (`personal_event_shares`) et les disponibilités lues par les membres actifs du groupe.
// La visibilité se règle UNE fois par compte (`users.personal_agenda_visibility`, ADR-0017) : c'est un plafond, appliqué à la lecture
// (minimum avec la visibilité du partage, `plafonner`). `memberships.default_personal_visibility` est dormante : rien ne la lit.
// Garde-fou critique : en visibilité effective `'busy'`, la requête SQL ne sélectionne JAMAIS `title`, `description` ni `location_name`.

export type { VisibilitePartage };
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
  /** Source d'agenda externe qui a importé ce créneau ; `null` pour un créneau saisi à la main. */
  calendar_source_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type CreneauPersonnel = z.infer<typeof ligneCreneauPersonnel>;

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

/** Un créneau personnel de CE compte, ou `undefined` (404 `agenda.introuvable`). */
export function lireCreneauPersonnel(portee: PorteeUtilisateur, id: string): CreneauPersonnel | undefined {
  const ligne = portee.un<unknown>('personal_events', id);
  return ligne === undefined ? undefined : ligneCreneauPersonnel.parse(ligne);
}

/**
 * Créneaux personnels non supprimés du compte, triés par `starts_at` puis `id`.
 * Si `fenetre` est fournie, ne retient que les créneaux qui la touchent.
 */
export function listerCreneauxPersonnels(
  portee: PorteeUtilisateur,
  fenetre?: { readonly du?: string | undefined; readonly au?: string | undefined },
): CreneauPersonnel[] {
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
  return lues
    .map((ligne) => ligneCreneauPersonnel.parse(ligne))
    .sort((x, y) => (x.starts_at < y.starts_at ? -1 : x.starts_at > y.starts_at ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

const lignePlafond = z.object({ personal_agenda_visibility: z.enum(['none', 'busy', 'details']) });

/** Le réglage de compte (plafond) : ce que les membres des groupes du compte peuvent voir de son agenda personnel. */
export function lirePlafondAgenda(portee: PorteeUtilisateur): VisibilitePartage {
  const ligne = preparer(baseDe(portee), 'SELECT personal_agenda_visibility FROM users WHERE id = ?').get(portee.userId);
  return lignePlafond.parse(ligne).personal_agenda_visibility;
}

/**
 * Insère un créneau personnel et crée automatiquement ses partages initiaux, un par appartenance active du compte :
 * `plafonner(réglage de compte, 'details')`. Réglage à `none` : aucune ligne (ADR-0017, décision 5).
 */
export function creerCreneauPersonnel(portee: PorteeUtilisateur, champs: ChampsCreneauPersonnel): CreneauPersonnel {
  const base = baseDe(portee);
  const id = portee.transaction(() => {
    const creneauId = portee.inserer('personal_events', valeursDe(champs));
    const visibilite = plafonner(lirePlafondAgenda(portee), 'details');
    if (visibilite !== 'none') {
      for (const g of mesGroupes(portee)) {
        creerScope(base, portee.userId, g.group_id).upsert('personal_event_shares', { personal_event_id: creneauId, visibility: visibilite });
      }
    }
    return creneauId;
  });
  const cree = lireCreneauPersonnel(portee, id);
  if (cree === undefined) throw new Error('Créneau personnel introuvable juste après sa création.');
  return cree;
}

const TAILLE_PAGE_REALIGNEMENT = 500;

/**
 * Réalignement à l'enregistrement du réglage de compte (ADR-0017, décision 5) : met les partages existants à
 * `plafonner(réglage, 'details')` (créneau saisi à la main) ou `plafonner(réglage, 'busy')` (créneau importé), en créant ceux qui
 * manquent pour les appartenances actives. Ce n'est PAS le dispositif de sécurité (le plafond à la lecture l'est) : il n'existe que pour
 * qu'ÉLARGIR le réglage prenne effet sur les créneaux déjà en base. Il ne supprime jamais une ligne : `none` ne détruit rien.
 */
export function realignerPartagesSurReglage(portee: PorteeUtilisateur): void {
  const reglage = lirePlafondAgenda(portee);
  if (reglage === 'none') return;
  const base = baseDe(portee);
  portee.transaction(() => {
    const scopes = mesGroupes(portee).map((g) => creerScope(base, portee.userId, g.group_id));
    for (let apres: string | undefined; ; ) {
      const page = portee
        .tous<unknown>('personal_events', apres === undefined ? [] : [{ colonne: 'id', operateur: '>', valeur: apres }], {
          ordre: [{ colonne: 'id' }],
          limite: TAILLE_PAGE_REALIGNEMENT,
        })
        .map((ligne) => ligneCreneauPersonnel.parse(ligne));
      for (const creneau of page) {
        const visibilite = plafonner(reglage, creneau.calendar_source_id === null ? 'details' : 'busy');
        if (visibilite === 'none') continue;
        for (const scope of scopes) scope.upsert('personal_event_shares', { personal_event_id: creneau.id, visibility: visibilite });
      }
      if (page.length < TAILLE_PAGE_REALIGNEMENT) break;
      apres = page.at(-1)?.id;
    }
  });
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

// --- Disponibilités dans un groupe (GroupScope) -------------------------------------------------------------------------

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

/** Un couple (réglage de compte, visibilité du partage) à lire, et la visibilité effective qui en résulte. */
export interface CoupleDisponibilite {
  readonly plafond: VisibiliteActive;
  readonly partage: VisibiliteActive;
  readonly effective: VisibiliteActive;
}

/**
 * Les couples exécutés par `listerDisponibilitesGroupe`, ENGENDRÉS par `plafonner` : la table SQL ne peut pas diverger de la fonction pure.
 * Un plafond `none` n'y figure pas (aucune requête) ; un partage ne vaut jamais `none` (le `CHECK` de la table). Le texte « occupé » est
 * donc exécuté trois fois, le texte « détails » une fois (ADR-0017, décision 3).
 */
export const COUPLES_DISPONIBILITE: readonly CoupleDisponibilite[] = (['busy', 'details'] as const).flatMap((plafond) =>
  (['busy', 'details'] as const).map((partage) => {
    const effective = plafonner(plafond, partage);
    if (effective === 'none') throw new Error('Un plafond actif et un partage actif ne donnent jamais « none ».');
    return { plafond, partage, effective };
  }),
);

/**
 * Disponibilités partagées avec ce groupe par ses membres ACTIFS dans la fenêtre `du` .. `au`, sous le PLAFOND du compte
 * (`users.personal_agenda_visibility`, ADR-0017) : la visibilité effective est le minimum du plafond et du partage.
 * Deux textes SQL, exécutés une fois par couple de `COUPLES_DISPONIBILITE` :
 *  1. Visibilité effective `'busy'` : ni `p.title`, ni `p.description`, ni `p.location_name` ne figurent dans le SELECT :
 *     ces colonnes ne quittent jamais SQLite.
 *  2. Visibilité effective `'details'` : elles sont lues et exposées.
 * Un plafond `none` ne lance aucune requête. La garde du SQL brut (verrou n° 6) refuse toute lecture qui joint partages et créneaux
 * sans ce plafond : ne la contournez pas.
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
    `WHERE s.group_id = ? AND m.status = ? AND u.personal_agenda_visibility = ? AND s.visibility = ? AND p.deleted_at IS NULL AND COALESCE(p.ends_at, p.starts_at) >= ?${clauseFin} ` +
    'ORDER BY p.starts_at, s.membership_id, p.id LIMIT ?';

  const requeteOccupee = preparer(
    base,
    `SELECT p.id AS id, s.membership_id AS membership_id, u.display_name AS display_name,
       p.all_day AS all_day, p.starts_at AS starts_at, p.ends_at AS ends_at, p.time_zone AS time_zone
     ${tablesEtFiltres}`,
  );
  const requeteDetaillee = preparer(
    base,
    `SELECT p.id AS id, s.membership_id AS membership_id, u.display_name AS display_name,
       p.all_day AS all_day, p.starts_at AS starts_at, p.ends_at AS ends_at, p.time_zone AS time_zone,
       p.title AS title, p.description AS description, p.location_name AS location_name
     ${tablesEtFiltres}`,
  );

  const occupees: DisponibiliteMembre[] = [];
  const detaillees: DisponibiliteMembre[] = [];
  for (const couple of COUPLES_DISPONIBILITE) {
    const parametres = [scope.groupId, 'active', couple.plafond, couple.partage, fenetre.du, ...paramsFin, LIMITE_LISTE];
    if (couple.effective === 'busy') {
      for (const ligne of requeteOccupee.all(...parametres)) {
        occupees.push({
          ...ligneDisponibiliteOccupee.parse(ligne),
          visibility: 'busy' as const,
          title: null,
          description: null,
          location_name: null,
        });
      }
    } else {
      for (const ligne of requeteDetaillee.all(...parametres)) {
        detaillees.push({ ...ligneDisponibiliteDetail.parse(ligne), visibility: 'details' as const });
      }
    }
  }

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
