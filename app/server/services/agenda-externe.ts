import type { IncomingMessage } from 'node:http';
import type { PorteeUtilisateur } from '../db/portee-utilisateur.js';
import {
  lireSource,
  lireUrlSource,
  modifierSource,
  remplacerCreneauxImportes,
  type PlageImportee,
  type SourceAgenda,
  type StatutSource,
} from '../db/queries/agenda-externe.js';
import { lireProfil } from '../db/queries/comptes.js';
import { ErreurIcsIllisible, ErreurIcsTropGros, analyserIcs } from '../domain/ics-entrant.js';
import { HEURE_MS, JOUR_MS, SECONDE_MS, versInstant } from '../domain/instant.js';
import type { Journal } from '../http/middleware/journal.js';
import {
  dnsLookupSysteme,
  envoyerEpingle,
  resoudreEtVerifier,
  ErreurResolutionEpinglee,
  type AdressesVerifiees,
  type DnsLookupEpingle,
} from './requete-epinglee.js';

// Synchronisation d'agenda ENTRANTE (ADR-0013) : récupère l'ICS d'une source, en tire des plages « occupé » et remplace le lot importé.
// - La requête sortante passe EXCLUSIVEMENT par `requete-epinglee.ts` (anti-SSRF), avec `autoriserPrive: false` écrit en dur : l'URL est
//   choisie par n'importe quel compte, aucune variable d'environnement ne doit pouvoir l'assouplir.
// - `Accept-Encoding: identity` : aucune décompression n'existe ici, une bombe gzip arrive comme des octets illisibles.
// - En cas d'échec on CONSERVE les créneaux déjà importés : une panne du fournisseur ne doit pas faire paraître l'utilisateur libre.

export const INTERVALLE_SYNCHRO_MS = 2 * HEURE_MS;
const RECUL_MAX_MS = 24 * HEURE_MS;
export const ECHECS_MAX = 10;
export const ECHECS_MAX_REFUSE = 3;
/** Plafond de téléchargement (compteur d'octets réel sur le flux : le `Content-Length` n'est jamais cru). */
export const OCTETS_MAX = 1024 * 1024;
export const INACTIVITE_RESEAU_MS = 10 * SECONDE_MS;
export const BUDGET_TOTAL_MS = 20 * SECONDE_MS;
const HORIZON_PASSE_JOURS = 7;
const HORIZON_FUTUR_JOURS = 180;
const LONGUEUR_URL_MAX = 2048;
const LONGUEUR_HOTE_MAX = 255;
const STATUTS_REFUSES = new Set([401, 403, 404, 410]);

/** Doubles injectables en test (jamais en production) : le DNS, l'envoi et les délais. La vérification d'adresse, elle, n'est jamais remplacée. */
export interface DependancesAgenda {
  readonly dnsLookup?: DnsLookupEpingle;
  readonly envoyer?: typeof envoyerEpingle;
  readonly inactiviteMs?: number;
  readonly budgetMs?: number;
}

export interface ContexteSynchro {
  /** `ATTROUPE_ENCRYPTION_KEY` : déchiffre l'URL de la source. */
  readonly cleChiffrement: string;
  readonly horloge: () => Date;
  readonly journal: Journal;
  readonly dependances?: DependancesAgenda | undefined;
}

/** URL de source acceptée : `href` normalisé (celui qui est chiffré et empreinté) et hôte seul, pour l'affichage. */
export interface UrlSourceNormalisee {
  readonly href: string;
  readonly hote: string;
}

/**
 * `webcal://` → `https://`, puis `https` SEUL, port 443 SEUL, ni identifiant ni mot de passe. `undefined` pour toute autre forme :
 * l'appelant répond la même erreur quelle que soit la cause.
 */
export function normaliserUrlSource(saisie: string): UrlSourceNormalisee | undefined {
  const texte = saisie.trim();
  if (texte === '' || texte.length > LONGUEUR_URL_MAX) return undefined;
  let url: URL;
  try {
    url = new URL(texte.replace(/^webcal:\/\//i, 'https://'));
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  // Le port 443 est le port par défaut de https : `URL` le range en chaîne vide.
  if (url.port !== '') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  if (url.hostname === '' || url.hostname.length > LONGUEUR_HOTE_MAX) return undefined;
  url.hash = '';
  return { href: url.href, hote: url.hostname };
}

/** Une source telle que l'API la rend : jamais l'URL (ni claire ni chiffrée), ni les validateurs HTTP internes. */
export type SourcePublique = Omit<SourceAgenda, 'http_etag' | 'http_last_modified'>;

export function publierSource(source: SourceAgenda): SourcePublique {
  const { http_etag: _etag, http_last_modified: _modifie, ...publique } = source;
  void _etag;
  void _modifie;
  return publique;
}

export interface BilanSynchro {
  readonly statut: StatutSource;
  /** Créneaux importés après cette synchronisation (inchangé sur un 304 et sur un échec : les anciens sont conservés). */
  readonly creneaux: number;
  /** Événements que l'analyseur n'a pas su lire (comptés, jamais devinés). */
  readonly ignores: number;
  /** `true` si les créneaux viennent d'être réécrits ; `false` sur un 304 ou un échec. */
  readonly modifiee: boolean;
  /** `true` si cette synchronisation a désactivé la source. */
  readonly desactivee: boolean;
}

type EchecRecuperation = 'injoignable' | 'trop_gros' | 'refuse';

type ResultatRecuperation =
  | { readonly type: 'modifie'; readonly texte: string; readonly etag: string | null; readonly derniereModification: string | null }
  | { readonly type: 'inchange' }
  | { readonly type: 'echec'; readonly statut: EchecRecuperation };

function entete(reponse: IncomingMessage, nom: 'etag' | 'last-modified'): string | null {
  const valeur = reponse.headers[nom];
  return typeof valeur === 'string' && valeur !== '' ? valeur : null;
}

async function lireCorps(reponse: IncomingMessage): Promise<Buffer | 'trop_gros'> {
  const morceaux: Buffer[] = [];
  let total = 0;
  for await (const morceau of reponse as AsyncIterable<unknown>) {
    if (!Buffer.isBuffer(morceau)) throw new Error('Morceau de réponse inattendu.');
    total += morceau.length;
    if (total > OCTETS_MAX) {
      reponse.destroy();
      return 'trop_gros';
    }
    morceaux.push(morceau);
  }
  // Un flux coupé net (réinitialisation, abandon) ne doit jamais passer pour un fichier complet.
  if (!reponse.complete) throw new Error('Réponse interrompue.');
  return Buffer.concat(morceaux);
}

async function recuperer(
  url: URL,
  validateurs: { readonly etag: string | null; readonly derniereModification: string | null },
  dependances: DependancesAgenda,
): Promise<ResultatRecuperation> {
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), dependances.budgetMs ?? BUDGET_TOTAL_MS);
  try {
    let adresses: AdressesVerifiees;
    try {
      // `autoriserPrive: false` EN DUR (ADR-0013 §7).
      adresses = await resoudreEtVerifier(url.hostname, { autoriserPrive: false, dnsLookup: dependances.dnsLookup ?? dnsLookupSysteme });
    } catch (erreur) {
      if (!(erreur instanceof ErreurResolutionEpinglee)) throw erreur;
      // Une adresse interdite ne deviendra pas publique d'elle-même : même traitement qu'une URL révoquée.
      return { type: 'echec', statut: erreur.code === 'adresse_interdite' ? 'refuse' : 'injoignable' };
    }
    const reponse = await (dependances.envoyer ?? envoyerEpingle)({
      url,
      method: 'GET',
      headers: {
        Accept: 'text/calendar, text/plain;q=0.5, */*;q=0.1',
        'Accept-Encoding': 'identity',
        ...(validateurs.etag !== null ? { 'If-None-Match': validateurs.etag } : {}),
        ...(validateurs.derniereModification !== null ? { 'If-Modified-Since': validateurs.derniereModification } : {}),
      },
      body: null,
      signal: controleur.signal,
      adresses,
      autoriserPrive: false,
      inactivite: { delaiMs: dependances.inactiviteMs ?? INACTIVITE_RESEAU_MS, message: 'Aucune donnée reçue de la source d’agenda.' },
    });
    const code = reponse.statusCode ?? 0;
    if (code === 304) {
      reponse.resume();
      return { type: 'inchange' };
    }
    if (code !== 200) {
      reponse.destroy();
      return { type: 'echec', statut: STATUTS_REFUSES.has(code) ? 'refuse' : 'injoignable' };
    }
    const corps = await lireCorps(reponse);
    if (corps === 'trop_gros') return { type: 'echec', statut: 'trop_gros' };
    return {
      type: 'modifie',
      texte: new TextDecoder('utf-8').decode(corps),
      etag: entete(reponse, 'etag'),
      derniereModification: entete(reponse, 'last-modified'),
    };
  } catch {
    // Réseau coupé, délai dépassé, flux interrompu : la source est injoignable, et rien de plus précis ne doit s'en déduire.
    return { type: 'echec', statut: 'injoignable' };
  } finally {
    clearTimeout(minuteur);
  }
}

/** Recul exponentiel `2 h × 2^(n−1)` plafonné à 24 h (`n` = nombre d'échecs consécutifs, au moins 1). */
export function reculApresEchecs(echecs: number): number {
  return Math.min(INTERVALLE_SYNCHRO_MS * 2 ** Math.min(echecs - 1, 10), RECUL_MAX_MS);
}

/**
 * Synchronise UNE source de CE compte : récupère, analyse, remplace le lot de créneaux importés. Ne lève pas pour un échec de la
 * source (réseau, format, refus…) : il est enregistré sur la source et rendu dans le bilan. `undefined` si la source n'est pas à ce compte.
 */
export async function synchroniserSource(contexte: ContexteSynchro, portee: PorteeUtilisateur, sourceId: string): Promise<BilanSynchro | undefined> {
  const source = lireSource(portee, sourceId);
  if (source === undefined) return undefined;
  const maintenant = contexte.horloge();
  const instant = versInstant(maintenant);

  const echouer = (statut: Exclude<StatutSource, 'ok' | 'vide'>): BilanSynchro => {
    const echecs = source.consecutive_failures + 1;
    const desactivee = statut === 'cle_illisible' || echecs >= (statut === 'refuse' ? ECHECS_MAX_REFUSE : ECHECS_MAX);
    modifierSource(portee, sourceId, {
      last_attempt_at: instant,
      last_status: statut,
      consecutive_failures: echecs,
      next_attempt_at: versInstant(new Date(maintenant.getTime() + reculApresEchecs(echecs))),
      // Après un échec le contenu distant est inconnu : le prochain essai redemande tout, un 304 ne pourra pas masquer l'échec.
      http_etag: null,
      http_last_modified: null,
      ...(desactivee ? { disabled_at: instant } : {}),
    });
    contexte.journal.warn('agenda.import_echec', { source: sourceId, statut, echecs, desactivee });
    return { statut, creneaux: source.slots_imported, ignores: source.slots_skipped, modifiee: false, desactivee };
  };

  let urlClaire: string | undefined;
  try {
    urlClaire = lireUrlSource(portee, sourceId, contexte.cleChiffrement);
  } catch {
    // Clé maîtresse changée (ou ligne altérée) : l'URL est perdue, inutile de réessayer. Reprise manuelle.
    return echouer('cle_illisible');
  }
  if (urlClaire === undefined) return undefined;
  const normalisee = normaliserUrlSource(urlClaire);
  if (normalisee === undefined) return echouer('refuse');

  const resultat = await recuperer(
    new URL(normalisee.href),
    { etag: source.http_etag, derniereModification: source.http_last_modified },
    contexte.dependances ?? {},
  );
  if (resultat.type === 'echec') return echouer(resultat.statut);

  const reussir = (champs: { readonly statut: StatutSource; readonly etag: string | null; readonly derniereModification: string | null; readonly importes: number; readonly ignores: number }): void => {
    modifierSource(portee, sourceId, {
      disabled_at: null,
      last_attempt_at: instant,
      last_success_at: instant,
      last_status: champs.statut,
      consecutive_failures: 0,
      next_attempt_at: versInstant(new Date(maintenant.getTime() + INTERVALLE_SYNCHRO_MS)),
      http_etag: champs.etag,
      http_last_modified: champs.derniereModification,
      slots_imported: champs.importes,
      slots_skipped: champs.ignores,
    });
  };

  if (resultat.type === 'inchange') {
    // Rien n'a changé chez le fournisseur. Sans validateur envoyé, un 304 n'a pas de sens : c'est une réponse fautive, pas un succès.
    if (source.http_etag === null && source.http_last_modified === null) return echouer('injoignable');
    reussir({
      statut: source.last_status ?? 'ok',
      etag: source.http_etag,
      derniereModification: source.http_last_modified,
      importes: source.slots_imported,
      ignores: source.slots_skipped,
    });
    return { statut: source.last_status ?? 'ok', creneaux: source.slots_imported, ignores: source.slots_skipped, modifiee: false, desactivee: false };
  }

  const fuseau = lireProfil(portee).time_zone;
  let analyse: ReturnType<typeof analyserIcs>;
  try {
    analyse = analyserIcs(resultat.texte, {
      horizonDebut: new Date(maintenant.getTime() - HORIZON_PASSE_JOURS * JOUR_MS),
      horizonFin: new Date(maintenant.getTime() + HORIZON_FUTUR_JOURS * JOUR_MS),
      fuseauParDefaut: fuseau,
    });
  } catch (erreur) {
    if (erreur instanceof ErreurIcsIllisible) return echouer('illisible');
    if (erreur instanceof ErreurIcsTropGros) return echouer('trop_gros');
    throw erreur;
  }

  const plages: PlageImportee[] = analyse.plages.map((p) => ({
    starts_at: p.debut,
    ends_at: p.fin,
    all_day: p.journeeEntiere,
    time_zone: fuseau,
    titre: p.titre,
    description: p.description,
    lieu: p.lieu,
  }));
  const ecrites = remplacerCreneauxImportes(portee, sourceId, plages, contexte.cleChiffrement);
  if (ecrites === undefined) return undefined;
  // Un ICS valide sans aucun VEVENT est appliqué tel quel (l'agenda est peut-être réellement vide), mais reste visible dans le journal.
  const vide = !/^BEGIN:VEVENT\s*$/im.test(resultat.texte);
  const statut: StatutSource = vide ? 'vide' : 'ok';
  if (vide) contexte.journal.warn('agenda.import_vide', { source: sourceId });
  reussir({ statut, etag: resultat.etag, derniereModification: resultat.derniereModification, importes: ecrites, ignores: analyse.ignores });
  return { statut, creneaux: ecrites, ignores: analyse.ignores, modifiee: true, desactivee: false };
}
