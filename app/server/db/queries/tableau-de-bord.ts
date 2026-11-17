import { type Base } from '../base.js';
import { type PorteeUtilisateur } from '../portee-utilisateur.js';
import { creerScope, ErreurAppartenance } from '../scope.js';
import { calculerSoldesParDevise } from '../../domain/soldes.js';
import { construireUrlMediaSignee } from '../../domain/immich.js';
import { JOUR_MS, plus, versInstant } from '../../domain/instant.js';
import { listerCreneauxPersonnels, type CreneauPersonnelAvecPartages } from './agenda-personnel.js';
import { listerDepenses, listerRemboursements, type DepenseAvecParts } from './depenses.js';
import { listerEvenements, maPresence, type Evenement, type Presence } from './evenements.js';
import { lireConfigImmich, listerAlbums, listerAssetsAlbum } from './immich.js';
import { listerMembres } from './membres.js';
import { mesGroupes } from './transverse.js';

// Tableau de bord multi-groupes de l'utilisateur connecté.
// Agrège, pour chaque groupe où le compte est membre actif (via `mesGroupes(portee)` + `creerScope`),
// les événements à venir, dépenses récentes, soldes nets non nuls, photos récentes (URL signées)
// ainsi que les créneaux personnels à venir.

const HORIZON_JOURS = 90;
const MAX_EVENEMENTS_GROUPE = 12;
const MAX_EVENEMENTS_PERSO = 8;
const MAX_EVENEMENTS_FENETRE = 200;
const MAX_DEPENSES = 8;
const MAX_PHOTOS = 12;

export interface GroupeTableauDeBord {
  readonly group_id: string;
  readonly name: string;
  readonly role: 'admin' | 'member';
  readonly photos_actives: boolean;
}

export interface EvenementTableauDeBord extends Evenement {
  readonly group_id: string;
  readonly group_name: string;
  readonly ma_presence: Presence['status'] | null;
  readonly type: 'groupe';
}

export interface DepenseTableauDeBord extends DepenseAvecParts {
  readonly group_id: string;
  readonly group_name: string;
  readonly payer_name: string;
}

export interface SoldeTableauDeBord {
  readonly group_id: string;
  readonly group_name: string;
  readonly currency_code: string;
  readonly net_minor: number;
}

export interface PhotoTableauDeBord {
  readonly album_id: string;
  readonly album_title: string;
  readonly group_id: string;
  readonly group_name: string;
  readonly immich_asset_id: string;
  readonly kind: 'image' | 'video';
  readonly taken_at: string | null;
  readonly created_at: string;
  readonly thumbnail_url: string;
}

export interface TableauDeBord {
  readonly groupes: GroupeTableauDeBord[];
  readonly evenements: EvenementTableauDeBord[];
  readonly evenements_perso: CreneauPersonnelAvecPartages[];
  readonly depenses: DepenseTableauDeBord[];
  readonly soldes: SoldeTableauDeBord[];
  readonly photos: PhotoTableauDeBord[];
}

export interface OptionsTableauDeBord {
  readonly maintenant: Date;
  readonly signedUrlSecret: string;
  readonly du?: string;
  readonly au?: string;
}

/**
 * Construit le tableau de bord multi-groupes de l'utilisateur porté par `portee`.
 * Chaque groupe actif est ouvert via `creerScope` ; une appartenance devenue inactive entre-temps
 * (`ErreurAppartenance`) ou un groupe supprimé (`scope.groupe() === undefined`) est ignoré.
 */
export function lireTableauDeBord(
  base: Base,
  portee: PorteeUtilisateur,
  options: OptionsTableauDeBord,
): TableauDeBord {
  const aujourdHuiDate = versInstant(options.maintenant).slice(0, 10);
  const dans90JoursDate = versInstant(plus(options.maintenant, HORIZON_JOURS * JOUR_MS)).slice(0, 10);
  const fenetrePersonnalisee = options.du !== undefined && options.au !== undefined;
  const du = options.du !== undefined && options.au !== undefined ? options.du : aujourdHuiDate;
  const au = options.du !== undefined && options.au !== undefined ? options.au : dans90JoursDate;
  const maxEvenementsGroupe = fenetrePersonnalisee ? MAX_EVENEMENTS_FENETRE : MAX_EVENEMENTS_GROUPE;
  const maxEvenementsPerso = fenetrePersonnalisee ? MAX_EVENEMENTS_FENETRE : MAX_EVENEMENTS_PERSO;

  const groupes: GroupeTableauDeBord[] = [];
  const evenements: EvenementTableauDeBord[] = [];
  const depenses: DepenseTableauDeBord[] = [];
  const soldes: SoldeTableauDeBord[] = [];
  const photos: PhotoTableauDeBord[] = [];

  for (const g of mesGroupes(portee)) {
    let scope;
    try {
      scope = creerScope(base, portee.userId, g.group_id);
    } catch (err) {
      if (err instanceof ErreurAppartenance) continue;
      throw err;
    }
    if (scope.groupe() === undefined) continue;

    const photosActives = lireConfigImmich(scope) !== undefined;
    groupes.push({
      group_id: g.group_id,
      name: g.name,
      role: scope.role,
      photos_actives: photosActives,
    });

    for (const e of listerEvenements(scope, { du, au })) {
      if (e.status !== 'published') continue;
      evenements.push({
        ...e,
        group_id: g.group_id,
        group_name: g.name,
        ma_presence: maPresence(scope, e.id)?.status ?? null,
        type: 'groupe' as const,
      });
    }

    const depensesGroupe = listerDepenses(scope);
    const remboursementsGroupe = listerRemboursements(scope);
    const nomsMembres = new Map(listerMembres(scope).map((m) => [m.id, m.display_name]));

    for (const d of depensesGroupe) {
      depenses.push({
        ...d,
        group_id: g.group_id,
        group_name: g.name,
        payer_name: nomsMembres.get(d.payer_membership_id) ?? '',
      });
    }

    const depensesAvecParts = depensesGroupe.filter((d) => d.shares.length > 0);
    for (const s of calculerSoldesParDevise(depensesAvecParts, remboursementsGroupe)) {
      const monSolde = s.soldes.find((x) => x.membership_id === scope.membershipId)?.net_minor ?? 0;
      if (monSolde !== 0) {
        soldes.push({
          group_id: g.group_id,
          group_name: g.name,
          currency_code: s.currency_code,
          net_minor: monSolde,
        });
      }
    }

    if (photosActives) {
      for (const album of listerAlbums(scope)) {
        for (const a of listerAssetsAlbum(scope, album.id)) {
          photos.push({
            album_id: album.id,
            album_title: album.title,
            group_id: g.group_id,
            group_name: g.name,
            immich_asset_id: a.immich_asset_id,
            kind: a.kind,
            taken_at: a.taken_at,
            created_at: a.created_at,
            thumbnail_url: construireUrlMediaSignee(
              {
                albumId: album.id,
                assetId: a.immich_asset_id,
                taille: 'thumbnail',
                userId: portee.userId,
                maintenant: options.maintenant,
              },
              options.signedUrlSecret,
            ),
          });
        }
      }
    }
  }

  const evenementsPerso = listerCreneauxPersonnels(portee, { du, au })
    .sort((x, y) => (x.starts_at < y.starts_at ? -1 : x.starts_at > y.starts_at ? 1 : x.id < y.id ? -1 : 1))
    .slice(0, maxEvenementsPerso);

  evenements.sort((x, y) => (x.starts_at < y.starts_at ? -1 : x.starts_at > y.starts_at ? 1 : x.id < y.id ? -1 : 1));
  depenses.sort((x, y) =>
    x.spent_on > y.spent_on
      ? -1
      : x.spent_on < y.spent_on
        ? 1
        : x.created_at > y.created_at
          ? -1
          : x.created_at < y.created_at
            ? 1
            : x.id > y.id
              ? -1
              : 1,
  );
  photos.sort((x, y) =>
    x.created_at > y.created_at ? -1 : x.created_at < y.created_at ? 1 : x.immich_asset_id > y.immich_asset_id ? -1 : 1,
  );

  return {
    groupes,
    evenements: evenements.slice(0, maxEvenementsGroupe),
    evenements_perso: evenementsPerso,
    depenses: depenses.slice(0, MAX_DEPENSES),
    soldes,
    photos: photos.slice(0, MAX_PHOTOS),
  };
}
