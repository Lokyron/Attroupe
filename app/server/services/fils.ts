import {
  creerFilLibre,
  creerMessage,
  lireFil,
  lireMessage,
  listerFils,
  listerMessages,
  modifierMessage,
  supprimerMessage,
  type Fil,
  type Message,
  type PageMessages,
} from '../db/queries/fils.js';
import { notifierMembresGroupe } from '../db/queries/notifications.js';
import type { GroupScope } from '../db/scope.js';
import { versInstant } from '../domain/instant.js';
import type { Contexte } from '../http/contexte.js';
import { ErreurHttp } from '../http/erreurs.js';
import { libelleNotificationPush, pousserNotificationsWebPush } from './notifications.js';

// Fils de discussion et messages (modèle §3.9, architecture §6, §7.3).
// Tout passe par le GroupScope : un fil ou un message d'un autre groupe répond 404.
// La modification ou suppression d'un message d'un autre membre exige d'être administrateur du groupe (403 `droit.message_requis` APRÈS 404).

export function listerFilsDuGroupe(scope: GroupScope): Fil[] {
  return listerFils(scope);
}

export function creerFilLibreDansGroupe(scope: GroupScope, title: string): Fil {
  return creerFilLibre(scope, title);
}

export function listerMessagesDuFil(scope: GroupScope, filId: string, avant?: string, limite?: number): PageMessages {
  const fil = lireFil(scope, filId);
  if (fil === undefined) throw new ErreurHttp(404, 'fil.introuvable');
  return listerMessages(scope, filId, avant, limite);
}

export function posterMessageDansFil(contexte: Contexte, scope: GroupScope, filId: string, body: string): Message {
  const fil = lireFil(scope, filId);
  if (fil === undefined) throw new ErreurHttp(404, 'fil.introuvable');
  // 409 : un état du fil, pas un droit manquant (403 est réservé aux droits, ADR-0006).
  if (fil.is_locked) throw new ErreurHttp(409, 'fil.verrouille');

  const maintenant = versInstant(contexte.horloge());
  const payload = {
    thread_id: filId,
    ...(fil.event_id !== null ? { event_id: fil.event_id } : {}),
    ...(fil.title !== null ? { thread_title: fil.title } : {}),
  };
  const { message, destinataires } = scope.transaction(() => {
    const cree = creerMessage(scope, filId, body, maintenant);
    const lienChemin =
      fil.kind === 'event' && fil.event_id !== null
        ? `/#/groupe/${encodeURIComponent(scope.groupId)}/evenement/${encodeURIComponent(fil.event_id)}`
        : `/#/groupe/${encodeURIComponent(scope.groupId)}/fil/${encodeURIComponent(filId)}`;
    const aPousser = notifierMembresGroupe(scope, {
      kind: 'message_posted',
      subjectType: 'message',
      subjectId: cree.id,
      payload,
      baseUrl: contexte.env.ATTROUPE_BASE_URL,
      lienChemin,
      maintenant,
    });
    return { message: cree, destinataires: aPousser };
  });
  // Web Push seulement une fois la transaction validée.
  pousserNotificationsWebPush(contexte, destinataires, libelleNotificationPush('message_posted', payload));

  contexte.diffuseur.diffuser(scope, {
    type: 'message.cree',
    ressource: 'message',
    id: message.id,
    parent_id: filId,
  });
  return message;
}

function exigerFilEtMessage(scope: GroupScope, filId: string, messageId: string): Message {
  if (lireFil(scope, filId) === undefined) throw new ErreurHttp(404, 'fil.introuvable');
  const message = lireMessage(scope, filId, messageId);
  if (message === undefined) throw new ErreurHttp(404, 'message.introuvable');
  if (message.author_membership_id !== scope.membershipId && scope.role !== 'admin') {
    throw new ErreurHttp(403, 'droit.message_requis');
  }
  return message;
}

export function modifierMessageDansFil(
  contexte: Contexte,
  scope: GroupScope,
  filId: string,
  messageId: string,
  body: string,
): Message {
  exigerFilEtMessage(scope, filId, messageId);
  const maintenant = versInstant(contexte.horloge());
  const modifie = modifierMessage(scope, filId, messageId, body, maintenant);
  if (modifie === undefined) throw new ErreurHttp(404, 'message.introuvable');
  contexte.diffuseur.diffuser(scope, {
    type: 'message.modifie',
    ressource: 'message',
    id: modifie.id,
    parent_id: filId,
  });
  return modifie;
}

export function supprimerMessageDansFil(contexte: Contexte, scope: GroupScope, filId: string, messageId: string): void {
  exigerFilEtMessage(scope, filId, messageId);
  if (!supprimerMessage(scope, messageId)) throw new ErreurHttp(404, 'message.introuvable');
  contexte.diffuseur.diffuser(scope, {
    type: 'message.supprime',
    ressource: 'message',
    id: messageId,
    parent_id: filId,
  });
}
