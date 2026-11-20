import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { definirPreferenceNotification, listerMesNotifications, notifierMembresGroupe } from '../../server/db/queries/notifications.js';
import { creerPorteeUtilisateur } from '../../server/db/portee-utilisateur.js';
import { creerScope, type GroupScope } from '../../server/db/scope.js';
import type { Contexte } from '../../server/http/contexte.js';
import { JOURNAL_SILENCIEUX } from '../../server/http/middleware/journal.js';
import {
  confirmerRemboursementService,
  creerDepenseService,
  creerRemboursementService,
  modifierDepenseService,
  supprimerDepenseService,
} from '../../server/services/depenses.js';
import { creerEvenement } from '../../server/services/evenements.js';
import { libelleNotificationPush } from '../../server/services/notifications.js';
import { DiffuseurTempsReel } from '../../server/services/temps-reel.js';
import { envValide } from '../fixtures/env.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';

const T0 = '2027-03-01T12:00:00Z';

interface Membre {
  readonly userId: string;
  readonly membershipId: string;
}

// Écrire un événement ou une dépense prévient les bons membres du groupe, jamais ceux d'un autre, et rien ne reste si l'écriture échoue.
describe('notifications d’événement et de dépense (unité)', () => {
  let t: BaseTemporaire;
  let d: DeuxGroupes;
  let contexte: Contexte;
  let carole: Membre;
  let erin: Membre;
  let zoe: Membre;
  let inactif: Membre;

  function ajouterMembre(groupId: string, id: string, status: 'active' | 'removed'): Membre {
    const userId = `u-${id}`;
    const membershipId = `m-${id}`;
    t.sql
      .prepare(
        `INSERT INTO users (id, email, email_verified_at, password_hash, username, display_name, created_at, updated_at)
         VALUES (?, ?, ?, 'h', ?, ?, ?, ?)`,
      )
      .run(userId, `${id}@exemple.test`, T0, id, id, T0, T0);
    t.sql
      .prepare(
        `INSERT INTO memberships (id, group_id, user_id, role, status, joined_at, ended_at, created_at, updated_at)
         VALUES (?, ?, ?, 'member', ?, ?, ?, ?, ?)`,
      )
      .run(membershipId, groupId, userId, status, T0, status === 'active' ? null : T0, T0, T0);
    return { userId, membershipId };
  }

  const nonLues = (userId: string): number => listerMesNotifications(creerPorteeUtilisateur(t.base, userId)).non_lues;
  const emails = (): Array<{ to_email: string; template_key: string; payload_json: string }> =>
    t.sql.prepare('SELECT to_email, template_key, payload_json FROM email_outbox ORDER BY to_email, template_key').all() as Array<{
      to_email: string;
      template_key: string;
      payload_json: string;
    }>;

  const champsEvenement = {
    title: 'Barbecue',
    description: null,
    location_name: null,
    location_address: null,
    location_lat: null,
    location_lon: null,
    all_day: false,
    starts_at: '2027-04-01T18:00:00Z',
    ends_at: null,
    time_zone: 'Europe/Paris',
    arrival_note: null,
    host_membership_id: null,
    currency_code: null,
    capacity: null,
  };

  function depense(scope: GroupScope, payer: string, shares: Array<{ membership_id: string; share_minor?: number }>, mode: 'equal' | 'exact' = 'equal') {
    return creerDepenseService(contexte, scope, {
      event_id: null,
      label: 'Courses secrètes',
      spent_on: '2027-03-01',
      payer_membership_id: payer,
      amount_minor: 12_345,
      currency_code: 'EUR',
      split_mode: mode,
      note: null,
      shares,
    });
  }

  beforeEach(() => {
    t = baseTemporaire();
    d = deuxGroupes(t.base);
    const horloge = (): Date => new Date(T0);
    contexte = {
      base: t.base,
      env: envValide({ ATTROUPE_BASE_URL: 'https://attroupe.exemple.test' }),
      journal: JOURNAL_SILENCIEUX,
      horloge,
      diffuseur: new DiffuseurTempsReel({ horloge }),
    } as unknown as Contexte;
    t.sql.prepare('UPDATE users SET email_verified_at = ?').run(T0);
    carole = ajouterMembre(d.a.groupId, 'carole', 'active');
    erin = ajouterMembre(d.a.groupId, 'erin', 'active');
    zoe = ajouterMembre(d.a.groupId, 'zoe', 'active');
    inactif = ajouterMembre(d.a.groupId, 'inactif', 'removed');
  });
  afterEach(() => {
    contexte.diffuseur.fermerTout();
    t.nettoyer();
  });

  it('un événement créé notifie les autres membres actifs, ni l’auteur, ni un membre retiré, ni un autre groupe', () => {
    creerEvenement(contexte, d.scopeA, champsEvenement);

    expect(nonLues(carole.userId)).toBe(1);
    expect(nonLues(erin.userId)).toBe(1);
    expect(nonLues(zoe.userId)).toBe(1);
    expect(nonLues(d.a.userId)).toBe(0);
    expect(nonLues(inactif.userId)).toBe(0);
    expect(nonLues(d.b.userId)).toBe(0);

    const notif = listerMesNotifications(creerPorteeUtilisateur(t.base, carole.userId)).notifications[0];
    expect(notif).toMatchObject({ kind: 'event_created', subject_type: 'event', group_id: d.a.groupId });
    expect(notif?.payload).toEqual({ event_id: notif?.subject_id });
  });

  it('un événement ne met en file que le gabarit « événement », sans titre ni lieu', () => {
    creerEvenement(contexte, d.scopeA, { ...champsEvenement, title: 'Titre confidentiel' });
    const envoyes = emails();
    expect(envoyes.map((e) => e.to_email)).toEqual(['carole@exemple.test', 'erin@exemple.test', 'zoe@exemple.test']);
    for (const e of envoyes) {
      expect(e.template_key).toBe('notification_evenement');
      expect(e.payload_json).not.toContain('Titre confidentiel');
    }
  });

  it('une dépense ne notifie que le payeur et les porteurs d’une part, moins l’auteur', () => {
    // Alice (auteure) saisit : Carole a payé, la dépense est partagée entre Alice et Erin. Zoé n’est pas concernée.
    depense(d.scopeA, carole.membershipId, [{ membership_id: d.a.membershipId }, { membership_id: erin.membershipId }]);

    expect(nonLues(carole.userId)).toBe(1);
    expect(nonLues(erin.userId)).toBe(1);
    expect(nonLues(d.a.userId)).toBe(0);
    expect(nonLues(zoe.userId)).toBe(0);
    expect(nonLues(inactif.userId)).toBe(0);
    expect(nonLues(d.b.userId)).toBe(0);

    const notif = listerMesNotifications(creerPorteeUtilisateur(t.base, erin.userId)).notifications[0];
    expect(notif).toMatchObject({ kind: 'expense_added', subject_type: 'expense', group_id: d.a.groupId });
    expect(emails().map((e) => [e.to_email, e.template_key])).toEqual([
      ['carole@exemple.test', 'notification_depense'],
      ['erin@exemple.test', 'notification_depense'],
    ]);
  });

  it('une part nulle ne « concerne » pas : un montant exact de 0 n’est pas prévenu', () => {
    depense(
      d.scopeA,
      d.a.membershipId,
      [
        { membership_id: erin.membershipId, share_minor: 12_345 },
        { membership_id: zoe.membershipId, share_minor: 0 },
      ],
      'exact',
    );
    expect(nonLues(erin.userId)).toBe(1);
    expect(nonLues(zoe.userId)).toBe(0);
    expect(nonLues(carole.userId)).toBe(0);
  });

  it('une dépense que l’auteur paie et porte seul ne prévient personne', () => {
    depense(d.scopeA, d.a.membershipId, [{ membership_id: d.a.membershipId }]);
    expect(t.sql.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 0 });
    expect(emails()).toEqual([]);
  });

  it('le montant, le libellé et la note de la dépense ne figurent ni dans la notification ni dans l’e-mail', () => {
    depense(d.scopeA, carole.membershipId, [{ membership_id: erin.membershipId }]);
    const traces = JSON.stringify([
      t.sql.prepare('SELECT payload_json FROM notifications').all(),
      t.sql.prepare('SELECT payload_json FROM email_outbox').all(),
      libelleNotificationPush('expense_added', {}),
    ]);
    expect(traces).not.toContain('Courses secrètes');
    expect(traces).not.toContain('12345');
    expect(traces).not.toContain('123,45');
  });

  it('respecte immediate / daily / off comme pour les messages', () => {
    definirPreferenceNotification(creerPorteeUtilisateur(t.base, carole.userId), d.a.groupId, 'immediate');
    definirPreferenceNotification(creerPorteeUtilisateur(t.base, erin.userId), d.a.groupId, 'daily');
    definirPreferenceNotification(creerPorteeUtilisateur(t.base, zoe.userId), '*', 'off');

    creerEvenement(contexte, d.scopeA, champsEvenement);
    depense(d.scopeA, carole.membershipId, [{ membership_id: erin.membershipId }, { membership_id: zoe.membershipId }]);

    // Les trois reçoivent la notification en application ; seule Carole (immediate) a un e-mail, pour l’événement ET la dépense.
    expect(nonLues(carole.userId)).toBe(2);
    expect(nonLues(erin.userId)).toBe(2);
    expect(nonLues(zoe.userId)).toBe(2);
    expect(emails().map((e) => [e.to_email, e.template_key])).toEqual([
      ['carole@exemple.test', 'notification_depense'],
      ['carole@exemple.test', 'notification_evenement'],
    ]);
  });

  it('rien n’est écrit si l’écriture métier échoue (événement et dépense refusés)', () => {
    expect(() => creerEvenement(contexte, d.scopeA, { ...champsEvenement, host_membership_id: 'm-inexistant' })).toThrow(/membre\.introuvable/);
    expect(() => depense(d.scopeA, inactif.membershipId, [{ membership_id: erin.membershipId }])).toThrow(/membre\.inactif/);
    expect(t.sql.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 0 });
    expect(emails()).toEqual([]);
  });

  it('une notification qui échoue annule aussi l’écriture métier : une seule transaction', () => {
    t.sql.exec("CREATE TRIGGER refuse_courriel BEFORE INSERT ON email_outbox BEGIN SELECT RAISE(ABORT, 'courriel refusé'); END");
    const avantEvenements = t.sql.prepare('SELECT COUNT(*) AS n FROM events').get();
    const avantDepenses = t.sql.prepare('SELECT COUNT(*) AS n FROM expenses').get();

    expect(() => creerEvenement(contexte, d.scopeA, champsEvenement)).toThrow(/courriel refusé/);
    expect(() => depense(d.scopeA, carole.membershipId, [{ membership_id: erin.membershipId }])).toThrow(/courriel refusé/);

    expect(t.sql.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual(avantEvenements);
    expect(t.sql.prepare('SELECT COUNT(*) AS n FROM expenses').get()).toEqual(avantDepenses);
    expect(t.sql.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 0 });
  });

  it('cloisonnement : un identifiant de membre d’un autre groupe, même forgé, ne reçoit rien', () => {
    const options = {
      kind: 'expense_added',
      subjectType: 'expense',
      subjectId: 'x',
      payload: {},
      baseUrl: 'https://attroupe.exemple.test',
      lienChemin: '/#/x',
      maintenant: T0,
    } as const;

    // Bob (groupe B) désigné comme destinataire dans une diffusion du groupe A : personne ne reçoit rien.
    expect(notifierMembresGroupe(d.scopeA, { ...options, destinataires: new Set([d.b.membershipId]) })).toEqual([]);
    expect(nonLues(d.b.userId)).toBe(0);

    // Mélange légitime + forgé : seule Carole (groupe A) est notifiée.
    const aPousser = notifierMembresGroupe(d.scopeA, { ...options, destinataires: new Set([carole.membershipId, d.b.membershipId]) });
    expect(aPousser.map((p) => p.compteId)).toEqual([carole.userId]);
    expect(nonLues(carole.userId)).toBe(1);
    expect(nonLues(d.b.userId)).toBe(0);

    // Symétrique : une diffusion du groupe B ne touche pas Carole, même désignée.
    expect(notifierMembresGroupe(d.scopeB, { ...options, destinataires: new Set([carole.membershipId]) })).toEqual([]);
    expect(nonLues(carole.userId)).toBe(1);
  });

  it('cloisonnement via la dépense : un payeur ou un porteur de part d’un autre groupe est refusé et ne reçoit rien', () => {
    const scopeCarole = creerScope(t.base, carole.userId, d.a.groupId);
    expect(() => depense(scopeCarole, d.b.membershipId, [{ membership_id: erin.membershipId }])).toThrow(/membre\.introuvable/);
    expect(() => depense(scopeCarole, erin.membershipId, [{ membership_id: d.b.membershipId }])).toThrow(/membre\.introuvable/);
    expect(nonLues(d.b.userId)).toBe(0);
    expect(t.sql.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 0 });
  });

  it('le texte du Web Push vient de i18n/fr.json et ne dit rien du contenu', () => {
    expect(libelleNotificationPush('event_created', {})).toBe('Nouvel événement dans le groupe');
    expect(libelleNotificationPush('expense_added', {})).toBe('Une dépense vous concerne');
    expect(libelleNotificationPush('expense_updated', {})).toBe('Une dépense qui vous concerne a été modifiée');
    expect(libelleNotificationPush('expense_deleted', {})).toBe('Une dépense qui vous concerne a été supprimée');
    expect(libelleNotificationPush('settlement_created', {})).toBe('Un règlement attend votre confirmation');
    expect(libelleNotificationPush('settlement_confirmed', {})).toBe('Votre règlement a été confirmé');
  });

  it('muted_kinds coupe une catégorie de notification sans couper les autres (groupe prime sur global)', () => {
    // Carole coupe expense_added au niveau global ('*')
    t.sql
      .prepare(
        `INSERT INTO notification_preferences (user_id, group_id, channel_email, digest, muted_kinds, created_at, updated_at)
         VALUES (?, '*', 1, 'instant', '["expense_added"]', ?, ?)`,
      )
      .run(carole.userId, T0, T0);
    // Erin coupe expense_added au niveau global, mais le réactive (tableau vide) pour le groupe A
    t.sql
      .prepare(
        `INSERT INTO notification_preferences (user_id, group_id, channel_email, digest, muted_kinds, created_at, updated_at)
         VALUES (?, '*', 1, 'instant', '["expense_added"]', ?, ?),
                (?, ?, 1, 'instant', '[]', ?, ?)`,
      )
      .run(erin.userId, T0, T0, erin.userId, d.a.groupId, T0, T0);

    depense(d.scopeA, d.a.membershipId, [{ membership_id: carole.membershipId }, { membership_id: erin.membershipId }]);
    expect(nonLues(carole.userId)).toBe(0);
    expect(nonLues(erin.userId)).toBe(1);
    expect(emails().filter((e) => e.to_email === 'carole@exemple.test')).toHaveLength(0);

    // Un événement reste bien notifié à Carole
    creerEvenement(contexte, d.scopeA, champsEvenement);
    expect(nonLues(carole.userId)).toBe(1);
  });

  it('modifier et supprimer une dépense notifient les membres concernés (anciens et nouveaux)', () => {
    const creee = depense(d.scopeA, d.a.membershipId, [{ membership_id: carole.membershipId }]);
    expect(nonLues(carole.userId)).toBe(1);
    expect(nonLues(erin.userId)).toBe(0);

    // Alice retire Carole et ajoute Erin : les deux sont prévenues de la modification
    modifierDepenseService(contexte, d.scopeA, creee.id, {
      shares: [{ membership_id: erin.membershipId }],
    });
    expect(nonLues(carole.userId)).toBe(2);
    expect(nonLues(erin.userId)).toBe(1);
    const notifModif = listerMesNotifications(creerPorteeUtilisateur(t.base, erin.userId)).notifications[0];
    expect(notifModif).toMatchObject({ kind: 'expense_updated', subject_type: 'expense', subject_id: creee.id });

    // Alice supprime la dépense : Erin (concernée au moment de la suppression) est notifiée
    supprimerDepenseService(contexte, d.scopeA, creee.id);
    expect(nonLues(erin.userId)).toBe(2);
    const notifSuppr = listerMesNotifications(creerPorteeUtilisateur(t.base, erin.userId)).notifications[0];
    expect(notifSuppr).toMatchObject({ kind: 'expense_deleted', subject_type: 'expense', subject_id: creee.id });
  });

  it('créer puis confirmer un règlement notifient respectivement le bénéficiaire puis le payeur', () => {
    const reglement = creerRemboursementService(contexte, d.scopeA, {
      event_id: null,
      from_membership_id: d.a.membershipId,
      to_membership_id: carole.membershipId,
      amount_minor: 5000,
      currency_code: 'EUR',
      settled_on: '2027-03-01',
      method_note: null,
    });
    expect(nonLues(carole.userId)).toBe(1);
    expect(nonLues(d.a.userId)).toBe(0);
    expect(listerMesNotifications(creerPorteeUtilisateur(t.base, carole.userId)).notifications[0]).toMatchObject({
      kind: 'settlement_created',
      subject_type: 'settlement',
      subject_id: reglement.id,
    });

    const scopeCarole = creerScope(t.base, carole.userId, d.a.groupId);
    confirmerRemboursementService(contexte, scopeCarole, reglement.id);
    expect(nonLues(d.a.userId)).toBe(1);
    expect(listerMesNotifications(creerPorteeUtilisateur(t.base, d.a.userId)).notifications[0]).toMatchObject({
      kind: 'settlement_confirmed',
      subject_type: 'settlement',
      subject_id: reglement.id,
    });
  });
});
