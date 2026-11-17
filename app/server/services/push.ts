import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Base } from '../db/base.js';
import {
  enregistrerConfigPush,
  lireConfigPush,
  listerAbonnementsPushUtilisateur,
  marquerAbonnementPushUtilise,
  supprimerAbonnementPushExpire,
  type ConfigPush,
} from '../db/queries/push.js';
import { estAdresseIpPriveeOuReservee } from '../domain/immich.js';
import { versInstant } from '../domain/instant.js';
import {
  chiffrerPayloadPush,
  construireEnteteVapid,
  genererClesVapid,
  limiterPayloadPush,
  validerEndpointPush,
  type PayloadPush,
} from '../domain/push.js';
import type { Journal } from '../http/middleware/journal.js';
import type { DnsLookupImmich, EntreeDns } from './immich-client.js';

// Web Push sans librairie (RFC 8030 / 8291 / 8292). Le serveur POSTe vers une URL choisie par l'utilisateur (l'endpoint de son
// abonnement) : c'est une porte SSRF, protégée comme l'est Immich — hôte public seulement (domain/push.ts), TOUTES les adresses
// résolues vérifiées, connexion épinglée sur ces adresses (pas de second DNS entre la vérification et la connexion : rebinding),
// aucune redirection suivie. Différence voulue avec Immich : `ATTROUPE_IMMICH_ALLOW_PRIVATE` ne s'applique JAMAIS ici.

export interface EnvPush {
  readonly ATTROUPE_VAPID_PUBLIC_KEY?: string | undefined;
  readonly ATTROUPE_VAPID_PRIVATE_KEY?: string | undefined;
  readonly ATTROUPE_VAPID_SUBJECT?: string | undefined;
  readonly ATTROUPE_BASE_URL?: string | undefined;
  /** Chiffre la clé privée VAPID générée, stockée en base (même clé maîtresse que les clés d'API Immich). */
  readonly ATTROUPE_ENCRYPTION_KEY: string;
}

export interface OptionsEnvoiPush {
  /** Obligatoire : une seule clé VAPID doit servir partout (`/push/cle`, `/push/test`, notifications réelles). */
  readonly env: EnvPush;
  readonly fetch?: typeof fetch | undefined;
  readonly dnsLookup?: DnsLookupImmich | undefined;
  readonly journal?: Journal | undefined;
  readonly maintenant?: Date | undefined;
}

export interface ResultatEnvoiPush {
  readonly envoyes: number;
  readonly echecs: number;
}

/** Délai maximal d'un envoi vers un service push. */
const DELAI_ENVOI_PUSH_MS = 10_000;

/** Endpoint refusé (hôte non public, y compris après résolution DNS) ou injoignable (DNS). */
export class ErreurEndpointPush extends Error {
  constructor(
    public readonly code: 'interdit' | 'injoignable',
    message: string,
  ) {
    super(message);
    this.name = 'ErreurEndpointPush';
  }
}

function subjectParDefaut(env: EnvPush): string {
  if (env.ATTROUPE_VAPID_SUBJECT !== undefined) return env.ATTROUPE_VAPID_SUBJECT;
  if (env.ATTROUPE_BASE_URL !== undefined && URL.canParse(env.ATTROUPE_BASE_URL)) {
    const hote = new URL(env.ATTROUPE_BASE_URL).hostname;
    if (hote !== '' && hote !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(hote)) {
      return `mailto:contact@${hote}`;
    }
  }
  return 'mailto:contact@attroupe.local';
}

function obtenirConfigVapid(base: Base, env: EnvPush, maintenant: Date = new Date()): ConfigPush {
  if (env.ATTROUPE_VAPID_PUBLIC_KEY !== undefined && env.ATTROUPE_VAPID_PRIVATE_KEY !== undefined) {
    return {
      public_key: env.ATTROUPE_VAPID_PUBLIC_KEY,
      private_key: env.ATTROUPE_VAPID_PRIVATE_KEY,
      subject: subjectParDefaut(env),
    };
  }
  const existante = lireConfigPush(base, env.ATTROUPE_ENCRYPTION_KEY);
  if (existante !== null) return existante;

  const cles = genererClesVapid();
  return enregistrerConfigPush(
    base,
    {
      public_key: cles.publicKey,
      private_key: cles.privateKey,
      subject: subjectParDefaut(env),
    },
    env.ATTROUPE_ENCRYPTION_KEY,
    versInstant(maintenant),
  );
}

/** Retourne la clé publique VAPID (depuis l'environnement ou persistée/générée en base). */
export function obtenirClePubliqueVapid(base: Base, env: EnvPush): string {
  return obtenirConfigVapid(base, env).public_key;
}

/**
 * Valide l'endpoint (statique, domain/push.ts) puis résout son nom et vérifie TOUTES les adresses : une seule adresse non publique
 * suffit à refuser (un nom qui en renvoie plusieurs ne doit pas pouvoir en viser une interne). Rend les adresses à épingler.
 * @throws ErreurEndpointPush `interdit` (hôte non public) ou `injoignable` (DNS en échec).
 */
export async function verifierEndpointPublic(
  endpoint: string,
  dnsLookup: DnsLookupImmich = (hote, opts) => lookup(hote, opts) as Promise<readonly EntreeDns[]>,
): Promise<readonly EntreeDns[]> {
  const validation = validerEndpointPush(endpoint);
  if (!validation.valide) throw new ErreurEndpointPush('interdit', `Endpoint push refusé (${validation.raison}).`);

  const hote = validation.url.hostname.replace(/^\[|\]$/g, '');
  const famille = isIP(hote);
  if (famille !== 0) return [{ address: hote, family: famille }];

  let adresses: readonly EntreeDns[];
  try {
    adresses = await dnsLookup(hote, { all: true });
  } catch (erreur) {
    throw new ErreurEndpointPush('injoignable', `Résolution DNS impossible : ${erreur instanceof Error ? erreur.message : String(erreur)}`);
  }
  if (adresses.length === 0) throw new ErreurEndpointPush('injoignable', 'Aucune adresse résolue pour l’endpoint push.');
  for (const entree of adresses) {
    if (estAdresseIpPriveeOuReservee(entree.address)) {
      throw new ErreurEndpointPush('interdit', 'Endpoint push refusé : le nom résout vers une adresse non publique.');
    }
  }
  return adresses;
}

interface RequeteEnvoi {
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  readonly signal: AbortSignal;
}

/** POST HTTPS dont la connexion est épinglée sur `adresses` (déjà vérifiées). Une redirection n'est pas suivie : son statut est rendu tel quel. */
function posterEpingle(endpoint: string, requete: RequeteEnvoi, adresses: readonly EntreeDns[]): Promise<number> {
  const premiere = adresses[0];
  if (premiere === undefined) return Promise.reject(new ErreurEndpointPush('injoignable', 'Aucune adresse disponible.'));
  return new Promise<number>((resolve, reject) => {
    const req = https.request(
      new URL(endpoint),
      {
        method: 'POST',
        headers: { ...requete.headers, 'Content-Length': String(requete.body.length) },
        signal: requete.signal,
        lookup: (_hote, options, callback) => {
          if (typeof options === 'object' && options !== null && 'all' in options && options.all === true) {
            (callback as (err: NodeJS.ErrnoException | null, resultats: readonly EntreeDns[]) => void)(null, adresses);
          } else {
            callback(null, premiere.address, premiere.family);
          }
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 500);
      },
    );
    req.on('error', reject);
    req.end(requete.body);
  });
}

/**
 * Envoie une notification Web Push (VAPID + RFC 8291 `aes128gcm`) à tous les appareils de `userId`.
 * Chaque endpoint est revalidé juste avant l'envoi (hôte public, DNS épinglé). Un endpoint refusé (`interdit`) ou injoignable
 * compte comme un échec, sans suppression et sans trace distincte (voir le commentaire du `catch`).
 * Supprime les abonnements expirés (`404` / `410`) et met à jour `last_used_at` en cas de succès.
 * Ne jette jamais pour un échec réseau d'un appareil ; lève si la configuration VAPID est inutilisable (clé illisible) : l'appelant journalise.
 */
export async function envoyerNotificationPush(
  base: Base,
  userId: string,
  payload: PayloadPush,
  options: OptionsEnvoiPush,
): Promise<ResultatEnvoiPush> {
  const abonnements = listerAbonnementsPushUtilisateur(base, userId);
  if (abonnements.length === 0) {
    return { envoyes: 0, echecs: 0 };
  }

  const maintenantDate = options.maintenant ?? new Date();
  const maintenantIso = versInstant(maintenantDate);
  const config = obtenirConfigVapid(base, options.env, maintenantDate);
  const payloadBorne = limiterPayloadPush(payload);

  let envoyes = 0;
  let echecs = 0;

  for (const abo of abonnements) {
    try {
      const adresses = await verifierEndpointPublic(abo.endpoint, options.dnsLookup);
      const corps = chiffrerPayloadPush(payloadBorne, abo.p256dh, abo.auth);
      const authVapid = construireEnteteVapid(
        abo.endpoint,
        config.subject,
        config.public_key,
        config.private_key,
        maintenantDate,
      );
      const entetes = {
        Authorization: authVapid,
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        TTL: '86400',
      };
      const signal = AbortSignal.timeout(DELAI_ENVOI_PUSH_MS);
      const statut =
        options.fetch !== undefined
          ? (
              await options.fetch(abo.endpoint, {
                method: 'POST',
                headers: entetes,
                body: new Uint8Array(corps),
                redirect: 'manual',
                signal,
              })
            ).status
          : await posterEpingle(abo.endpoint, { headers: entetes, body: corps, signal }, adresses);

      if (statut === 404 || statut === 410) {
        supprimerAbonnementPushExpire(base, userId, abo.id);
        echecs++;
      } else if (statut >= 200 && statut < 300) {
        marquerAbonnementPushUtilise(base, userId, abo.id, maintenantIso);
        envoyes++;
      } else {
        echecs++;
      }
    } catch (erreur) {
      echecs++;
      // Ni le message ni l'adresse ne sont journalisés (ils peuvent contenir l'endpoint, qui est un secret d'accès) : le code suffit.
      // `interdit` (nom résolu vers une adresse non publique) et `injoignable` (DNS en échec) sont traités à l'identique :
      // ni suppression ni journal distinct, sinon `nb_appareils` ou le journal serviraient d'oracle sur les noms internes que
      // voit le résolveur du serveur. Le plafond d'abonnements par compte purge de toute façon les lignes mortes.
      if (erreur instanceof ErreurEndpointPush) {
        options.journal?.warn('push.envoi_echec', { abonnement: abo.id, type: erreur.name });
      } else {
        const code = erreur instanceof Error && 'code' in erreur && typeof erreur.code === 'string' ? erreur.code : undefined;
        options.journal?.warn('push.envoi_echec', {
          abonnement: abo.id,
          type: erreur instanceof Error ? erreur.name : 'inconnu',
          ...(code !== undefined ? { code } : {}),
        });
      }
    }
  }

  return { envoyes, echecs };
}
