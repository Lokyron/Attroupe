import { z } from 'zod';
import { baseDeScope, type GroupScope } from '../scope.js';
import { preparer } from '../sql.js';

// Fils de discussion et messages d'un groupe (modèle §3.9). Tout passe par le GroupScope :
// un fil ou un message d'un autre groupe est invisible (undefined → 404).

const ligneFil = z.object({
  id: z.string(),
  event_id: z.string().nullable(),
  title: z.string().nullable(),
  kind: z.enum(['event', 'free']),
  is_locked: z.union([z.literal(0), z.literal(1)]).transform((v) => v === 1),
  last_message_at: z.string().nullable(),
  created_by_membership_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  event_title: z.string().nullable().optional().default(null),
});

export type Fil = z.infer<typeof ligneFil>;

const ligneMessage = z.object({
  id: z.string(),
  thread_id: z.string(),
  author_membership_id: z.string(),
  author_name: z.string(),
  body: z.string(),
  reply_to_message_id: z.string().nullable(),
  created_at: z.string(),
  edited_at: z.string().nullable(),
});

export type Message = z.infer<typeof ligneMessage>;

export interface PageMessages {
  readonly messages: Message[];
  readonly suivant: string | null;
}

/** Fils non supprimés du groupe, triés par dernière activité décroissante. */
export function listerFils(scope: GroupScope): Fil[] {
  return preparer(
    baseDeScope(scope),
    `SELECT t.id, t.event_id, t.title, t.kind, t.is_locked, t.last_message_at,
            t.created_by_membership_id, t.created_at, t.updated_at,
            e.title AS event_title
     FROM threads AS t
     LEFT JOIN events AS e ON e.id = t.event_id AND e.group_id = t.group_id AND e.deleted_at IS NULL
     WHERE t.group_id = ? AND t.deleted_at IS NULL
     ORDER BY COALESCE(t.last_message_at, t.created_at) DESC, t.id DESC`,
  )
    .all(scope.groupId)
    .map((ligne) => ligneFil.parse(ligne));
}

/** Un fil du groupe, ou `undefined` s'il n'existe pas dans ce groupe. */
export function lireFil(scope: GroupScope, filId: string): Fil | undefined {
  const brut = scope.un<Record<string, unknown>>('threads', filId);
  if (brut === undefined) return undefined;
  return ligneFil.parse(brut);
}

/** Crée un fil de discussion libre (`kind = 'free'`) dans le groupe. */
export function creerFilLibre(scope: GroupScope, title: string): Fil {
  const id = scope.inserer('threads', { kind: 'free', event_id: null, title });
  const cree = lireFil(scope, id);
  if (cree === undefined) throw new Error('Fil introuvable après insertion.');
  return cree;
}

/**
 * Messages d'un fil, paginés par curseur (`avant`), ordonnés du plus ancien au plus récent dans la page.
 * `suivant` contient l'identifiant du message le plus ancien de la page s'il existe une page précédente.
 */
export function listerMessages(scope: GroupScope, filId: string, avant?: string, limite = 50): PageMessages {
  const base = baseDeScope(scope);
  const plafond = Math.max(1, Math.min(limite, 100));
  let lignes: unknown[];

  if (avant !== undefined && avant.includes('T')) {
    lignes = preparer(
      base,
      `SELECT m.id, m.thread_id, m.author_membership_id, u.display_name AS author_name,
              m.body, m.reply_to_message_id, m.created_at, m.edited_at
       FROM messages AS m
       JOIN memberships AS mem ON mem.id = m.author_membership_id AND mem.group_id = m.group_id
       JOIN users AS u ON u.id = mem.user_id
       WHERE m.group_id = ? AND m.thread_id = ? AND m.deleted_at IS NULL AND m.created_at < ?
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ?`,
    ).all(scope.groupId, filId, avant, plafond + 1);
  } else if (avant !== undefined) {
    lignes = preparer(
      base,
      `SELECT m.id, m.thread_id, m.author_membership_id, u.display_name AS author_name,
              m.body, m.reply_to_message_id, m.created_at, m.edited_at
       FROM messages AS m
       JOIN memberships AS mem ON mem.id = m.author_membership_id AND mem.group_id = m.group_id
       JOIN users AS u ON u.id = mem.user_id
       WHERE m.group_id = ? AND m.thread_id = ? AND m.deleted_at IS NULL AND m.id < ?
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ?`,
    ).all(scope.groupId, filId, avant, plafond + 1);
  } else {
    lignes = preparer(
      base,
      `SELECT m.id, m.thread_id, m.author_membership_id, u.display_name AS author_name,
              m.body, m.reply_to_message_id, m.created_at, m.edited_at
       FROM messages AS m
       JOIN memberships AS mem ON mem.id = m.author_membership_id AND mem.group_id = m.group_id
       JOIN users AS u ON u.id = mem.user_id
       WHERE m.group_id = ? AND m.thread_id = ? AND m.deleted_at IS NULL
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ?`,
    ).all(scope.groupId, filId, plafond + 1);
  }

  const aSuite = lignes.length > plafond;
  const page = (aSuite ? lignes.slice(0, plafond) : lignes).map((l) => ligneMessage.parse(l)).reverse();
  const premier = page[0];
  return {
    messages: page,
    suivant: aSuite && premier !== undefined ? premier.id : null,
  };
}

/** Un message d'un fil du groupe, ou `undefined` s'il n'existe pas ou n'appartient pas à ce fil. */
export function lireMessage(scope: GroupScope, filId: string, messageId: string): Message | undefined {
  const brut = scope.un<{ thread_id: string }>('messages', messageId);
  if (brut === undefined || brut.thread_id !== filId) return undefined;
  const ligne = preparer(
    baseDeScope(scope),
    `SELECT m.id, m.thread_id, m.author_membership_id, u.display_name AS author_name,
            m.body, m.reply_to_message_id, m.created_at, m.edited_at
     FROM messages AS m
     JOIN memberships AS mem ON mem.id = m.author_membership_id AND mem.group_id = m.group_id
     JOIN users AS u ON u.id = mem.user_id
     WHERE m.group_id = ? AND m.id = ? AND m.thread_id = ? AND m.deleted_at IS NULL`,
  ).get(scope.groupId, messageId, filId);
  return ligne === undefined ? undefined : ligneMessage.parse(ligne);
}

/** Crée un message dans le fil et met à jour `threads.last_message_at` dans la même transaction. */
export function creerMessage(scope: GroupScope, filId: string, body: string, maintenant: string): Message {
  return scope.transaction(() => {
    const id = scope.inserer('messages', { thread_id: filId, body });
    scope.modifier('threads', filId, { last_message_at: maintenant });
    const message = lireMessage(scope, filId, id);
    if (message === undefined) throw new Error('Message introuvable après insertion.');
    return message;
  });
}

/** Modifie le corps d'un message et pose `edited_at`. */
export function modifierMessage(scope: GroupScope, filId: string, messageId: string, body: string, maintenant: string): Message | undefined {
  const modifie = scope.modifier('messages', messageId, { body, edited_at: maintenant });
  if (!modifie) return undefined;
  return lireMessage(scope, filId, messageId);
}

/** Suppression douce d'un message avec effacement du corps (modèle §3.9). */
export function supprimerMessage(scope: GroupScope, messageId: string): boolean {
  return scope.transaction(() => {
    const supprime = scope.supprimerDoux('messages', messageId);
    if (!supprime) return false;
    // Effacement après `deleted_at` pour satisfaire CHECK (deleted_at IS NOT NULL OR length(body) >= 1).
    preparer(baseDeScope(scope), "UPDATE messages SET body = '' WHERE id = ? AND group_id = ?").run(messageId, scope.groupId);
    return true;
  });
}
