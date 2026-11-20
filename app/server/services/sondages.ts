import { listerMembres } from '../db/queries/membres.js';
import {
  ajouterOption as ajouterOptionEnBase,
  annulerSondage as annulerSondageEnBase,
  convertirSondage as convertirSondageEnBase,
  creerSondage as creerSondageEnBase,
  lireOption,
  lireSondage,
  listerSondages as listerSondagesEnBase,
  modifierSondage as modifierSondageEnBase,
  optionsDe,
  supprimerOption as supprimerOptionEnBase,
  toutesLesOptions,
  voterOption,
  votesDeSondage,
  type ModificationSondage,
  type NouvelleOption,
  type OptionSondage,
  type Sondage,
} from '../db/queries/sondages.js';
import type { GroupScope } from '../db/scope.js';
import { versInstant } from '../domain/instant.js';
import {
  calculerCompteurs,
  optionGagnante,
  optionsOntDoublon,
  sondageOuvert,
  type CompteursOption,
  type ValeurVote,
} from '../domain/sondages.js';
import type { Contexte } from '../http/contexte.js';
import { ErreurHttp } from '../http/erreurs.js';
import { detailEvenement, notifierEvenementCree, type DetailEvenement } from './evenements.js';
import { libelleNotificationPush, pousserNotificationsWebPush } from './notifications.js';

// Cas d'usage des sondages de dates (lot 7). Ordre strict des vérifications :
//  1. cloisonnement (sondage du groupe → 404 `sondage.introuvable`, option du sondage → 404 `option.introuvable`) ;
//  2. droit (auteur du sondage ou admin du groupe pour modifier, annuler, convertir, retirer une option → 403 `droit.auteur_requis`) ;
//  3. cohérence d'état (sondage fermé, annulé, déjà converti, option en doublon → 409).

export interface AuteurSondage {
  readonly membership_id: string;
  readonly display_name: string;
}

export interface VoteOptionPublic {
  readonly membership_id: string;
  readonly display_name: string;
  readonly value: ValeurVote;
}

export interface OptionPublique extends Omit<OptionSondage, 'all_day'> {
  readonly all_day: boolean;
  readonly votes: VoteOptionPublic[];
  readonly mon_vote: ValeurVote | null;
  readonly compteurs: CompteursOption;
}

export interface SondagePublic extends Sondage {
  readonly auteur: AuteurSondage;
  readonly options_count: number;
}

export interface DetailSondage extends Sondage {
  readonly auteur: AuteurSondage;
  readonly options: OptionPublique[];
  readonly option_gagnante_id: string | null;
}

function nomsMembres(scope: GroupScope): Map<string, string> {
  return new Map(listerMembres(scope).map((m) => [m.id, m.display_name]));
}

function trouverSondage(scope: GroupScope, sondageId: string): Sondage {
  const sondage = lireSondage(scope, sondageId);
  if (sondage === undefined) throw new ErreurHttp(404, 'sondage.introuvable');
  return sondage;
}

/** Seuls l'auteur du sondage et un administrateur du groupe modifient, annulent ou convertissent (tout membre vote). */
function exigerAuteurOuAdmin(scope: GroupScope, sondage: Sondage): void {
  if (scope.role === 'admin') return;
  if (sondage.created_by_membership_id === scope.membershipId) return;
  throw new ErreurHttp(403, 'droit.auteur_requis');
}

function trouverOption(scope: GroupScope, sondageId: string, optionId: string): OptionSondage {
  const option = lireOption(scope, sondageId, optionId);
  if (option === undefined) throw new ErreurHttp(404, 'option.introuvable');
  return option;
}

function exigerSondageOuvert(sondage: Sondage, maintenant: string): void {
  if (!sondageOuvert(sondage, maintenant)) throw new ErreurHttp(409, 'sondage.ferme');
}

export function listerSondages(scope: GroupScope): SondagePublic[] {
  const noms = nomsMembres(scope);
  const options = toutesLesOptions(scope);
  return listerSondagesEnBase(scope).map((sondage) => ({
    ...sondage,
    auteur: {
      membership_id: sondage.created_by_membership_id,
      display_name: noms.get(sondage.created_by_membership_id) ?? '',
    },
    options_count: options.filter((o) => o.date_poll_id === sondage.id).length,
  }));
}

export function detailSondage(scope: GroupScope, sondageId: string): DetailSondage {
  const sondage = trouverSondage(scope, sondageId);
  const noms = nomsMembres(scope);
  const optionsBrutes = optionsDe(scope, sondage.id);
  const tousVotes = votesDeSondage(scope, sondage.id);

  const options: OptionPublique[] = optionsBrutes.map((option) => {
    const votes = tousVotes
      .filter((v) => v.date_poll_option_id === option.id)
      .map((v) => ({ membership_id: v.membership_id, display_name: v.display_name, value: v.value }));
    const monVote = votes.find((v) => v.membership_id === scope.membershipId)?.value ?? null;
    return {
      ...option,
      all_day: option.all_day === 1,
      votes,
      mon_vote: monVote,
      compteurs: calculerCompteurs(votes),
    };
  });

  return {
    ...sondage,
    auteur: {
      membership_id: sondage.created_by_membership_id,
      display_name: noms.get(sondage.created_by_membership_id) ?? '',
    },
    options,
    option_gagnante_id: optionGagnante(options)?.id ?? null,
  };
}

export function creerSondage(
  contexte: Contexte,
  scope: GroupScope,
  champs: {
    readonly title: string;
    readonly description: string | null;
    readonly closes_at: string | null;
    readonly options: readonly NouvelleOption[];
  },
): DetailSondage {
  if (optionsOntDoublon(champs.options)) throw new ErreurHttp(409, 'sondage.option_dupliquee');
  const id = creerSondageEnBase(scope, champs);
  contexte.diffuseur.diffuser(scope, { type: 'sondage.cree', ressource: 'sondage', id, parent_id: null });
  return detailSondage(scope, id);
}

export function modifierSondage(
  contexte: Contexte,
  scope: GroupScope,
  sondageId: string,
  champs: ModificationSondage,
): DetailSondage {
  const sondage = trouverSondage(scope, sondageId);
  exigerAuteurOuAdmin(scope, sondage);
  if (sondage.status === 'converted') throw new ErreurHttp(409, 'sondage.deja_converti');
  if (sondage.status === 'cancelled') throw new ErreurHttp(409, 'sondage.annule');
  if (!modifierSondageEnBase(scope, sondage.id, champs)) throw new ErreurHttp(404, 'sondage.introuvable');
  contexte.diffuseur.diffuser(scope, { type: 'sondage.modifie', ressource: 'sondage', id: sondage.id, parent_id: null });
  return detailSondage(scope, sondage.id);
}

export function annulerSondage(contexte: Contexte, scope: GroupScope, sondageId: string): DetailSondage {
  const sondage = trouverSondage(scope, sondageId);
  exigerAuteurOuAdmin(scope, sondage);
  if (sondage.status === 'converted') throw new ErreurHttp(409, 'sondage.deja_converti');
  if (sondage.status !== 'cancelled') {
    if (!annulerSondageEnBase(scope, sondage.id)) throw new ErreurHttp(404, 'sondage.introuvable');
    contexte.diffuseur.diffuser(scope, { type: 'sondage.annule', ressource: 'sondage', id: sondage.id, parent_id: null });
  }
  return detailSondage(scope, sondage.id);
}

export function ajouterOption(
  contexte: Contexte,
  scope: GroupScope,
  sondageId: string,
  option: NouvelleOption,
): DetailSondage {
  const sondage = trouverSondage(scope, sondageId);
  // Proposer une date reste ouvert à tout membre (sondage collaboratif) ; en retirer une est réservé à l'auteur ou un admin.
  exigerSondageOuvert(sondage, versInstant(contexte.horloge()));
  const optionId = ajouterOptionEnBase(scope, sondage.id, option);
  if (optionId === null) throw new ErreurHttp(409, 'sondage.option_dupliquee');
  contexte.diffuseur.diffuser(scope, { type: 'sondage.option_ajoutee', ressource: 'sondage', id: optionId, parent_id: sondage.id });
  return detailSondage(scope, sondage.id);
}

export function retirerOption(contexte: Contexte, scope: GroupScope, sondageId: string, optionId: string): DetailSondage {
  const sondage = trouverSondage(scope, sondageId);
  const option = trouverOption(scope, sondage.id, optionId);
  exigerAuteurOuAdmin(scope, sondage);
  exigerSondageOuvert(sondage, versInstant(contexte.horloge()));
  if (!supprimerOptionEnBase(scope, sondage.id, option.id)) throw new ErreurHttp(404, 'option.introuvable');
  contexte.diffuseur.diffuser(scope, { type: 'sondage.option_retiree', ressource: 'sondage', id: option.id, parent_id: sondage.id });
  return detailSondage(scope, sondage.id);
}

export function voterSondage(
  contexte: Contexte,
  scope: GroupScope,
  sondageId: string,
  optionId: string,
  value: ValeurVote,
): DetailSondage {
  const sondage = trouverSondage(scope, sondageId);
  const option = trouverOption(scope, sondage.id, optionId);
  exigerSondageOuvert(sondage, versInstant(contexte.horloge()));
  voterOption(scope, option.id, value);
  contexte.diffuseur.diffuser(scope, { type: 'sondage.vote', ressource: 'sondage', id: option.id, parent_id: sondage.id });
  return detailSondage(scope, sondage.id);
}

export function convertirSondage(
  contexte: Contexte,
  scope: GroupScope,
  sondageId: string,
  champs: {
    readonly option_id?: string | undefined;
    readonly time_zone?: string | undefined;
    readonly location_name?: string | null | undefined;
    readonly description?: string | null | undefined;
  },
): { sondage: DetailSondage; evenement: DetailEvenement } {
  const sondage = trouverSondage(scope, sondageId);
  // Si option_id est fourni, on vérifie d'abord que l'option appartient à CE sondage dans CE groupe (404 avant 403, puis 409).
  const optionExplicite = champs.option_id !== undefined ? trouverOption(scope, sondage.id, champs.option_id) : undefined;
  exigerAuteurOuAdmin(scope, sondage);
  if (sondage.status === 'converted') throw new ErreurHttp(409, 'sondage.deja_converti');
  if (sondage.status === 'cancelled') throw new ErreurHttp(409, 'sondage.annule');

  let optionRetenue = optionExplicite;
  if (optionRetenue === undefined) {
    const detail = detailSondage(scope, sondage.id);
    const gagnante = optionGagnante(detail.options);
    if (gagnante === null) throw new ErreurHttp(409, 'sondage.aucune_option');
    optionRetenue = trouverOption(scope, sondage.id, gagnante.id);
  }

  // Conversion et notification « événement créé » dans la même transaction : la date choisie, c'est l'événement qui naît.
  const maintenant = versInstant(contexte.horloge());
  const { resultat, destinataires } = scope.transaction(() => {
    const converti = convertirSondageEnBase(scope, sondage, optionRetenue, champs);
    return {
      resultat: converti,
      destinataires: converti.etat === 'converti' ? notifierEvenementCree(contexte, scope, converti.evenementId, maintenant) : [],
    };
  });
  if (resultat.etat === 'introuvable') throw new ErreurHttp(404, 'sondage.introuvable');
  if (resultat.etat === 'deja_converti') throw new ErreurHttp(409, 'sondage.deja_converti');
  if (resultat.etat !== 'converti') throw new ErreurHttp(409, 'sondage.annule');
  const { evenementId } = resultat;
  // Web Push seulement une fois la transaction validée.
  pousserNotificationsWebPush(contexte, destinataires, libelleNotificationPush('event_created', {}));
  contexte.diffuseur.diffuser(scope, { type: 'sondage.converti', ressource: 'sondage', id: sondage.id, parent_id: evenementId });
  return {
    sondage: detailSondage(scope, sondage.id),
    evenement: detailEvenement(scope, evenementId),
  };
}
