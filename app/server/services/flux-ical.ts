import { createHash } from 'node:crypto';
import { lireProfil } from '../db/queries/comptes.js';
import {
  empreinteFlux,
  empreintePersonnelleFlux,
  evenementsFlux,
  evenementsPersonnelsFlux,
  type EvenementFlux,
  type EvenementPersonnelFlux,
  type FenetreFlux,
} from '../db/queries/flux.js';
import type { GroupScope } from '../db/scope.js';
import { versInstant } from '../domain/instant.js';
import { genererCalendrier, type EvenementIcal, type LibellesIcal } from '../domain/ical.js';
import type { AccesFlux } from '../http/middleware/jeton-flux.js';
import fr from '../i18n/fr.json' with { type: 'json' };

// Flux iCal (architecture §7.1) : fenêtre, empreinte (ETag) et génération. Ce service ne lit jamais d'événement hors d'un `GroupScope`
// (celui que l'intergiciel de jeton fabrique pour chaque groupe où l'appartenance est active) : il boucle sur les scopes.

/** Fenêtre : 3 mois en arrière, 12 mois en avant — et, au-delà, tout ce qui a été modifié depuis son début (db/queries/flux.ts). */
const MOIS_ARRIERE = 3;
const MOIS_AVANT = 12;

export function fenetreDe(maintenant: Date, exclureRefus: boolean): FenetreFlux {
  const debut = new Date(maintenant);
  debut.setUTCMonth(debut.getUTCMonth() - MOIS_ARRIERE);
  const fin = new Date(maintenant);
  fin.setUTCMonth(fin.getUTCMonth() + MOIS_AVANT);
  return { depuis: versInstant(debut), jusqua: versInstant(fin), exclureRefus };
}

function fenetreDuJeton(acces: AccesFlux): FenetreFlux {
  return fenetreDe(acces.maintenant, acces.jeton.include_declined === 0);
}

function nomDuGroupe(scope: GroupScope): string {
  return scope.groupe<{ name: string }>()?.name ?? '';
}

/**
 * Empreinte de ce que le flux servirait : le jeton, puis par groupe son nom (il est dans les titres) et l'EMPREINTE EXACTE des événements
 * servis (`empreinteFlux` : id, updated_at et organisateur de chacun, pas un simple couple maximum / nombre), le jour (la fenêtre glisse)
 * et les réglages. Une requête d'agrégat par ensemble et par groupe, aucune génération : c'est le coût d'un `304`. Un membre retiré, un
 * événement modifié, annulé, refusé ou « échangé » contre un autre, un organisateur renommé : chacun change au moins un de ces termes.
 */
export function calculerEtag(acces: AccesFlux): string {
  const fenetre = fenetreDuJeton(acces);
  const parGroupe = acces.scopes.map((scope) => {
    return `${scope.groupId}|${nomDuGroupe(scope)}|${empreinteFlux(scope, fenetre)}`;
  });
  const perso =
    acces.jeton.include_personal === 1
      ? `${lireProfil(acces.portee).display_name}|${empreintePersonnelleFlux(acces.portee, fenetre)}`
      : null;
  const entree = JSON.stringify([
    acces.empreinte,
    versInstant(acces.maintenant).slice(0, 10),
    acces.jeton.include_declined,
    acces.jeton.include_personal,
    parGroupe,
    perso,
  ]);
  return `"${createHash('sha256').update(entree, 'utf8').digest('hex').slice(0, 32)}"`;
}

const LIBELLES: LibellesIcal = fr.flux_ical;

function versIcal(e: EvenementFlux, groupe: string, urlBase: string, groupId: string): EvenementIcal {
  return {
    id: e.id,
    groupe,
    titre: e.title,
    description: e.description,
    lieuNom: e.location_name,
    lieuAdresse: e.location_address,
    consignes: e.arrival_note,
    journeeEntiere: e.all_day === 1,
    debut: e.starts_at,
    fin: e.ends_at,
    fuseau: e.time_zone,
    annule: e.status === 'cancelled',
    modifieLe: e.updated_at,
    organisateur: e.organizer_name,
    // Le lien ne contient que des identifiants d'événement : jamais le jeton du flux (le .ics finit dans des sauvegardes de téléphone).
    lien: `${urlBase}/#/groupe/${encodeURIComponent(groupId)}/evenement/${encodeURIComponent(e.id)}`,
  };
}

function personnelVersIcal(e: EvenementPersonnelFlux, organisateur: string, urlBase: string): EvenementIcal {
  return {
    id: `perso-${e.id}`,
    groupe: fr.flux_ical.groupe_personnel,
    titre: e.title,
    description: e.description,
    lieuNom: e.location_name,
    lieuAdresse: null,
    consignes: null,
    journeeEntiere: e.all_day === 1,
    debut: e.starts_at,
    fin: e.ends_at,
    fuseau: e.time_zone,
    annule: false,
    modifieLe: e.updated_at,
    organisateur,
    lien: `${urlBase}/#/compte`,
  };
}

/** Le VCALENDAR du jeton : les événements de chaque groupe lisible, groupe par groupe, et les créneaux personnels si demandés. */
export function genererFlux(acces: AccesFlux, urlBase: string): string {
  const fenetre = fenetreDuJeton(acces);
  const evenements = acces.scopes.flatMap((scope) => {
    const groupe = nomDuGroupe(scope);
    return evenementsFlux(scope, fenetre).map((e) => versIcal(e, groupe, urlBase, scope.groupId));
  });
  if (acces.jeton.include_personal === 1) {
    const organisateur = lireProfil(acces.portee).display_name;
    evenements.push(...evenementsPersonnelsFlux(acces.portee, fenetre).map((e) => personnelVersIcal(e, organisateur, urlBase)));
  }
  return genererCalendrier(fr.flux_ical.nom_calendrier, evenements, LIBELLES);
}
