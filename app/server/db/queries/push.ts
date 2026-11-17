import { z } from 'zod';
import { chiffrerCleImmich, dechiffrerCleImmich } from '../../domain/immich.js';
import type { Base } from '../base.js';
import type { PorteeUtilisateur } from '../portee-utilisateur.js';
import { preparer } from '../sql.js';

const ligneConfigPush = z.object({
  public_key: z.string(),
  private_key_cipher: z.instanceof(Buffer),
  private_key_nonce: z.instanceof(Buffer),
  subject: z.string(),
});

/** Configuration VAPID, clé privée EN CLAIR (déchiffrée à la lecture, chiffrée à l'écriture). */
export interface ConfigPush {
  readonly public_key: string;
  readonly private_key: string;
  readonly subject: string;
}

/**
 * Lit la configuration VAPID persistée en base, ou `null` si elle n'a pas encore été générée.
 * @throws Error si la clé privée ne se déchiffre pas (ATTROUPE_ENCRYPTION_KEY changée ou ligne altérée) : régénérer la paire
 *   en silence désabonnerait tous les appareils, c'est à l'administrateur d'en décider.
 */
export function lireConfigPush(base: Base, cleChiffrement: string): ConfigPush | null {
  const brut = preparer(
    base,
    'SELECT public_key, private_key_cipher, private_key_nonce, subject FROM push_config WHERE id = 1',
  ).get();
  if (brut === undefined) return null;
  const ligne = ligneConfigPush.parse(brut);
  let privee: string;
  try {
    privee = dechiffrerCleImmich(ligne.private_key_cipher, ligne.private_key_nonce, cleChiffrement);
  } catch (erreur) {
    throw new Error(
      `Clé privée VAPID illisible (ATTROUPE_ENCRYPTION_KEY modifiée ?) : ${erreur instanceof Error ? erreur.message : String(erreur)}`,
      { cause: erreur },
    );
  }
  return { public_key: ligne.public_key, private_key: privee, subject: ligne.subject };
}

/** Enregistre la configuration VAPID, clé privée chiffrée (idempotent si une autre requête vient de l'insérer). */
export function enregistrerConfigPush(base: Base, config: ConfigPush, cleChiffrement: string, maintenant: string): ConfigPush {
  const chiffree = chiffrerCleImmich(config.private_key, cleChiffrement);
  preparer(
    base,
    'INSERT INTO push_config (id, public_key, private_key_cipher, private_key_nonce, subject, created_at) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING',
  ).run(config.public_key, chiffree.cipher, chiffree.nonce, config.subject, maintenant);
  return lireConfigPush(base, cleChiffrement) ?? config;
}

const ligneAbonnement = z.object({
  id: z.string(),
  endpoint: z.string(),
  p256dh: z.string(),
  auth: z.string(),
  user_agent: z.string().nullable(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});

export type AbonnementPush = z.infer<typeof ligneAbonnement>;

/** Compte les appareils abonnés aux notifications push pour le compte connecté. */
export function compterAbonnementsPush(portee: PorteeUtilisateur): number {
  return portee.tous<{ id: string }>('push_subscriptions').length;
}

/**
 * Appareils push par compte. Au-delà, l'enregistrement d'un nouvel appareil remplace le plus ancien (le compte n'est pas refusé : un
 * navigateur réinstallé obtient un nouvel endpoint, et l'ancien, mort, ne serait sinon jamais purgé tant qu'il n'a pas répondu 404/410).
 * Dix couvre largement les appareils d'une personne ; le plafond borne surtout le nombre de cibles que le serveur contacte par notification.
 */
export const MAX_ABONNEMENTS_PUSH = 10;

/**
 * Enregistre un abonnement Web Push pour le compte connecté (remplace celui du même `endpoint`).
 * L'endpoint est unique pour toute l'instance : si un autre compte l'avait enregistré (navigateur partagé), son abonnement est supprimé
 * par le déclencheur `trg_push_subscriptions_reattribution` (migration 0003) au moment de l'insertion.
 * Le plafond `MAX_ABONNEMENTS_PUSH` tient : les plus anciens abonnements du compte sont supprimés pour faire de la place.
 */
export function enregistrerAbonnementPush(
  portee: PorteeUtilisateur,
  donnees: {
    readonly endpoint: string;
    readonly p256dh: string;
    readonly auth: string;
    readonly userAgent: string | null;
  },
): string {
  return portee.transaction(() => {
    const existants = portee
      .tous<unknown>('push_subscriptions')
      .map((e) => ligneAbonnement.parse(e))
      .sort((x, y) => (x.created_at === y.created_at ? x.id.localeCompare(y.id) : x.created_at.localeCompare(y.created_at)));
    // Même endpoint : l'ancienne ligne est remplacée (clés rafraîchies par le navigateur).
    const autres = existants.filter((e) => e.endpoint !== donnees.endpoint);
    for (const e of existants) {
      if (e.endpoint === donnees.endpoint) portee.supprimer('push_subscriptions', { id: e.id });
    }
    // Il faut de la place pour le nouveau : on retire les plus anciens jusqu'à MAX - 1.
    for (const ancien of autres.slice(0, Math.max(0, autres.length - (MAX_ABONNEMENTS_PUSH - 1)))) {
      portee.supprimer('push_subscriptions', { id: ancien.id });
    }
    return portee.inserer('push_subscriptions', {
      endpoint: donnees.endpoint,
      p256dh: donnees.p256dh,
      auth: donnees.auth,
      user_agent: donnees.userAgent,
    });
  });
}

/** Supprime l'abonnement ciblé par `endpoint`, ou tous les abonnements du compte si `endpoint` est absent. */
export function supprimerAbonnementsPush(portee: PorteeUtilisateur, endpoint?: string): number {
  return portee.transaction(() => {
    const cibles =
      endpoint !== undefined
        ? portee.tous<unknown>('push_subscriptions', [{ colonne: 'endpoint', operateur: '=', valeur: endpoint }])
        : portee.tous<unknown>('push_subscriptions');
    let supprimes = 0;
    for (const c of cibles) {
      const parsed = ligneAbonnement.parse(c);
      if (portee.supprimer('push_subscriptions', { id: parsed.id })) {
        supprimes++;
      }
    }
    return supprimes;
  });
}

const ligneAbonnementEnvoi = z.object({
  id: z.string(),
  endpoint: z.string(),
  p256dh: z.string(),
  auth: z.string(),
});

export type AbonnementPushEnvoi = z.infer<typeof ligneAbonnementEnvoi>;

/** Liste les abonnements push d'un utilisateur pour l'envoi de notifications. */
export function listerAbonnementsPushUtilisateur(base: Base, userId: string): AbonnementPushEnvoi[] {
  return preparer(base, 'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?')
    .all(userId)
    .map((l) => ligneAbonnementEnvoi.parse(l));
}

/** Supprime un abonnement expiré (réponse 404 ou 410 du service push). */
export function supprimerAbonnementPushExpire(base: Base, userId: string, id: string): void {
  preparer(base, 'DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(id, userId);
}

/** Met à jour `last_used_at` après un envoi réussi. */
export function marquerAbonnementPushUtilise(base: Base, userId: string, id: string, maintenant: string): void {
  preparer(base, 'UPDATE push_subscriptions SET last_used_at = ? WHERE id = ? AND user_id = ?').run(maintenant, id, userId);
}
