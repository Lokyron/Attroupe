import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mesGroupes } from '../../server/db/queries/transverse.js';
import {
  diagnostiquer,
  ErreurRequeteSansGroupe,
  preparer,
  preparerTransverse,
  TEXTES_TRANSVERSES,
} from '../../server/db/sql.js';
import { creerPorteeUtilisateur } from '../../server/db/portee-utilisateur.js';
import { creerScope, DESCRIPTION_TABLES, type TableMetier } from '../../server/db/scope.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire } from '../fixtures/base.js';
import { listerFichiers } from '../fixtures/lister.js';

// Verrou n° 5 : la garde du SQL brut exige un FILTRE LIÉ, pas la simple mention de `group_id`.
describe('garde du SQL brut (db/sql.ts)', () => {
  let t: BaseTemporaire;
  beforeAll(() => {
    t = baseTemporaire();
  });
  afterAll(() => t.nettoyer());

  describe('refuse', () => {
    it.each([
      // L'exemple de la revue : un alias qui imite la colonne ne vaut pas un filtre.
      ['alias imitant group_id (cas de la revue)', 'SELECT *, NULL AS group_id FROM events WHERE id = ?'],
      ['alias imitant group_id, sans AS', 'SELECT *, NULL group_id FROM events WHERE id = ?'],
      ['alias imitant group_id derrière un filtre', 'SELECT *, NULL AS group_id FROM events WHERE group_id = ?'],
      ['colonne comparée à elle-même', 'SELECT * FROM events WHERE group_id = group_id'],
      ['valeur littérale à la place du paramètre lié', "SELECT * FROM events WHERE group_id = 'gB'"],
      ['filtre noyé dans une disjonction', 'SELECT * FROM events WHERE group_id = ? OR 1 = 1'],
      ['filtre dans un appel de fonction', 'SELECT * FROM events WHERE iif(group_id = ?, 1, 1)'],
      ['négation', 'SELECT * FROM events WHERE NOT (group_id = ?)'],
      ['UNION', 'SELECT * FROM events WHERE group_id = ? UNION SELECT * FROM events WHERE group_id = ?'],
      ['sous-requête de portée comparée (a)', 'SELECT id, group_id FROM events WHERE (group_id = ?) = 0'],
      ['filtre dans la liste de sélection', 'SELECT 1 AND group_id = ? FROM events'],
      ['filtre dans une parenthèse comparée', 'SELECT * FROM events WHERE 0 = (title = ? AND group_id = ?)'],
      ['BETWEEN et son faux AND', 'SELECT * FROM events WHERE starts_at BETWEEN ? AND group_id = ?'],
      ['id = ? nu sur groups', 'SELECT * FROM groups WHERE id = ?'],
      ['CASE dans le WHERE', 'SELECT * FROM events WHERE CASE WHEN 1 AND group_id = ? AND 1 THEN 1 ELSE 1 END'],
      ['upsert sans garde de portée (f)', 'INSERT INTO events (id, group_id, title) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET title = excluded.title'],
      ['alias réutilisé (d)', 'SELECT * FROM memberships e JOIN events e ON e.group_id = ?'],
      ['NOT EXISTS', 'SELECT * FROM events WHERE group_id = ? AND NOT EXISTS (SELECT 1 FROM messages WHERE group_id = ?)'],
      ['sous-requête sur la même table', 'SELECT * FROM events WHERE id IN (SELECT id FROM events) AND group_id = ?'],
      ['filtre dans la sous-requête seulement', 'SELECT * FROM events WHERE id IN (SELECT event_id FROM shopping_lists WHERE group_id = ?)'],
      ['jointure externe', 'SELECT * FROM events e LEFT JOIN users u ON e.group_id = ?'],
      ['commentaire', 'SELECT * FROM events WHERE group_id = ? -- AND 1'],
      ['commentaire /* */', 'SELECT * FROM events WHERE group_id = ? /* x */'],
      ['identifiant entre crochets', 'SELECT * FROM [events] WHERE group_id = ?'],
      ['identifiant entre guillemets', 'SELECT * FROM "events" WHERE group_id = ?'],
      ['identifiant entre accents graves', 'SELECT * FROM `events` WHERE group_id = ?'],
      ['deux ordres', 'SELECT * FROM events WHERE group_id = ?; DELETE FROM events'],
      ['modification de la portée', 'UPDATE events SET group_id = ? WHERE group_id = ?'],
      ['insertion sans la colonne de portée', 'INSERT INTO events (id, title) VALUES (?, ?)'],
      ['mise à jour sans filtre', 'UPDATE expenses SET label = ? WHERE id = ?'],
      ['suppression sans filtre', 'DELETE FROM messages WHERE id = ?'],
      ['memberships par user_id seul (réservé au canal transverse)', 'SELECT * FROM memberships WHERE user_id = ?'],
      ['personal_events par identifiant seul (titres privés)', 'SELECT * FROM personal_events WHERE id = ?'],
      ['personal_events par group_id (il n’en a pas)', 'SELECT * FROM personal_events WHERE group_id = ?'],
      ['liste de courses sans filtre', 'select * from Shopping_Items where id = ?'],
      ['groups sans identifiant lié', 'SELECT name FROM groups'],
      // Exception n° 1 : seule la forme « colonnes + VALUES » est admise pour groups.
      ['insertion dans groups sans liste de colonnes', 'INSERT INTO groups VALUES (?, ?)'],
      ['insertion dans groups par SELECT', 'INSERT INTO groups (id, name) SELECT id, name FROM groups WHERE id = ?'],
      ['insertion dans groups avec ON CONFLICT', 'INSERT INTO groups (id, name) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name'],
      ['insertion dans une autre table racine non nommée (users reste libre, mais pas invitations sans group_id)', 'INSERT INTO invitations (id, kind) VALUES (?, ?)'],
      // Exceptions n° 2 et 3 : jamais d'invitation sans preuve d'accès LIÉE.
      ['invitations par id seul (sans preuve)', 'SELECT * FROM invitations WHERE id = ?'],
      ['invitations sans aucun filtre', 'SELECT * FROM invitations'],
      ['target_user_id littéral', "SELECT * FROM invitations WHERE target_user_id = 'u1'"],
      ['target_user_id comparé à une colonne', 'SELECT * FROM invitations WHERE target_user_id = id'],
      ['target_user_id dans une disjonction', 'SELECT * FROM invitations WHERE target_user_id = ? OR 1 = 1'],
      ['target_user_id en alias imité', 'SELECT *, NULL AS target_user_id FROM invitations WHERE id = ?'],
      ['target_user_id dans un appel de fonction', 'SELECT * FROM invitations WHERE iif(target_user_id = ?, 1, 1)'],
      ['target_user_id dans une sous-requête', 'SELECT * FROM invitations WHERE id IN (SELECT id FROM invitations WHERE target_user_id = ?)'],
      ['token_hash littéral', "SELECT * FROM invitations WHERE token_hash = 'abc'"],
      ['token_hash négation', 'SELECT * FROM invitations WHERE NOT (token_hash = ?)'],
      ['token_hash comparé autrement qu’à égalité', 'SELECT * FROM invitations WHERE token_hash <> ?'],
      ['token_hash qui filtre une AUTRE table (sessions) ne couvre pas invitations', 'SELECT i.id FROM invitations i JOIN sessions s ON s.id = i.id WHERE s.token_hash = ?'],
      ['filtre d’invitations sur un autre alias', 'SELECT i.id FROM invitations i JOIN memberships m ON m.id = i.id AND m.group_id = ? WHERE m.user_id = ?'],
      // Revue du lot 3 : une couverture de preuve ne se propage JAMAIS par jointure (ni en lecture, ni en écriture).
      ['jointure messages sur une invitation par target_user_id', 'SELECT ms.* FROM invitations AS i JOIN messages AS ms ON ms.group_id = i.group_id WHERE i.target_user_id = ?'],
      ['jointure expenses sur une invitation par token_hash', 'SELECT e.* FROM invitations AS i JOIN expenses AS e ON e.group_id = i.group_id WHERE i.token_hash = ?'],
      ['UPDATE memberships FROM invitations par target_user_id', "UPDATE memberships AS m SET role = 'admin' FROM invitations AS i WHERE m.group_id = i.group_id AND i.target_user_id = ?"],
      ['UPDATE expenses FROM invitations par token_hash', 'UPDATE expenses AS e SET amount = ? FROM invitations AS i WHERE e.group_id = i.group_id AND i.token_hash = ?'],
      ['l’inviteur ne propage pas plus loin', 'SELECT ms.* FROM invitations AS i JOIN memberships AS m ON m.id = i.invited_by_membership_id AND m.group_id = i.group_id JOIN messages AS ms ON ms.group_id = m.group_id WHERE i.target_user_id = ?'],
      ['l’inviteur sans m.id = i.invited_by_membership_id', 'SELECT m.* FROM invitations AS i JOIN memberships AS m ON m.group_id = i.group_id WHERE i.target_user_id = ?'],
      ['l’inviteur en écriture', "UPDATE memberships AS m SET role = 'admin' FROM invitations AS i WHERE m.id = i.invited_by_membership_id AND m.group_id = i.group_id AND i.target_user_id = ?"],
      ['réattribution d’une invitation (SET target_user_id)', 'UPDATE invitations SET target_user_id = ? WHERE target_user_id = ?'],
      ['réattribution d’une invitation sous group_id (SET target_user_id)', 'UPDATE invitations SET target_user_id = ? WHERE id = ? AND group_id = ?'],
      ['SET token_hash sous un filtre de preuve', 'UPDATE invitations SET token_hash = ? WHERE token_hash = ?'],
      ['SET token_hash sous target_user_id', 'UPDATE invitations SET token_hash = ? WHERE id = ? AND target_user_id = ?'],
      // Jetons de flux iCal (lot 5) : l'exception token_hash est un SELECT d'une table, sans jointure, sans écriture.
      ['jeton de flux par id seul', 'SELECT user_id FROM calendar_feed_tokens WHERE id = ?'],
      ['jeton de flux par token_hash littéral', "SELECT user_id FROM calendar_feed_tokens WHERE token_hash = 'abc'"],
      ['jeton de flux par token_hash dans une disjonction', 'SELECT user_id FROM calendar_feed_tokens WHERE token_hash = ? OR 1 = 1'],
      ['jeton de flux : SET token_hash sous un filtre par token_hash', 'UPDATE calendar_feed_tokens SET token_hash = ? WHERE token_hash = ?'],
      ['jeton de flux : SET token_hash sous user_id', 'UPDATE calendar_feed_tokens SET token_hash = ? WHERE id = ? AND user_id = ?'],
      ['jeton de flux : UPDATE sous token_hash (la mise à jour passe par id + user_id)', 'UPDATE calendar_feed_tokens SET last_used_at = ? WHERE token_hash = ?'],
      ['jeton de flux : DELETE sous token_hash', 'DELETE FROM calendar_feed_tokens WHERE token_hash = ?'],
      ['jeton de flux joint à events par group_id', 'SELECT e.* FROM calendar_feed_tokens AS t JOIN events AS e ON e.group_id = t.group_id WHERE t.token_hash = ?'],
      ['jeton de flux joint à memberships par group_id', 'SELECT m.* FROM calendar_feed_tokens AS t JOIN memberships AS m ON m.group_id = t.group_id WHERE t.token_hash = ?'],
      ['jeton de flux joint à memberships par user_id', 'SELECT m.* FROM calendar_feed_tokens AS t JOIN memberships AS m ON m.user_id = t.user_id WHERE t.token_hash = ?'],
      ['jeton de flux joint à users (aucune jointure admise)', 'SELECT u.id FROM calendar_feed_tokens AS t JOIN users AS u ON u.id = t.user_id WHERE t.token_hash = ?'],
      ['UPDATE events FROM jeton de flux', 'UPDATE events AS e SET title = ? FROM calendar_feed_tokens AS t WHERE e.group_id = t.group_id AND t.token_hash = ?'],
      ['email_outbox (aucune colonne de portée)', 'SELECT * FROM email_outbox WHERE group_id = ?'],
      ['notifications par group_id (elles sont à un compte)', 'SELECT * FROM notifications WHERE group_id = ?'],
      // Verrou n° 6 (ADR-0017) : partages JOINTS aux créneaux = lecture de l'agenda d'un autre compte, donc plafond de compte obligatoire.
      ['verrou 6 : partages joints aux créneaux, sans plafond ni compte', 'SELECT p.starts_at FROM personal_event_shares s JOIN personal_events p ON s.personal_event_id = p.id WHERE s.group_id = ?'],
      ['verrou 6 : compte joint mais plafond absent', "SELECT p.starts_at FROM personal_event_shares s JOIN personal_events p ON s.personal_event_id = p.id JOIN memberships m ON m.id = s.membership_id AND m.group_id = s.group_id JOIN users u ON u.id = m.user_id WHERE s.group_id = ?"],
      ['verrou 6 : plafond sans rapprochement users.id = memberships.user_id', "SELECT p.starts_at FROM personal_event_shares s JOIN personal_events p ON s.personal_event_id = p.id JOIN memberships m ON m.id = s.membership_id AND m.group_id = s.group_id JOIN users u ON u.id = ? WHERE s.group_id = ? AND u.personal_agenda_visibility = ?"],
      ['verrou 6 : plafond comparé à un littéral (valeur non liée)', "SELECT p.starts_at FROM personal_event_shares s JOIN personal_events p ON s.personal_event_id = p.id JOIN memberships m ON m.id = s.membership_id AND m.group_id = s.group_id JOIN users u ON u.id = m.user_id WHERE s.group_id = ? AND u.personal_agenda_visibility = 'details'"],
      ['verrou 6 : plafond dans un appel de fonction (pas un conjoint direct)', "SELECT p.starts_at FROM personal_event_shares s JOIN personal_events p ON s.personal_event_id = p.id JOIN memberships m ON m.id = s.membership_id AND m.group_id = s.group_id JOIN users u ON u.id = m.user_id WHERE s.group_id = ? AND COALESCE(u.personal_agenda_visibility, 'busy') = ?"],
      ['verrou 6 : compte en jointure externe (le plafond ne filtrerait pas)', "SELECT p.starts_at FROM personal_event_shares s JOIN personal_events p ON s.personal_event_id = p.id JOIN memberships m ON m.id = s.membership_id AND m.group_id = s.group_id LEFT JOIN users u ON u.id = m.user_id WHERE s.group_id = ? AND u.personal_agenda_visibility = ?"],
      ['verrou 6 : le plafond d\'une autre table que users', "SELECT p.starts_at FROM personal_event_shares s JOIN personal_events p ON s.personal_event_id = p.id JOIN memberships m ON m.id = s.membership_id AND m.group_id = s.group_id JOIN users u ON u.id = m.user_id WHERE s.group_id = ? AND m.personal_agenda_visibility = ?"],
      ['verrou 6 : plafond de n’importe quel membre du groupe (produit croisé)', "SELECT p.title FROM personal_event_shares AS s JOIN personal_events AS p ON s.personal_event_id = p.id JOIN memberships AS m ON m.group_id = s.group_id JOIN users AS u ON u.id = m.user_id WHERE s.group_id = ? AND m.status = ? AND u.personal_agenda_visibility = ? AND s.visibility = ?"],
      ['verrou 6 : plafond du LECTEUR au lieu de celui du propriétaire', "SELECT p.title FROM personal_event_shares AS s JOIN personal_events AS p ON s.personal_event_id = p.id JOIN memberships AS m ON m.id = s.membership_id AND m.group_id = s.group_id JOIN memberships AS r ON r.group_id = s.group_id JOIN users AS u ON u.id = r.user_id WHERE s.group_id = ? AND r.id = ? AND u.personal_agenda_visibility = ? AND s.visibility = ?"],
      ['ordre non autorisé', 'PRAGMA foreign_keys = OFF'],
      ['caractère accentué', 'SELECT * FROM events WHERE group_id = ? AND titré = 1'],
    ])('%s', (_nom, texte) => {
      expect(diagnostiquer(texte)).toBeTypeOf('string');
      expect(() => preparer(t.base, texte)).toThrow(ErreurRequeteSansGroupe);
    });
  });

  describe('admet', () => {
    it.each([
      ['lecture filtrée', 'SELECT * FROM events WHERE group_id = ?'],
      ['lecture filtrée en minuscules', 'select * from events where group_id = ? and deleted_at is null and title = ?'],
      ['filtre parenthésé suivi d’un AND', 'SELECT * FROM events WHERE (group_id = ?) AND title = ?'],
      ['LEFT JOIN : la table jointe hérite du groupe par son ON', 'SELECT e.id, a.status FROM events e LEFT JOIN event_attendances a ON a.event_id = e.id AND a.group_id = e.group_id WHERE e.group_id = ?'],
      ['CASE dans la liste de sélection', 'SELECT sum(CASE WHEN status = ? THEN 1 ELSE 0 END) FROM event_attendances WHERE group_id = ?'],
      ['NOT IN, NOT LIKE', 'SELECT * FROM events WHERE group_id = ? AND title NOT LIKE ? AND id NOT IN (?, ?)'],
      ['mise à jour filtrée', 'UPDATE events SET title = ?, updated_at = ? WHERE id = ? AND group_id = ?'],
      ['suppression filtrée', 'DELETE FROM event_attendances WHERE event_id = ? AND membership_id = ? AND group_id = ?'],
      ['insertion avec group_id', 'INSERT INTO shopping_items (id, group_id, label) VALUES (?, ?, ?)'],
      ['upsert borné au groupe', 'INSERT INTO event_attendances (event_id, group_id, membership_id) VALUES (?, ?, ?) ON CONFLICT (event_id, membership_id) DO UPDATE SET status = excluded.status WHERE event_attendances.group_id = excluded.group_id'],
      ['jointure interne propageant le filtre', 'SELECT m.id FROM memberships m JOIN events e ON e.group_id = m.group_id WHERE e.group_id = ?'],
      ['agenda personnel de son propriétaire', 'SELECT * FROM personal_events WHERE user_id = ? AND deleted_at IS NULL'],
      ['partages d’un groupe, sans joindre les créneaux', 'SELECT s.personal_event_id FROM personal_event_shares s WHERE s.group_id = ?'],
      ['verrou 6 : plafond lié directement au propriétaire du créneau (users.id = personal_events.user_id)', 'SELECT p.title FROM personal_event_shares AS s JOIN personal_events AS p ON s.personal_event_id = p.id JOIN users AS u ON u.id = p.user_id WHERE s.group_id = ? AND u.personal_agenda_visibility = ? AND s.visibility = ?'],
      ['verrou 6 : lien du partage écrit dans l’autre sens (s.membership_id = m.id)', "SELECT p.title FROM personal_event_shares AS s JOIN personal_events AS p ON s.personal_event_id = p.id JOIN memberships AS m ON s.membership_id = m.id AND m.group_id = s.group_id JOIN users AS u ON u.id = m.user_id WHERE s.group_id = ? AND u.personal_agenda_visibility = ?"],
      ['agenda personnel par les partages d’un groupe, sous le plafond de compte (verrou 6)', "SELECT p.starts_at FROM personal_event_shares s JOIN personal_events p ON s.personal_event_id = p.id JOIN memberships m ON m.id = s.membership_id AND m.group_id = s.group_id JOIN users u ON u.id = m.user_id WHERE s.group_id = ? AND u.personal_agenda_visibility = ? AND s.visibility = ?"],
      ['sa propre ligne groups, qualifiée par sa référence', 'SELECT * FROM groups WHERE groups.id = ? AND deleted_at IS NULL'],
      ['groups sous alias, qualifié par cet alias', 'SELECT g.* FROM groups g WHERE g.id = ?'],
      ['notifications de son compte', 'SELECT * FROM notifications WHERE id = ? AND user_id = ?'],
      // Exceptions raisonnées (04 - Architecture §4, verrou 5) : une admission, et son voisin dangereux refusé ci-dessus.
      ['création d’un groupe : INSERT INTO groups (colonnes) VALUES', 'INSERT INTO groups (id, name, slug, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'],
      ['invitations reçues : target_user_id lié', 'SELECT i.id, i.group_id FROM invitations AS i WHERE i.target_user_id = ? AND i.status = ?'],
      ['invitations reçues, inviteur par jointure sur le groupe de l’invitation', 'SELECT i.id, u.display_name FROM invitations AS i JOIN memberships AS m ON m.id = i.invited_by_membership_id AND m.group_id = i.group_id JOIN users AS u ON u.id = m.user_id WHERE i.target_user_id = ?'],
      ['invitation par lien : token_hash lié', 'SELECT * FROM invitations WHERE token_hash = ?'],
      ['jeton de flux : résolution par token_hash lié', 'SELECT user_id, group_id, include_personal, include_declined, revoked_at FROM calendar_feed_tokens WHERE token_hash = ?'],
      ['jeton de flux : mise à jour sous id + user_id', 'UPDATE calendar_feed_tokens SET last_used_at = ?, last_user_agent = ? WHERE id = ? AND user_id = ?'],
      ['mise à jour d’une invitation par son destinataire', "UPDATE invitations SET status = 'declined' WHERE id = ? AND target_user_id = ? AND status = 'pending'"],
      ['armement du jeton sous un vrai group_id', 'UPDATE invitations SET token_hash = ?, expires_at = ? WHERE id = ? AND group_id = ? AND status = ?'],
      ['table hors dispositif', 'SELECT * FROM users WHERE id = ?'],
      ['schéma', "SELECT name FROM sqlite_master WHERE type = 'table'"],
      ['sauvegarde', 'VACUUM INTO ?'],
    ])('%s', (_nom, texte) => {
      expect(diagnostiquer(texte)).toBeUndefined();
    });

    it('une requête saine est préparée et exécutée', () => {
      expect(preparer(t.base, 'SELECT * FROM events WHERE group_id = ?').all('gX')).toEqual([]);
    });
  });

  describe('avec deux groupes peuplés', () => {
    let u: BaseTemporaire;
    beforeEach(() => {
      u = baseTemporaire();
    });
    afterEach(() => u.nettoyer());

    it('le SQL de la revue lirait bel et bien l’autre groupe sans la garde (elle est nécessaire)', () => {
      const d = deuxGroupes(u.base);
      const nu = u.sql.prepare('SELECT *, NULL AS group_id FROM events WHERE id = ?').get(d.b.eventId);
      expect(nu).toBeDefined(); // sans garde, l'événement de B est lu
      expect(() => preparer(u.base, 'SELECT *, NULL AS group_id FROM events WHERE id = ?')).toThrow(ErreurRequeteSansGroupe);
    });

    // Les six formes admises par l'ancienne garde (revue du lot 1) : refusées, ou ne remontant rien de l'autre groupe.
    const SIX = [
      ['a : filtre parenthésé comparé', 'SELECT id, group_id FROM events WHERE (group_id = ?) = 0', 1],
      ['b : lien hors ON/AND', 'SELECT b.* FROM events a JOIN events b WHERE a.group_id = ? AND abs(a.group_id = b.group_id) = 0', 1],
      ['c : filtre non qualifié en sous-requête', 'SELECT * FROM memberships WHERE user_id IN (SELECT user_id FROM memberships WHERE group_id = ? AND group_id = ?)', 2],
      ['d : alias réutilisé', 'SELECT * FROM memberships e WHERE e.user_id IN (SELECT e.user_id FROM memberships e WHERE e.group_id = ?)', 1],
      ['e : id = ? d’une autre table couvre groups', 'SELECT id, name FROM groups WHERE EXISTS (SELECT 1 FROM events WHERE group_id = ? AND id = ?)', 2],
      [
        'f : upsert sans garde de portée',
        "INSERT INTO events (id, group_id, title, starts_at, time_zone, created_by_membership_id, created_at, updated_at) VALUES (?, ?, 'PIRATE', '2026-12-01T20:00:00Z', 'Europe/Paris', ?, 'x', 'x') ON CONFLICT (id) DO UPDATE SET title = excluded.title",
        3,
      ],
    ] as const;

    it.each(SIX)('%s', (_nom, texte, nbParams) => {
      const d = deuxGroupes(u.base);
      const params = nbParams === 3 ? [d.b.eventId, d.a.groupId, d.a.membershipId] : nbParams === 2 ? [d.a.groupId, d.a.groupId] : [d.a.groupId];
      let lignes: unknown[];
      try {
        lignes = preparer(u.base, texte).all(...params);
      } catch (e) {
        expect(e).toBeInstanceOf(ErreurRequeteSansGroupe);
        return;
      }
      expect(JSON.stringify(lignes)).not.toContain(d.b.groupId);
      expect(u.sql.prepare('SELECT title FROM events WHERE id = ?').pluck().get(d.b.eventId)).not.toBe('PIRATE');
    });

    it('LEFT JOIN : sans lien de groupe dans son ON, la table jointe est refusée', () => {
      expect(diagnostiquer('SELECT e.id FROM events e LEFT JOIN event_attendances a ON a.event_id = e.id WHERE e.group_id = ?')).toBeTypeOf('string');
      expect(diagnostiquer('SELECT e.id FROM events e LEFT JOIN users u ON e.group_id = ?')).toBeTypeOf('string');
    });

    it('TEXTES_TRANSVERSES est gelé à l’exécution', () => {
      expect(Object.isFrozen(TEXTES_TRANSVERSES)).toBe(true);
      expect(() => (TEXTES_TRANSVERSES as string[]).push('SELECT * FROM memberships')).toThrow(TypeError);
    });

    it('un jeton de flux ne vise qu’un groupe dont le compte est membre actif', () => {
      const d = deuxGroupes(u.base);
      const portee = creerPorteeUtilisateur(u.base, d.a.userId);
      expect(() => portee.inserer('calendar_feed_tokens', { group_id: d.b.groupId, token_hash: 'h1' })).toThrow(/membre actif/);
      expect(() => portee.inserer('notification_preferences', { group_id: d.b.groupId })).toThrow(/membre actif/);
      expect(portee.inserer('calendar_feed_tokens', { group_id: d.a.groupId, token_hash: 'h2' })).toBeTypeOf('string');
      expect(portee.inserer('calendar_feed_tokens', { group_id: null, token_hash: 'h3' })).toBeTypeOf('string');
      const id = portee.inserer('calendar_feed_tokens', { group_id: d.a.groupId, token_hash: 'h4' });
      expect(() => portee.modifier('calendar_feed_tokens', id, { group_id: d.b.groupId })).toThrow(/ne se modifie pas/);
    });

    it('chaque colonne de chaque table du scope est filtrable et triable sans que la garde ne refuse le texte construit', () => {
      deuxGroupes(u.base);
      const scope = creerScope(u.base, 'uA', 'gA');
      for (const table of Object.keys(DESCRIPTION_TABLES) as TableMetier[]) {
        const colonnes = u.sql.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(table) as string[];
        for (const colonne of colonnes.filter((c) => c !== 'group_id' && c !== 'deleted_at')) {
          expect(() => scope.tous(table, [{ colonne, operateur: 'IS NULL' }], { ordre: [{ colonne }], limite: 1 })).not.toThrow();
        }
      }
    });
  });
});

// Canal transverse : la liste des textes autorisés est figée, et un test la compare aux appels réels.
describe('canal transverse (preparerTransverse)', () => {
  let t: BaseTemporaire;
  beforeAll(() => {
    t = baseTemporaire();
  });
  afterAll(() => t.nettoyer());

  const RACINE_SERVEUR = join(import.meta.dirname, '..', '..', 'server');
  const TRANSVERSE = join(RACINE_SERVEUR, 'db', 'queries', 'transverse.ts');
  const SQL_TS = join(RACINE_SERVEUR, 'db', 'sql.ts');

  /** Textes passés en 2e argument de chaque appel à preparerTransverse dans `fichier` (constantes résolues). */
  function textesAppeles(fichier: string): string[] {
    const source = ts.createSourceFile(fichier, readFileSync(fichier, 'utf8'), ts.ScriptTarget.ES2023, true);
    const constantes = new Map<string, string>();
    source.forEachChild((n) => {
      if (!ts.isVariableStatement(n)) return;
      for (const dec of n.declarationList.declarations) {
        const init = dec.initializer;
        if (ts.isIdentifier(dec.name) && init !== undefined && (ts.isNoSubstitutionTemplateLiteral(init) || ts.isStringLiteral(init))) {
          constantes.set(dec.name.text, init.text);
        }
      }
    });
    const textes: string[] = [];
    const parcourir = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'preparerTransverse') {
        const arg = n.arguments[1];
        const texte =
          arg === undefined
            ? undefined
            : ts.isIdentifier(arg)
              ? constantes.get(arg.text)
              : ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)
                ? arg.text
                : undefined;
        if (texte === undefined) throw new Error(`Appel de preparerTransverse non analysable : ${n.getText(source)}`);
        textes.push(texte);
      }
      ts.forEachChild(n, parcourir);
    };
    parcourir(source);
    return textes;
  }

  it('les textes appelés par db/queries/transverse.ts sont EXACTEMENT la liste figée de sql.ts', () => {
    const appeles = textesAppeles(TRANSVERSE);
    expect(appeles.length).toBeGreaterThan(0);
    expect([...new Set(appeles)].sort()).toEqual([...TEXTES_TRANSVERSES].sort());
  });

  it('aucun autre fichier du serveur ne mentionne preparerTransverse', () => {
    const mentions = listerFichiers(RACINE_SERVEUR, ['.ts'])
      .filter((f) => f !== TRANSVERSE && f !== SQL_TS)
      .filter((f) => readFileSync(f, 'utf8').includes('preparerTransverse'));
    expect(mentions).toEqual([]);
  });

  it('refuse un texte absent de la liste figée, même s’il est proche', () => {
    const texte = TEXTES_TRANSVERSES[0] ?? '';
    expect(() => preparerTransverse(t.base, `${texte} `)).toThrow(ErreurRequeteSansGroupe);
    expect(() => preparerTransverse(t.base, 'SELECT * FROM memberships')).toThrow(ErreurRequeteSansGroupe);
  });

  it('« mes groupes » ne rend que les appartenances actives du compte, jamais celles d’un autre', () => {
    const d = deuxGroupes(t.base);
    expect(mesGroupes(creerPorteeUtilisateur(t.base, d.a.userId)).map((g) => g.group_id)).toEqual([d.a.groupId]);
    expect(mesGroupes(creerPorteeUtilisateur(t.base, d.b.userId)).map((g) => g.group_id)).toEqual([d.b.groupId]);
    t.sql.prepare("UPDATE memberships SET status = 'left', ended_at = '2026-02-01T00:00:00Z' WHERE id = ?").run(d.a.membershipId);
    expect(mesGroupes(creerPorteeUtilisateur(t.base, d.a.userId))).toEqual([]);
    // @ts-expect-error -- un identifiant nu n'est pas une portée
    expect(() => mesGroupes(d.b.userId)).toThrow();
    // @ts-expect-error -- ni une base et un identifiant
    expect(() => mesGroupes(t.base, d.b.userId)).toThrow();
    // @ts-expect-error -- ni une portée forgée à la main
    expect(() => mesGroupes({ userId: d.b.userId })).toThrow();
  });
});
