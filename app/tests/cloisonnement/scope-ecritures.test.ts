import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { creerScope, ErreurScope } from '../../server/db/scope.js';
import { nouvelIdentifiant } from '../../server/db/identifiant.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';

// Le scope doit être assez riche pour que personne n'écrive de SQL brut au lot 4 : suppression
// réelle, modification et upsert par clé composite, transaction, Buffer, ligne `groups`, ressources
// sans auteur, UUID v7.
const T0 = '2026-01-01T00:00:00Z';

describe('GroupScope : écritures par clé composite, transactions, binaires', () => {
  let t: BaseTemporaire;
  let d: DeuxGroupes;
  beforeEach(() => {
    t = baseTemporaire();
    d = deuxGroupes(t.base);
  });
  afterEach(() => t.nettoyer());

  const presence = (g: DeuxGroupes['a']): Record<string, unknown> | undefined =>
    t.sql.prepare('SELECT * FROM event_attendances WHERE event_id = ? AND membership_id = ?').get(g.eventId, g.membershipId) as
      | Record<string, unknown>
      | undefined;

  describe('upsert et modifierPar sur event_attendances (sans colonne id)', () => {
    it('insère puis met à jour la même ligne', () => {
      expect(d.scopeA.upsert('event_attendances', { event_id: d.a.eventId, membership_id: d.a.membershipId, status: 'yes', responded_at: T0 })).toBe(true);
      expect(presence(d.a)?.['status']).toBe('yes');
      expect(d.scopeA.upsert('event_attendances', { event_id: d.a.eventId, membership_id: d.a.membershipId, status: 'maybe', responded_at: T0 })).toBe(true);
      expect(presence(d.a)?.['status']).toBe('maybe');
      expect(t.sql.prepare('SELECT count(*) FROM event_attendances').pluck().get()).toBe(1);
      expect(d.scopeA.modifierPar('event_attendances', { event_id: d.a.eventId, membership_id: d.a.membershipId }, { comment: 'Je ramène du pain' })).toBe(true);
      expect(presence(d.a)?.['comment']).toBe('Je ramène du pain');
    });

    it('une clé forgée vers B ne touche pas la ligne de B (ni par upsert ni par modifierPar)', () => {
      d.scopeB.upsert('event_attendances', { event_id: d.b.eventId, membership_id: d.b.membershipId, status: 'yes', responded_at: T0 });
      const avant = presence(d.b);
      expect(avant?.['status']).toBe('yes');
      // L'upsert de A vise exactement la clé primaire de B : la clause de conflit est bornée au groupe.
      expect(() => d.scopeA.upsert('event_attendances', { event_id: d.b.eventId, membership_id: d.b.membershipId, status: 'no', responded_at: T0 })).toThrow(ErreurScope);
      // Même en forgeant l'événement de B avec SA propre appartenance : la clé étrangère composite refuse.
      expect(() => d.scopeA.upsert('event_attendances', { event_id: d.b.eventId, membership_id: d.a.membershipId, status: 'no', responded_at: T0 })).toThrow(/FOREIGN KEY/);
      expect(d.scopeA.modifierPar('event_attendances', { event_id: d.b.eventId, membership_id: d.b.membershipId }, { status: 'no' })).toBe(false);
      expect(presence(d.b)).toEqual(avant);
    });

    it('impose l’auteur sur les présences : on ne répond pas à la place d’un autre membre du groupe', () => {
      const t2 = t.sql.prepare("INSERT INTO users (id, email, username, display_name, created_at, updated_at) VALUES ('uA2', 'a2@exemple.test', 'user_a2', 'A2', ?, ?)").run(T0, T0);
      expect(t2.changes).toBe(1);
      t.sql.prepare("INSERT INTO memberships (id, group_id, user_id, role, joined_at, created_at, updated_at) VALUES ('mA2', ?, 'uA2', 'member', ?, ?, ?)").run(d.a.groupId, T0, T0, T0);
      const scopeA2 = creerScope(t.base, 'uA2', d.a.groupId);
      d.scopeA.upsert('event_attendances', { event_id: d.a.eventId, membership_id: d.a.membershipId, status: 'yes', responded_at: T0 });
      expect(() => scopeA2.upsert('event_attendances', { event_id: d.a.eventId, membership_id: d.a.membershipId, status: 'no', responded_at: T0 })).toThrow(ErreurScope);
      expect(scopeA2.modifierPar('event_attendances', { event_id: d.a.eventId, membership_id: d.a.membershipId }, { status: 'no' })).toBe(false);
      expect(scopeA2.supprimer('event_attendances', { event_id: d.a.eventId, membership_id: d.a.membershipId })).toBe(false);
      expect(presence(d.a)?.['status']).toBe('yes');
    });

    it('exige la clé exacte', () => {
      expect(() => d.scopeA.modifierPar('event_attendances', { event_id: d.a.eventId }, { status: 'no' })).toThrow(ErreurScope);
      expect(() => d.scopeA.modifierPar('event_attendances', { id: 'x', event_id: d.a.eventId, membership_id: d.a.membershipId }, { status: 'no' })).toThrow(ErreurScope);
      expect(() => d.scopeA.modifierPar('event_attendances', { event_id: d.a.eventId, membership_id: d.a.membershipId }, { event_id: d.b.eventId })).toThrow(ErreurScope);
    });
  });

  describe('suppression réelle', () => {
    it('supprime une association du groupe et pas celle de B', () => {
      d.scopeA.inserer('event_attendances', { event_id: d.a.eventId, membership_id: d.a.membershipId, status: 'yes', responded_at: T0 });
      d.scopeB.inserer('event_attendances', { event_id: d.b.eventId, membership_id: d.b.membershipId, status: 'yes', responded_at: T0 });
      expect(d.scopeA.supprimer('event_attendances', { event_id: d.b.eventId, membership_id: d.b.membershipId })).toBe(false);
      expect(presence(d.b)).toBeDefined();
      expect(d.scopeA.supprimer('event_attendances', { event_id: d.a.eventId, membership_id: d.a.membershipId })).toBe(true);
      expect(presence(d.a)).toBeUndefined();
      expect(d.scopeA.supprimer('event_attendances', { event_id: d.a.eventId, membership_id: d.a.membershipId })).toBe(false);
    });

    it('refuse une table qui garde son historique', () => {
      expect(() => d.scopeA.supprimer('events' as never, { id: d.a.eventId })).toThrow(ErreurScope);
      expect(() => d.scopeA.supprimer('memberships' as never, { id: d.a.membershipId })).toThrow(ErreurScope);
      expect(t.sql.prepare('SELECT count(*) FROM events WHERE id = ?').pluck().get(d.a.eventId)).toBe(1);
    });
  });

  describe('transaction', () => {
    it('valide un groupe d’écritures, ou les annule toutes', () => {
      d.scopeA.transaction(() => {
        d.scopeA.inserer('shopping_lists', { title: 'T1' });
        d.scopeA.inserer('shopping_lists', { title: 'T2' });
      });
      expect(d.scopeA.tous('shopping_lists', [{ colonne: 'title', operateur: 'IN', valeur: ['T1', 'T2'] }]).length).toBe(2);
      expect(() =>
        d.scopeA.transaction(() => {
          d.scopeA.inserer('shopping_lists', { title: 'T3' });
          throw new Error('échec voulu');
        }),
      ).toThrow('échec voulu');
      expect(d.scopeA.tous('shopping_lists', [{ colonne: 'title', operateur: '=', valeur: 'T3' }])).toEqual([]);
    });

    it('refuse une fonction asynchrone et annule ce qu’elle a écrit', () => {
      const asynchrone = async (): Promise<number> => {
        d.scopeA.inserer('shopping_lists', { title: 'Asynchrone' });
        return 1;
      };
      // @ts-expect-error -- un rappel qui rend une Promise ne compile pas
      expect(() => d.scopeA.transaction(asynchrone)).toThrow(/asynchrone/);
      expect(d.scopeA.tous('shopping_lists', [{ colonne: 'title', operateur: '=', valeur: 'Asynchrone' }])).toEqual([]);
    });

    it('s’imbrique', () => {
      d.scopeA.transaction(() => {
        d.scopeA.inserer('shopping_lists', { title: 'Externe' });
        expect(() => d.scopeA.transaction(() => { d.scopeA.inserer('shopping_lists', { title: 'Interne' }); throw new Error('x'); })).toThrow('x');
      });
      expect(d.scopeA.tous<{ title: string }>('shopping_lists', [{ colonne: 'title', operateur: 'IN', valeur: ['Externe', 'Interne'] }]).map((l) => l.title)).toEqual(['Externe']);
    });
  });

  describe('Buffer : group_immich_configs.api_key_cipher', () => {
    const config = (url: string, octets: number[]): Record<string, string | Buffer> => ({
      base_url: url,
      api_key_cipher: Buffer.from(octets),
      api_key_nonce: Buffer.from([9, 9]),
      api_key_fingerprint: 'abcd',
    });

    it('stocke et relit un binaire à l’identique, une seule configuration par groupe (upsert)', () => {
      d.scopeA.inserer('group_immich_configs', config('https://immich.exemple', [0, 255, 1, 2]));
      const lue = d.scopeA.tous<{ api_key_cipher: Buffer }>('group_immich_configs')[0];
      expect(Buffer.isBuffer(lue?.api_key_cipher)).toBe(true);
      expect([...(lue?.api_key_cipher ?? [])]).toEqual([0, 255, 1, 2]);
      expect(d.scopeA.upsert('group_immich_configs', config('https://autre.exemple', [7]))).toBe(true);
      const apres = d.scopeA.tous<{ base_url: string; api_key_cipher: Buffer }>('group_immich_configs');
      expect(apres.length).toBe(1);
      expect(apres[0]?.base_url).toBe('https://autre.exemple');
      expect([...(apres[0]?.api_key_cipher ?? [])]).toEqual([7]);
      expect(d.scopeB.tous('group_immich_configs')).toEqual([]);
    });
  });

  describe('sa propre ligne groups', () => {
    it('groupe() rend le groupe du scope, jamais un autre', () => {
      expect(d.scopeA.groupe<{ id: string; name: string }>()).toMatchObject({ id: d.a.groupId, name: 'Groupe A' });
      expect(d.scopeB.groupe<{ id: string }>()?.id).toBe(d.b.groupId);
    });

    it('groupe() ne rend rien pour un groupe supprimé', () => {
      t.sql.prepare("UPDATE groups SET deleted_at = '2026-02-01T00:00:00Z' WHERE id = ?").run(d.a.groupId);
      expect(d.scopeA.groupe()).toBeUndefined();
    });

    it('groups n’est pas une table du scope', () => {
      expect(() => d.scopeA.tous('groups' as never)).toThrow(ErreurScope);
    });
  });

  describe('album_assets sans auteur (synchronisation Immich)', () => {
    it('s’insère sans auteur ; un auteur autre que le membre du scope est refusé', () => {
      const album = d.scopeA.inserer('albums', { title: 'Vacances', immich_album_id: 'imm-1' });
      const actif = { album_id: album, immich_asset_id: 'a1', kind: 'image' } as const;
      d.scopeA.inserer('album_assets', actif);
      expect(d.scopeA.tous<{ uploaded_by_membership_id: string | null }>('album_assets')[0]?.uploaded_by_membership_id).toBeNull();
      d.scopeA.inserer('album_assets', { ...actif, immich_asset_id: 'a2', uploaded_by_membership_id: d.a.membershipId });
      expect(() => d.scopeA.inserer('album_assets', { ...actif, immich_asset_id: 'a3', uploaded_by_membership_id: d.b.membershipId })).toThrow(ErreurScope);
      expect(d.scopeA.supprimer('album_assets', { album_id: album, immich_asset_id: 'a1' })).toBe(true);
      expect(d.scopeB.supprimer('album_assets', { album_id: album, immich_asset_id: 'a2' })).toBe(false);
    });
  });

  describe('identifiants UUID v7', () => {
    it('sont uniques, monotones et au bon format', () => {
      const ids = Array.from({ length: 5000 }, () => nouvelIdentifiant());
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual(ids);
      for (const id of ids.slice(0, 50)) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('inserer renvoie l’identifiant généré, et un() le retrouve', () => {
      const id = d.scopeA.inserer('threads', { title: 'Fil', kind: 'free' });
      expect(d.scopeA.un<{ id: string }>('threads', id)?.id).toBe(id);
      expect(d.scopeB.un('threads', id)).toBeUndefined();
    });
  });
});
