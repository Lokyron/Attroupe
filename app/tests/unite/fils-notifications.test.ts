import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  creerFilLibre,
  creerMessage,
  lireFil,
  listerFils,
  listerMessages,
  modifierMessage,
  supprimerMessage,
} from '../../server/db/queries/fils.js';
import {
  definirPreferenceNotification,
  envoyerResumesQuotidiens,
  lirePreferencesNotifications,
  listerMesNotifications,
  marquerNotificationsLues,
} from '../../server/db/queries/notifications.js';
import { creerPorteeUtilisateur } from '../../server/db/portee-utilisateur.js';
import { creerScope } from '../../server/db/scope.js';
import type { Contexte } from '../../server/http/contexte.js';
import {
  modifierMessageDansFil,
  posterMessageDansFil,
  supprimerMessageDansFil,
} from '../../server/services/fils.js';
import { JOURNAL_SILENCIEUX } from '../../server/http/middleware/journal.js';
import { libelleNotificationPush } from '../../server/services/notifications.js';
import { DiffuseurTempsReel } from '../../server/services/temps-reel.js';
import { envValide } from '../fixtures/env.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';

function creerContexteTest(base: BaseTemporaire['base'], horloge: () => Date): Contexte {
  return {
    base,
    env: envValide({ ATTROUPE_BASE_URL: 'https://attroupe.exemple.test' }),
    journal: JOURNAL_SILENCIEUX,
    horloge,
    diffuseur: new DiffuseurTempsReel({ horloge }),
  } as unknown as Contexte;
}

describe('fils de discussion libres, messages et notifications (unité)', () => {
  let t: BaseTemporaire;
  let d: DeuxGroupes;

  beforeEach(() => {
    t = baseTemporaire();
    d = deuxGroupes(t.base);
  });
  afterEach(() => t.nettoyer());

  it('crée des fils libres, trie par dernière activité et pagine les messages par curseur', () => {
    const scopeAlice = d.scopeA;
    const fil1 = creerFilLibre(scopeAlice, 'Premier fil');
    const fil2 = creerFilLibre(scopeAlice, 'Deuxième fil');

    const m1 = creerMessage(scopeAlice, fil1.id, 'Msg 1', '2027-03-01T10:00:00Z');
    const m2 = creerMessage(scopeAlice, fil1.id, 'Msg 2', '2027-03-01T10:01:00Z');
    const m3 = creerMessage(scopeAlice, fil1.id, 'Msg 3', '2027-03-01T10:02:00Z');
    creerMessage(scopeAlice, fil2.id, 'Msg fil2', '2027-03-01T10:05:00Z');

    const liste = listerFils(scopeAlice);
    expect(liste[0]?.id).toBe(fil2.id);
    expect(liste[1]?.id).toBe(fil1.id);

    const page1 = listerMessages(scopeAlice, fil1.id, undefined, 2);
    expect(page1.messages.map((m) => m.id)).toEqual([m2.id, m3.id]);
    expect(page1.suivant).toBe(m2.id);

    const page2 = listerMessages(scopeAlice, fil1.id, page1.suivant ?? undefined, 2);
    expect(page2.messages.map((m) => m.id)).toEqual([m1.id]);
    expect(page2.suivant).toBeNull();
  });

  it('efface le corps lors de la suppression douce d’un message (modèle §3.9)', () => {
    const scopeAlice = d.scopeA;
    const fil = creerFilLibre(scopeAlice, 'Sujet');
    const msg = creerMessage(scopeAlice, fil.id, 'Texte confidentiel', '2027-03-01T10:00:00Z');

    const mod = modifierMessage(scopeAlice, fil.id, msg.id, 'Texte édité', '2027-03-01T10:01:00Z');
    expect(mod?.body).toBe('Texte édité');
    expect(mod?.edited_at).toBe('2027-03-01T10:01:00Z');

    expect(supprimerMessage(scopeAlice, msg.id)).toBe(true);
    const brut = t.sql.prepare('SELECT body, deleted_at FROM messages WHERE id = ?').get(msg.id) as {
      body: string;
      deleted_at: string | null;
    };
    expect(brut.body).toBe('');
    expect(brut.deleted_at).not.toBeNull();
  });

  it('applique les droits de modification/suppression (auteur ou admin → 403 sinon, 404 hors groupe)', () => {
    const contexte = creerContexteTest(t.base, () => new Date('2027-03-01T12:00:00Z'));
    const scopeAlice = d.scopeA;
    const scopeBob = d.scopeB;

    // Ajout d'un simple membre dans A : Carole
    t.sql
      .prepare("INSERT INTO users (id, email, email_verified_at, password_hash, username, display_name, created_at, updated_at) VALUES ('u-carole', 'carole@exemple.test', '2027-01-01T00:00:00Z', 'h', 'carole_u', 'Carole', '2027-01-01T00:00:00Z', '2027-01-01T00:00:00Z')")
      .run();
    t.sql
      .prepare("INSERT INTO memberships (id, group_id, user_id, role, status, joined_at, created_at, updated_at) VALUES ('m-carole', ?, 'u-carole', 'member', 'active', '2027-01-01T00:00:00Z', '2027-01-01T00:00:00Z', '2027-01-01T00:00:00Z')")
      .run(d.a.groupId);
    const scopeCarole = creerScope(t.base, 'u-carole', d.a.groupId);

    const filA = creerFilLibre(scopeAlice, 'Fil A');
    const msgAlice = posterMessageDansFil(contexte, scopeAlice, filA.id, 'Message Alice');

    expect(() => modifierMessageDansFil(contexte, scopeCarole, filA.id, msgAlice.id, 'Pirate')).toThrow(/droit\.message_requis/);
    expect(() => supprimerMessageDansFil(contexte, scopeCarole, filA.id, msgAlice.id)).toThrow(/droit\.message_requis/);
    expect(() => modifierMessageDansFil(contexte, scopeBob, filA.id, msgAlice.id, 'Pirate')).toThrow(/fil\.introuvable/);
    expect(lireFil(scopeBob, filA.id)).toBeUndefined();

    // Carole poste un message : Alice (admin de A) peut le supprimer
    const msgCarole = posterMessageDansFil(contexte, scopeCarole, filA.id, 'Message Carole');
    supprimerMessageDansFil(contexte, scopeAlice, filA.id, msgCarole.id);
    expect(listerMessages(scopeAlice, filA.id).messages.map((m) => m.id)).toEqual([msgAlice.id]);
  });

  it('notifie uniquement les membres actifs du groupe, respecte immediate/daily/off et envoie le résumé quotidien à 19 h', () => {
    let maintenant = new Date('2027-03-01T12:00:00Z'); // 13 h à Europe/Paris
    const contexte = creerContexteTest(t.base, () => maintenant);

    // Ajoute 3 membres à A avec des préférences différentes + adresses vérifiées
    t.sql.prepare('UPDATE users SET email_verified_at = ?').run('2027-01-01T00:00:00Z');
    for (const [uid, mid, nom] of [
      ['u-imm', 'm-imm', 'Immediat'],
      ['u-day', 'm-day', 'Quotidien'],
      ['u-off', 'm-off', 'Desactive'],
    ] as const) {
      t.sql
        .prepare("INSERT INTO users (id, email, email_verified_at, password_hash, username, display_name, created_at, updated_at) VALUES (?, ?, '2027-01-01T00:00:00Z', 'h', ?, ?, '2027-01-01T00:00:00Z', '2027-01-01T00:00:00Z')")
        .run(uid, `${uid}@exemple.test`, uid, nom);
      t.sql
        .prepare("INSERT INTO memberships (id, group_id, user_id, role, status, joined_at, created_at, updated_at) VALUES (?, ?, ?, 'member', 'active', '2027-01-01T00:00:00Z', '2027-01-01T00:00:00Z', '2027-01-01T00:00:00Z')")
        .run(mid, d.a.groupId, uid);
    }

    const porteeImm = creerPorteeUtilisateur(t.base, 'u-imm');
    const porteeDay = creerPorteeUtilisateur(t.base, 'u-day');
    const porteeOff = creerPorteeUtilisateur(t.base, 'u-off');
    const porteeBob = creerPorteeUtilisateur(t.base, d.b.userId);
    const porteeAlice = creerPorteeUtilisateur(t.base, d.a.userId);

    expect(definirPreferenceNotification(porteeImm, d.b.groupId, 'off')).toBe('groupe_introuvable');
    definirPreferenceNotification(porteeImm, d.a.groupId, 'immediate');
    definirPreferenceNotification(porteeDay, d.a.groupId, 'daily');
    definirPreferenceNotification(porteeOff, '*', 'off');
    expect(lirePreferencesNotifications(porteeDay).find((p) => p.group_id === d.a.groupId)?.email_mode).toBe('daily');

    const scopeAlice = d.scopeA;
    const filA = creerFilLibre(scopeAlice, 'Fil notifs');
    posterMessageDansFil(contexte, scopeAlice, filA.id, 'Secret du message qui ne doit pas fuiter dans le mail');

    // Alice (auteure) et Bob (groupe B) n'ont reçu aucune notification
    expect(listerMesNotifications(porteeAlice).non_lues).toBe(0);
    expect(listerMesNotifications(porteeBob).non_lues).toBe(0);

    // Les trois membres actifs de A ont chacun 1 notification en base
    expect(listerMesNotifications(porteeImm).non_lues).toBe(1);
    expect(listerMesNotifications(porteeDay).non_lues).toBe(1);
    expect(listerMesNotifications(porteeOff).non_lues).toBe(1);

    // Seul u-imm a un e-mail immédiat en file, et le corps du message n'y figure pas
    const emailsImmediats = t.sql.prepare('SELECT to_email, template_key, payload_json FROM email_outbox').all() as Array<{
      to_email: string;
      template_key: string;
      payload_json: string;
    }>;
    expect(emailsImmediats).toHaveLength(1);
    expect(emailsImmediats[0]?.to_email).toBe('u-imm@exemple.test');
    expect(emailsImmediats[0]?.template_key).toBe('notification_immediate');
    expect(emailsImmediats[0]?.payload_json).not.toContain('Secret du message');

    // Avant 19 h dans le fuseau du groupe (13 h Paris) : aucun résumé quotidien envoyé
    expect(envoyerResumesQuotidiens(t.base, 'https://attroupe.exemple.test', maintenant)).toBe(0);

    // À 19 h dans le fuseau Europe/Paris (18:00Z en mars) : le résumé quotidien part pour u-day
    maintenant = new Date('2027-03-01T18:05:00Z');
    expect(envoyerResumesQuotidiens(t.base, 'https://attroupe.exemple.test', maintenant)).toBe(1);
    // Un second appel ne ré-envoie pas la même notification
    expect(envoyerResumesQuotidiens(t.base, 'https://attroupe.exemple.test', maintenant)).toBe(0);

    const resumes = t.sql
      .prepare("SELECT to_email, template_key FROM email_outbox WHERE template_key = 'resume_quotidien'")
      .all() as Array<{ to_email: string; template_key: string }>;
    expect(resumes).toEqual([{ to_email: 'u-day@exemple.test', template_key: 'resume_quotidien' }]);

    // Marquer comme lu
    expect(marquerNotificationsLues(porteeDay, undefined, '2027-03-01T18:10:00Z')).toBe(1);
    expect(listerMesNotifications(porteeDay).non_lues).toBe(0);
  });

  it('un fil verrouillé répond 409 (état du fil), pas 403 (droit manquant)', () => {
    const contexte = creerContexteTest(t.base, () => new Date('2027-03-01T12:00:00Z'));
    const fil = creerFilLibre(d.scopeA, 'Fil figé');
    t.sql.prepare('UPDATE threads SET is_locked = 1 WHERE id = ?').run(fil.id);
    expect(() => posterMessageDansFil(contexte, d.scopeA, fil.id, 'Trop tard')).toThrow(expect.objectContaining({ statut: 409, message: 'fil.verrouille' }));
  });

  it('le texte du Web Push vient des clés que posterMessageDansFil fournit (thread_title)', () => {
    expect(libelleNotificationPush('message_posted', { thread_id: 'f1', thread_title: 'Sortie vélo' })).toBe('Nouveau message dans « Sortie vélo »');
    expect(libelleNotificationPush('message_posted', { thread_id: 'f1' })).toBe('Nouveau message dans le groupe');
    expect(libelleNotificationPush('event_created', {})).toBe('Nouvelle activité dans le groupe');
  });

  it('db/ n’importe plus le service d’envoi Web Push (aucun appel réseau depuis la couche données)', () => {
    const racine = join(__dirname, '../../server/db');
    const fichiers = (dossier: string): string[] =>
      readdirSync(dossier, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? fichiers(join(dossier, e.name)) : e.name.endsWith('.ts') ? [join(dossier, e.name)] : []));
    const fautifs = fichiers(racine).filter((f) => /from '(\.\.\/)+services\/push\.js'/.test(readFileSync(f, 'utf8')));
    expect(fautifs).toEqual([]);
  });
});
