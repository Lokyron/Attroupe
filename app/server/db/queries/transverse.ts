import { z } from 'zod';
import type { Base } from '../base.js';
import { nouvelIdentifiant } from '../identifiant.js';
import { baseDe, type PorteeUtilisateur } from '../portee-utilisateur.js';
import { preparerTransverse } from '../sql.js';

// Lectures qui traversent les groupes par nature. Seul fichier autorisé à appeler
// `preparerTransverse` (ESLint + test) ; chaque texte SQL est figé dans `TEXTES_TRANSVERSES`
// (db/sql.ts) et un test compare cette liste aux appels de ce fichier.
// Toute fonction d'ici prend une `PorteeUtilisateur`, jamais un identifiant nu (une route ne peut pas
// lister les groupes d'un autre compte).

const MES_GROUPES = `SELECT g.id AS group_id, g.name AS name, g.slug AS slug, m.id AS membership_id, m.role AS role
   FROM memberships AS m JOIN groups AS g ON g.id = m.group_id
   WHERE m.user_id = ? AND m.status = 'active' AND g.deleted_at IS NULL
   ORDER BY g.name, g.id`;

const groupeDeLUtilisateur = z.object({
  group_id: z.string(),
  name: z.string(),
  slug: z.string(),
  membership_id: z.string(),
  role: z.enum(['admin', 'member']),
});

export type GroupeDeLUtilisateur = z.infer<typeof groupeDeLUtilisateur>;

/** « Mes groupes » : les groupes où ce compte a une appartenance ACTIVE (groupes supprimés exclus). */
export function mesGroupes(portee: PorteeUtilisateur): GroupeDeLUtilisateur[] {
  return preparerTransverse(baseDe(portee), MES_GROUPES)
    .all(portee.userId)
    .map((ligne) => groupeDeLUtilisateur.parse(ligne));
}

// --- File d'e-mails (`email_outbox`) ------------------------------------------------------------
// La file est interne et globale : aucune colonne de compte, donc aucune portée. Elle n'est lue que par
// le service d'envoi (services/brevo.ts) et alimentée par les services qui créent une notification ou
// un jeton. Ces fonctions prennent donc la `Base` et non une portée : ce sont les seules de ce fichier
// à le faire, parce qu'elles n'ont pas de compte à servir. Elles ne reçoivent jamais d'identifiant
// venu d'une requête (l'`id` est généré ici ou relu de la file).

const ENFILER_EMAIL = `INSERT INTO email_outbox (id, to_email, template_key, payload_json, locale, status, attempts, next_attempt_at, created_at)
   VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`;

const EMAILS_DUS = `SELECT id, to_email, template_key, payload_json, locale, attempts
   FROM email_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?`;

const RESERVER_EMAIL = `UPDATE email_outbox SET next_attempt_at = ? WHERE id = ? AND status = 'pending'`;

// Le gabarit est vidé à l'envoi : inutile une fois l'e-mail parti (et il porte le nom et l'adresse de la personne).
const MARQUER_ENVOYE = `UPDATE email_outbox SET status = 'sent', sent_at = ?, provider_message_id = ?, payload_json = '{}', last_error = NULL
   WHERE id = ? AND status = 'pending'`;

const MARQUER_ECHEC = `UPDATE email_outbox SET status = ?, attempts = attempts + ?, next_attempt_at = ?, last_error = ?,
   payload_json = CASE WHEN ? = 'pending' THEN payload_json ELSE '{}' END
   WHERE id = ? AND status = 'pending'`;

export interface EmailAEnfiler {
  readonly to: string;
  readonly templateKey: string;
  /** Variables du gabarit : jamais de secret (un lien à jeton se fabrique à l'envoi, la file n'en garde que l'identifiant de ligne). */
  readonly payload: Readonly<Record<string, string>>;
  readonly locale?: string;
}

/** Met un e-mail en file. À appeler dans la transaction qui crée la cause de l'e-mail. Renvoie l'`id`. */
export function enfilerEmail(base: Base, email: EmailAEnfiler, maintenant: string): string {
  const id = nouvelIdentifiant();
  preparerTransverse(base, ENFILER_EMAIL).run(
    id,
    email.to,
    email.templateKey,
    JSON.stringify(email.payload),
    email.locale ?? 'fr',
    maintenant,
    maintenant,
  );
  return id;
}

const emailDu = z.object({
  id: z.string(),
  to_email: z.string(),
  template_key: z.string(),
  payload_json: z.string(),
  locale: z.string(),
  attempts: z.number().int(),
});

export type EmailDu = z.infer<typeof emailDu>;

/**
 * Prend (au plus `limite`) e-mails dus et les « réserve » : leur prochaine tentative est repoussée de
 * `bailMs`, pour qu'un envoi interrompu (arrêt du conteneur en pleine remise) soit repris plus tard sans
 * que deux remises simultanées partent sur le même e-mail. La réservation ne compte pas comme une tentative.
 */
export function reserverEmailsDus(base: Base, maintenant: string, finDuBail: string, limite: number): EmailDu[] {
  const lus = preparerTransverse(base, EMAILS_DUS).all(maintenant, limite).map((ligne) => emailDu.parse(ligne));
  const reserver = preparerTransverse(base, RESERVER_EMAIL);
  return lus.filter((email) => reserver.run(finDuBail, email.id).changes === 1);
}

/** L'e-mail est parti : le gabarit (et son lien à jeton) est effacé. */
export function marquerEmailEnvoye(base: Base, id: string, messageId: string | null, maintenant: string): void {
  preparerTransverse(base, MARQUER_ENVOYE).run(maintenant, messageId, id);
}

/**
 * Enregistre un échec : `pending` (nouvel essai à `prochaine`), `failed` (définitif) ou `abandoned` (plafond atteint).
 * `compterEssai` faux : panne de configuration (clé refusée), l'essai ne consomme pas le plafond.
 */
export function marquerEmailEchec(
  base: Base,
  id: string,
  statut: 'pending' | 'failed' | 'abandoned',
  prochaine: string,
  erreur: string,
  compterEssai = true,
): void {
  preparerTransverse(base, MARQUER_ECHEC).run(statut, compterEssai ? 1 : 0, prochaine, erreur.slice(0, 500), statut, id);
}

const NOTIFICATIONS_ATTENTE_RESUME = `SELECT n.id AS notification_id, n.user_id AS user_id, n.group_id AS group_id,
          g.name AS group_name, g.time_zone AS time_zone,
          u.email AS email, u.display_name AS display_name
   FROM notifications AS n
   JOIN groups AS g ON g.id = n.group_id
   JOIN memberships AS m ON m.user_id = n.user_id AND m.group_id = n.group_id
   JOIN users AS u ON u.id = n.user_id
   WHERE n.read_at IS NULL AND n.email_queued_at IS NULL AND n.email_sent_at IS NULL
     AND g.deleted_at IS NULL AND m.status = 'active'
     AND u.email_verified_at IS NOT NULL AND u.disabled_at IS NULL AND u.anonymized_at IS NULL
   ORDER BY n.user_id, n.group_id, n.created_at`;

const ligneNotificationAttenteResume = z.object({
  notification_id: z.string(),
  user_id: z.string(),
  group_id: z.string(),
  group_name: z.string(),
  time_zone: z.string(),
  email: z.string(),
  display_name: z.string(),
});

export type NotificationAttenteResume = z.infer<typeof ligneNotificationAttenteResume>;

/** Notifications non lues et pas encore mises en file d'e-mail, pour l'envoi des résumés quotidiens. */
export function listerNotificationsEnAttenteResume(base: Base): NotificationAttenteResume[] {
  return preparerTransverse(base, NOTIFICATIONS_ATTENTE_RESUME)
    .all()
    .map((ligne) => ligneNotificationAttenteResume.parse(ligne));
}

const PURGER_ABONNEMENTS_REVOQUES = `DELETE FROM calendar_feed_tokens WHERE revoked_at < ?`;

/**
 * Entretien : supprime les abonnements iCal révoqués avant `avant`. Renvoie le nombre de lignes. Un abonnement actif
 * (`revoked_at` nul) ne satisfait jamais la comparaison : il n'est jamais supprimé. Transverse car la tâche de fond traverse les comptes.
 */
export function purgerAbonnementsRevoques(base: Base, avant: string): number {
  return Number(preparerTransverse(base, PURGER_ABONNEMENTS_REVOQUES).run(avant).changes);
}
