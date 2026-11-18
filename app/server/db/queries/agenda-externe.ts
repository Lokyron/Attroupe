import { createHash } from 'node:crypto';
import { z } from 'zod';
import { chiffrerCleImmich, dechiffrerCleImmich } from '../../domain/immich.js';
import { baseDe, type PorteeUtilisateur } from '../portee-utilisateur.js';
import { creerScope } from '../scope.js';
import { preparer } from '../sql.js';
import { mesGroupes } from './transverse.js';

// Synchronisation d'agenda ENTRANTE (migration 0004) : sources d'agenda externe d'un compte et créneaux importés.
// Un créneau importé n'a ni titre, ni description, ni lieu EN CLAIR (CHECK en base), et il n'est jamais partagé en `details`
// (déclencheurs en base). Ses textes, s'il en a (migration 0005, ADR-0013 révisé), vivent chiffrés dans `details_cipher` /
// `details_nonce` et ne se relisent que par `lireDetailsImportes` (le propriétaire) : les requêtes de groupe ne les lisent pas. L'URL de la source est un secret porteur : chiffrée au repos (AES-256-GCM,
// mêmes fonctions que la clé d'API Immich), jamais renvoyée par `lireSource` ni `listerMesSources`.

export { sourcesAFaire, type SourceAgendaAFaire } from './transverse.js';

export const STATUTS_SOURCE = ['ok', 'vide', 'injoignable', 'trop_gros', 'illisible', 'refuse', 'cle_illisible'] as const;
export type StatutSource = (typeof STATUTS_SOURCE)[number];

const ligneSource = z.object({
  id: z.string(),
  label: z.string(),
  url_host: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  disabled_at: z.string().nullable(),
  next_attempt_at: z.string(),
  last_attempt_at: z.string().nullable(),
  last_success_at: z.string().nullable(),
  last_status: z.enum(STATUTS_SOURCE).nullable(),
  consecutive_failures: z.number().int(),
  http_etag: z.string().nullable(),
  http_last_modified: z.string().nullable(),
  slots_imported: z.number().int(),
  slots_skipped: z.number().int(),
});

/** Une source d'agenda externe, SANS son URL (ni en clair ni chiffrée) : seul l'hôte est exposé. */
export type SourceAgenda = z.infer<typeof ligneSource>;

const COLONNES_SOURCE =
  'id, label, url_host, created_at, updated_at, disabled_at, next_attempt_at, last_attempt_at, last_success_at, last_status, ' +
  'consecutive_failures, http_etag, http_last_modified, slots_imported, slots_skipped';

const ligneUrlSource = z.object({ url_cipher: z.instanceof(Buffer), url_nonce: z.instanceof(Buffer) });

export interface NouvelleSource {
  readonly label: string;
  /** URL déjà normalisée (la normalisation et la validation anti-SSRF sont à la charge de l'appelant). */
  readonly url: string;
  /** Hôte seul, en clair, pour l'affichage. */
  readonly hote: string;
  /** Première échéance de synchronisation (`Instant`). */
  readonly prochaineTentative: string;
}

export type ResultatCreationSource = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly raison: 'doublon' };

/** Empreinte SHA-256 (hex) de l'URL normalisée : l'unicité par compte se joue dessus, sans jamais comparer le clair. */
export function empreinteUrlSource(urlNormalisee: string): string {
  return createHash('sha256').update(urlNormalisee, 'utf8').digest('hex');
}

/** Crée une source (URL chiffrée avec `cleChiffrement`). `doublon` si ce compte suit déjà cette URL. */
export function creerSource(portee: PorteeUtilisateur, source: NouvelleSource, cleChiffrement: string): ResultatCreationSource {
  const empreinte = empreinteUrlSource(source.url);
  const chiffree = chiffrerCleImmich(source.url, cleChiffrement);
  return portee.transaction(() => {
    const existantes = portee.tous<unknown>('calendar_sources', [{ colonne: 'url_fingerprint', operateur: '=', valeur: empreinte }], { limite: 1 });
    if (existantes.length > 0) return { ok: false, raison: 'doublon' } as const;
    const id = portee.inserer('calendar_sources', {
      label: source.label,
      url_cipher: chiffree.cipher,
      url_nonce: chiffree.nonce,
      url_host: source.hote,
      url_fingerprint: empreinte,
      next_attempt_at: source.prochaineTentative,
    });
    return { ok: true, id } as const;
  });
}

/** Sources du compte, les plus anciennes d'abord. */
export function listerMesSources(portee: PorteeUtilisateur): SourceAgenda[] {
  return preparer(baseDe(portee), `SELECT ${COLONNES_SOURCE} FROM calendar_sources WHERE user_id = ? ORDER BY created_at, id`)
    .all(portee.userId)
    .map((ligne) => ligneSource.parse(ligne));
}

/** Une source de CE compte, ou `undefined` (404, jamais 403). */
export function lireSource(portee: PorteeUtilisateur, id: string): SourceAgenda | undefined {
  const ligne = preparer(baseDe(portee), `SELECT ${COLONNES_SOURCE} FROM calendar_sources WHERE id = ? AND user_id = ?`).get(id, portee.userId);
  return ligne === undefined ? undefined : ligneSource.parse(ligne);
}

/**
 * URL en clair d'une source de CE compte, pour la synchronisation seulement (jamais pour une réponse d'API).
 * @throws Error si l'URL ne se déchiffre pas (ATTROUPE_ENCRYPTION_KEY modifiée ou ligne altérée) : l'appelant enregistre `cle_illisible`.
 */
export function lireUrlSource(portee: PorteeUtilisateur, id: string, cleChiffrement: string): string | undefined {
  const ligne = preparer(baseDe(portee), 'SELECT url_cipher, url_nonce FROM calendar_sources WHERE id = ? AND user_id = ?').get(id, portee.userId);
  if (ligne === undefined) return undefined;
  const { url_cipher: cipher, url_nonce: nonce } = ligneUrlSource.parse(ligne);
  return dechiffrerCleImmich(cipher, nonce, cleChiffrement);
}

/** Colonnes modifiables d'une source (état de synchronisation compris). Les instants sont des `Instant`. */
export interface ModificationSource {
  readonly label?: string | undefined;
  readonly disabled_at?: string | null | undefined;
  readonly next_attempt_at?: string | undefined;
  readonly last_attempt_at?: string | null | undefined;
  readonly last_success_at?: string | null | undefined;
  readonly last_status?: StatutSource | null | undefined;
  readonly consecutive_failures?: number | undefined;
  readonly http_etag?: string | null | undefined;
  readonly http_last_modified?: string | null | undefined;
  readonly slots_imported?: number | undefined;
  readonly slots_skipped?: number | undefined;
}

/** Met à jour une source de CE compte ; `false` si elle n'existe pas ou n'est pas à lui. */
export function modifierSource(portee: PorteeUtilisateur, id: string, champs: ModificationSource): boolean {
  const fournies = Object.entries(champs).filter((entree): entree is [string, string | number | null] => entree[1] !== undefined);
  return portee.modifier('calendar_sources', id, Object.fromEntries(fournies));
}

/** Suppression réelle : les créneaux importés de la source partent avec elle (cascade en base). `false` si elle n'est pas à ce compte. */
export function supprimerSource(portee: PorteeUtilisateur, id: string): boolean {
  return portee.supprimer('calendar_sources', { id });
}

/**
 * Une plage importée. `starts_at` / `ends_at` sont des `Instant` (ou `AAAA-MM-JJ` si `all_day`). `titre`, `description` et `lieu`
 * ne sont jamais écrits en clair : ils partent chiffrés dans `details_cipher` / `details_nonce`.
 */
export interface PlageImportee {
  readonly starts_at: string;
  readonly ends_at: string | null;
  readonly all_day: boolean;
  readonly time_zone: string;
  readonly titre?: string | undefined;
  readonly description?: string | undefined;
  readonly lieu?: string | undefined;
}

/** Textes d'un créneau importé, tels que le propriétaire les relit. */
export interface DetailsImporte {
  readonly titre?: string;
  readonly description?: string;
  readonly lieu?: string;
}

const schemaDetailsImporte = z.object({ titre: z.string().optional(), description: z.string().optional(), lieu: z.string().optional() });

/** JSON chiffrable des textes d'une plage, ou `undefined` si elle n'en a aucun (les deux colonnes restent alors NULL). */
function detailsDe(plage: PlageImportee): DetailsImporte | undefined {
  const details: { titre?: string; description?: string; lieu?: string } = {};
  if (plage.titre !== undefined && plage.titre !== '') details.titre = plage.titre;
  if (plage.description !== undefined && plage.description !== '') details.description = plage.description;
  if (plage.lieu !== undefined && plage.lieu !== '') details.lieu = plage.lieu;
  return Object.keys(details).length === 0 ? undefined : details;
}

const ligneDetailsChiffres = z.object({ id: z.string(), details_cipher: z.instanceof(Buffer), details_nonce: z.instanceof(Buffer) });

export interface DetailsImportesLus {
  /** Textes déchiffrés, par identifiant de créneau. */
  readonly details: ReadonlyMap<string, DetailsImporte>;
  /** Nombre de blobs qui ne se déchiffrent pas (clé maîtresse changée, ligne altérée) : leurs créneaux n'ont alors aucun texte. */
  readonly illisibles: number;
}

/**
 * Textes déchiffrés des créneaux importés de CE compte, par identifiant. RÉSERVÉ à la lecture par le propriétaire : aucune requête de
 * groupe ne doit appeler ceci. Ne lève jamais sur un blob illisible : il est compté dans `illisibles` et son créneau reste sans texte.
 */
export function lireDetailsImportes(portee: PorteeUtilisateur, cleChiffrement: string): DetailsImportesLus {
  const lignes = preparer(
    baseDe(portee),
    'SELECT id, details_cipher, details_nonce FROM personal_events WHERE user_id = ? AND deleted_at IS NULL AND calendar_source_id IS NOT NULL AND details_cipher IS NOT NULL',
  )
    .all(portee.userId)
    .map((ligne) => ligneDetailsChiffres.parse(ligne));
  const details = new Map<string, DetailsImporte>();
  let illisibles = 0;
  for (const l of lignes) {
    try {
      const lu = schemaDetailsImporte.parse(JSON.parse(dechiffrerCleImmich(l.details_cipher, l.details_nonce, cleChiffrement)));
      details.set(l.id, {
        ...(lu.titre === undefined ? {} : { titre: lu.titre }),
        ...(lu.description === undefined ? {} : { description: lu.description }),
        ...(lu.lieu === undefined ? {} : { lieu: lu.lieu }),
      });
    } catch {
      illisibles += 1;
    }
  }
  return { details, illisibles };
}

const ligneVisibiliteMembre = z.object({ default_personal_visibility: z.enum(['none', 'busy', 'details']) });

/**
 * Remplace en UNE transaction le lot de créneaux importés d'une source : suppression réelle de l'ancien lot, insertion du nouveau,
 * puis partages. Renvoie le nombre de plages écrites, ou `undefined` si la source n'est pas à ce compte (rien n'est alors écrit).
 *
 * Les partages suivent `default_personal_visibility` de chaque groupe, SAUF que `details` est ramené à `busy` : un créneau importé
 * n'a aucun détail à montrer, et le déclencheur de la base ferait échouer toute la synchronisation. Une visibilité `none` est respectée.
 */
export function remplacerCreneauxImportes(
  portee: PorteeUtilisateur,
  sourceId: string,
  plages: readonly PlageImportee[],
  cleChiffrement: string,
): number | undefined {
  const base = baseDe(portee);
  return portee.transaction(() => {
    if (lireSource(portee, sourceId) === undefined) return undefined;
    const scopes = mesGroupes(portee).flatMap((g) => {
      const scope = creerScope(base, portee.userId, g.group_id);
      const membre = scope.un<unknown>('memberships', scope.membershipId);
      if (membre === undefined) return [];
      const { default_personal_visibility: visibilite } = ligneVisibiliteMembre.parse(membre);
      return visibilite === 'none' ? [] : [scope];
    });
    preparer(base, 'DELETE FROM personal_events WHERE user_id = ? AND calendar_source_id = ?').run(portee.userId, sourceId);
    for (const plage of plages) {
      const details = detailsDe(plage);
      const chiffres = details === undefined ? undefined : chiffrerCleImmich(JSON.stringify(details), cleChiffrement);
      const creneauId = portee.inserer('personal_events', {
        title: '',
        description: null,
        location_name: null,
        all_day: plage.all_day ? 1 : 0,
        starts_at: plage.starts_at,
        ends_at: plage.ends_at,
        time_zone: plage.time_zone,
        calendar_source_id: sourceId,
        details_cipher: chiffres?.cipher ?? null,
        details_nonce: chiffres?.nonce ?? null,
      });
      // Ramène-au-sûr explicite : jamais `details`, quel que soit le réglage du membre.
      for (const scope of scopes) scope.upsert('personal_event_shares', { personal_event_id: creneauId, visibility: 'busy' });
    }
    return plages.length;
  });
}
