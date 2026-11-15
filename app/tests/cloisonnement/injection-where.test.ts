import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErreurScope } from '../../server/db/scope.js';
import { diagnostiquer } from '../../server/db/sql.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';

// Régression de la fuite démontrée à la revue du lot 1 : l'ancienne clause `where` était une
// CHAÎNE LIBRE filtrée par une liste noire ; les identifiants entre crochets de SQLite
// déséquilibraient le compteur de parenthèses et laissaient passer
//   CAST(1 AS [(]) = 1) OR 1=1 OR (CAST(1 AS [)]) = 1   →   ["Soiree de A", "SECRET de B"]
// La chaîne libre n'existe plus : un filtre est une liste { colonne, operateur, valeur }. Ces tests
// vérifient que chaque charge est refusée ET qu'aucune ligne d'un autre groupe ne remonte.

const CHARGE_EXACTE = 'CAST(1 AS [(]) = 1) OR 1=1 OR (CAST(1 AS [)]) = 1';

const CHARGES: ReadonlyArray<[string, string]> = [
  ['charge exacte de la revue', CHARGE_EXACTE],
  ['crochets', '[id] IS NOT NULL OR ([title] = 1'],
  ['guillemets doubles', '"id" IS NOT NULL OR ("1" = "1"'],
  ['accents graves', '`id` IS NOT NULL OR (`1` = `1`'],
  ['commentaire /* */', '1 = 1 /* ) OR 1 = 1 */'],
  ['commentaire --', '1 = 1 -- ) OR 1 = 1'],
  ['casse mélangée sElEcT', 'id IN (sElEcT id FrOm events)'],
  ['UNION', '1 = 1) UNION SELECT * FROM events WHERE (1 = 1'],
  ['point-virgule', 'id = 1; DROP TABLE events'],
  ['identifiant accentué', 'idé = 1'],
  ['appel de fonction', 'length(title) > 0'],
  ['mot-clé', 'OR'],
];

interface Ligne {
  readonly group_id: string;
  readonly title?: string;
}

describe('injection par le filtre : la chaîne libre n’existe plus', () => {
  let t: BaseTemporaire;
  let d: DeuxGroupes;
  beforeAll(() => {
    t = baseTemporaire();
    d = deuxGroupes(t.base);
    t.sql.prepare('UPDATE events SET title = ? WHERE id = ?').run('Soiree de A', d.a.eventId);
    t.sql.prepare('UPDATE events SET title = ? WHERE id = ?').run('SECRET de B', d.b.eventId);
  });
  afterAll(() => t.nettoyer());

  /** Exécute sans rien avaler : renvoie soit les lignes, soit l'erreur. */
  const essayer = (f: () => unknown[]): { lignes?: Ligne[]; erreur?: unknown } => {
    try {
      return { lignes: f() as Ligne[] };
    } catch (erreur) {
      return { erreur };
    }
  };

  /** Aucune ligne d'un autre groupe, ni le secret de B, ne remonte jamais. */
  const aucuneFuite = (lignes: Ligne[] | undefined): void => {
    expect((lignes ?? []).filter((l) => l.group_id !== d.a.groupId)).toEqual([]);
    expect(JSON.stringify(lignes ?? [])).not.toContain('SECRET de B');
  };

  const refus = (resultat: { lignes?: Ligne[]; erreur?: unknown }): void => {
    expect(resultat.erreur).toBeInstanceOf(ErreurScope);
    expect(resultat.lignes).toBeUndefined();
    aucuneFuite(resultat.lignes);
  };

  it('la base contient bien le secret de B (le test n’est pas vide)', () => {
    expect(d.scopeB.tous<Ligne>('events').map((e) => e.title)).toEqual(['SECRET de B']);
    expect(d.scopeA.tous<Ligne>('events').map((e) => e.title)).toEqual(['Soiree de A']);
  });

  it('la charge exacte de la revue, passée comme ancienne clause (chaîne + paramètres), est refusée', () => {
    refus(essayer(() => d.scopeA.tous('events', CHARGE_EXACTE as never, [] as never)));
  });

  describe.each(CHARGES)('%s', (_nom, charge) => {
    it('refusée comme ancienne clause en chaîne libre', () => {
      refus(essayer(() => d.scopeA.tous('events', charge as never, [] as never)));
    });

    it('refusée comme nom de colonne', () => {
      refus(essayer(() => d.scopeA.tous('events', [{ colonne: charge, operateur: '=', valeur: 1 }])));
    });

    it('refusée comme opérateur', () => {
      refus(essayer(() => d.scopeA.tous('events', [{ colonne: 'id', operateur: charge as never, valeur: 1 }])));
    });

    it('refusée comme colonne de tri', () => {
      refus(essayer(() => d.scopeA.tous('events', [], { ordre: [{ colonne: charge }] })));
    });

    it('refusée comme colonne de mise à jour : la ligne de B reste intacte', () => {
      expect(() => d.scopeA.modifierPar('events', { id: d.b.eventId }, { [charge]: 'Piraté' })).toThrow(ErreurScope);
      expect(t.sql.prepare('SELECT title FROM events WHERE id = ?').pluck().get(d.b.eventId)).toBe('SECRET de B');
    });

    it('refusée comme nom de colonne de clé', () => {
      expect(() => d.scopeA.modifierPar('events', { [charge]: d.b.eventId }, { title: 'Piraté' })).toThrow(ErreurScope);
    });

    // Un appel de fonction inoffensif n'élargit rien : la garde du SQL brut ne l'interdit pas (l'interface structurée, si).
    it.skipIf(charge.startsWith('length('))('même si la composition défaillait un jour, la garde du SQL brut refuse le texte', () => {
      const texte = `SELECT * FROM (SELECT * FROM events WHERE group_id = ? AND deleted_at IS NULL) WHERE ${charge}`;
      expect(diagnostiquer(texte)).toBeTypeOf('string');
    });
  });

  describe('une valeur est toujours liée, jamais interprétée', () => {
    it.each([
      "x' OR '1'='1",
      "' OR 1=1 --",
      CHARGE_EXACTE,
      '%',
      '"; DROP TABLE events; --',
    ])('valeur hostile « %s » : aucune ligne, aucune fuite', (valeur) => {
      for (const operateur of ['=', '<>', 'LIKE', '<', '>='] as const) {
        const { lignes, erreur } = essayer(() => d.scopeA.tous('events', [{ colonne: 'title', operateur, valeur }]));
        expect(erreur).toBeUndefined();
        aucuneFuite(lignes);
      }
      expect(d.scopeA.tous('events', [{ colonne: 'title', operateur: '=', valeur }])).toEqual([]);
      const dans = essayer(() => d.scopeA.tous('events', [{ colonne: 'title', operateur: 'IN', valeur: [valeur, 'SECRET de B'] }]));
      expect(dans.erreur).toBeUndefined();
      aucuneFuite(dans.lignes);
      expect(dans.lignes).toEqual([]);
    });

    it('chercher le titre exact de B depuis A ne trouve rien', () => {
      expect(d.scopeA.tous('events', [{ colonne: 'title', operateur: '=', valeur: 'SECRET de B' }])).toEqual([]);
      expect(d.scopeA.tous('events', [{ colonne: 'title', operateur: 'LIKE', valeur: '%SECRET%' }])).toEqual([]);
    });
  });
});
