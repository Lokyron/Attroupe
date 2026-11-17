import { appeler, booleen, champ, liste, texte, texteOuNul } from './client';

export interface Fil {
  id: string;
  event_id: string | null;
  title: string | null;
  kind: 'event' | 'free';
  is_locked: boolean;
  last_message_at: string | null;
  created_by_membership_id: string;
  created_at: string;
  updated_at: string;
  event_title: string | null;
}

export interface Message {
  id: string;
  thread_id: string;
  author_membership_id: string;
  author_name: string;
  body: string;
  reply_to_message_id: string | null;
  created_at: string;
  edited_at: string | null;
}

export interface PageMessages {
  messages: Message[];
  suivant: string | null;
}

function fil(f: unknown): Fil {
  const kind = champ(f, 'kind');
  if (kind !== 'event' && kind !== 'free') throw new Error('Genre de fil inconnu.');
  return {
    id: texte(champ(f, 'id')),
    event_id: texteOuNul(champ(f, 'event_id')),
    title: texteOuNul(champ(f, 'title')),
    kind,
    is_locked: booleen(champ(f, 'is_locked')),
    last_message_at: texteOuNul(champ(f, 'last_message_at')),
    created_by_membership_id: texte(champ(f, 'created_by_membership_id')),
    created_at: texte(champ(f, 'created_at')),
    updated_at: texte(champ(f, 'updated_at')),
    event_title: texteOuNul(champ(f, 'event_title')),
  };
}

function message(m: unknown): Message {
  return {
    id: texte(champ(m, 'id')),
    thread_id: texte(champ(m, 'thread_id')),
    author_membership_id: texte(champ(m, 'author_membership_id')),
    author_name: texte(champ(m, 'author_name')),
    body: texte(champ(m, 'body')),
    reply_to_message_id: texteOuNul(champ(m, 'reply_to_message_id')),
    created_at: texte(champ(m, 'created_at')),
    edited_at: texteOuNul(champ(m, 'edited_at')),
  };
}

export async function listerFils(groupId: string): Promise<Fil[]> {
  const r = await appeler('GET', `/api/groupes/${encodeURIComponent(groupId)}/fils`);
  return liste(champ(r, 'fils')).map(fil);
}

export async function creerFilLibre(groupId: string, title: string): Promise<Fil> {
  const r = await appeler('POST', `/api/groupes/${encodeURIComponent(groupId)}/fils`, { title });
  return fil(r);
}

export async function listerMessages(groupId: string, filId: string, avant?: string): Promise<PageMessages> {
  const requete = avant === undefined ? '' : `?avant=${encodeURIComponent(avant)}`;
  const r = await appeler('GET', `/api/groupes/${encodeURIComponent(groupId)}/fils/${encodeURIComponent(filId)}/messages${requete}`);
  return {
    messages: liste(champ(r, 'messages')).map(message),
    suivant: texteOuNul(champ(r, 'suivant')),
  };
}

export async function posterMessage(groupId: string, filId: string, body: string): Promise<Message> {
  const r = await appeler('POST', `/api/groupes/${encodeURIComponent(groupId)}/fils/${encodeURIComponent(filId)}/messages`, { body });
  return message(r);
}

export async function modifierMessage(groupId: string, filId: string, messageId: string, body: string): Promise<Message> {
  const r = await appeler(
    'PATCH',
    `/api/groupes/${encodeURIComponent(groupId)}/fils/${encodeURIComponent(filId)}/messages/${encodeURIComponent(messageId)}`,
    { body },
  );
  return message(r);
}

export async function supprimerMessage(groupId: string, filId: string, messageId: string): Promise<void> {
  await appeler(
    'DELETE',
    `/api/groupes/${encodeURIComponent(groupId)}/fils/${encodeURIComponent(filId)}/messages/${encodeURIComponent(messageId)}`,
  );
}
