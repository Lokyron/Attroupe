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
      ['insertion dans groups', 'INSERT INTO groups (id, name) VALUES (?, ?)'],
      ['email_outbox (aucune colonne de portée)', 'SELECT * FROM email_outbox WHERE group_id = ?'],
      ['notifications par group_id (elles sont à un compte)', 'SELECT * FROM notifications WHERE group_id = ?'],
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
      ['agenda personnel par les partages d’un groupe', 'SELECT p.starts_at FROM personal_event_shares s JOIN personal_events p ON s.personal_event_id = p.id WHERE s.group_id = ?'],
      ['sa propre ligne groups, qualifiée par sa référence', 'SELECT * FROM groups WHERE groups.id = ? AND deleted_at IS NULL'],
      ['groups sous alias, qualifié par cet alias', 'SELECT g.* FROM groups g WHERE g.id = ?'],
      ['notifications de son compte', 'SELECT * FROM notifications WHERE id = ? AND user_id = ?'],
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
