import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { creerPorteeUtilisateur } from '../../server/db/portee-utilisateur.js';
import { creerSource, lireDetailsImportes, remplacerCreneauxImportes, type PlageImportee } from '../../server/db/queries/agenda-externe.js';
import { listerDisponibilitesGroupe } from '../../server/db/queries/agenda-personnel.js';
import { creerScope } from '../../server/db/scope.js';
import { JOURNAL_SILENCIEUX, type Journal } from '../../server/http/middleware/journal.js';
import { listerMonAgenda } from '../../server/services/agenda-personnel.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';

// Détails chiffrés d'un créneau importé (migration 0005, ADR-0013 révisé le 2026-11-18) : le propriétaire relit ses textes ; les groupes
// n'en reçoivent RIEN, et cette garantie ne dépend ni des déclencheurs ni du réglage de partage : `listerDisponibilitesGroupe` ne lit
// pas les colonnes chiffrées et ne sait pas les déchiffrer.

const T0 = '2026-01-01T00:00:00Z';
const CLE = randomBytes(32).toString('base64');
const TITRE = 'Rendez-vous oncologie Dr Martin';
const DESCRIPTION = 'Apporter les résultats de la biopsie';
const LIEU = 'Clinique Saint-Joseph, bloc B';
const FENETRE = { du: '2027-01-01T00:00:00Z', au: '2027-12-31T00:00:00Z' };

const PLAGE: PlageImportee = {
  starts_at: '2027-03-01T09:00:00Z',
  ends_at: '2027-03-01T10:00:00Z',
  all_day: false,
  time_zone: 'UTC',
  titre: TITRE,
  description: DESCRIPTION,
  lieu: LIEU,
};
const PLAGE_SANS_TEXTE: PlageImportee = { starts_at: '2027-03-02T09:00:00Z', ends_at: '2027-03-02T10:00:00Z', all_day: false, time_zone: 'UTC' };

describe('agenda externe : détails chiffrés', () => {
  let t: BaseTemporaire;
  let d: DeuxGroupes;
  let n = 0;
  let sourceId: string;
  let creneauId: string;
  let avertissements: Array<{ message: string; champs: unknown }>;

  const portee = (user: string) => creerPorteeUtilisateur(t.base, user);
  const journal: Journal = { ...JOURNAL_SILENCIEUX, warn: (message, champs) => avertissements.push({ message, champs }) };
  const ligneBrute = (id: string): Record<string, unknown> => t.sql.prepare('SELECT * FROM personal_events WHERE id = ?').get(id) as Record<string, unknown>;
  const importes = (creneaux: ReturnType<typeof listerMonAgenda>) => creneaux.filter((c) => c.calendar_source_id !== null);
  const vueCarol = () => listerDisponibilitesGroupe(creerScope(t.base, 'uC', d.a.groupId), FENETRE);

  beforeAll(() => {
    t = baseTemporaire();
    d = deuxGroupes(t.base);
    t.sql.prepare('INSERT INTO users (id, email, username, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('uC', 'c@exemple.test', 'user_c', 'Carol', T0, T0);
    t.sql
      .prepare("INSERT INTO memberships (id, group_id, user_id, role, joined_at, created_at, updated_at) VALUES ('mC', ?, 'uC', 'member', ?, ?, ?)")
      .run(d.a.groupId, T0, T0, T0);
  });
  afterAll(() => t.nettoyer());

  beforeEach(() => {
    avertissements = [];
    t.sql.prepare('DELETE FROM calendar_sources').run();
    n += 1;
    const alice = portee(d.a.userId);
    const source = creerSource(alice, { label: 'Google', url: `https://agenda.exemple.test/${String(n)}.ics`, hote: 'agenda.exemple.test', prochaineTentative: T0 }, CLE);
    if (!source.ok) throw new Error('création attendue');
    sourceId = source.id;
    expect(remplacerCreneauxImportes(alice, sourceId, [PLAGE], CLE)).toBe(1);
    creneauId = t.sql.prepare('SELECT id FROM personal_events WHERE calendar_source_id = ?').pluck().get(sourceId) as string;
  });

  describe('lecture par le propriétaire', () => {
    it('Alice relit titre, description et lieu de son créneau importé (nº 1)', () => {
      const [creneau, ...autres] = importes(listerMonAgenda(portee(d.a.userId), FENETRE, CLE, journal));
      expect(autres).toHaveLength(0);
      expect(creneau).toMatchObject({ id: creneauId, title: TITRE, description: DESCRIPTION, location_name: LIEU, calendar_source_id: sourceId });
      expect(avertissements).toEqual([]);
    });

    it('un créneau saisi à la main est rendu tel quel', () => {
      const alice = portee(d.a.userId);
      const manuel = alice.inserer('personal_events', { title: 'Kiné', description: 'dos', location_name: null, all_day: 0, starts_at: '2027-05-01T09:00:00Z', ends_at: '2027-05-01T10:00:00Z', time_zone: 'UTC' });
      expect(listerMonAgenda(alice, FENETRE, CLE, journal).find((c) => c.id === manuel)).toMatchObject({ title: 'Kiné', description: 'dos', location_name: null });
    });

    it('Bob ne lit pas les détails d’Alice, même en forgeant son identifiant de créneau (cloisonnement)', () => {
      expect(lireDetailsImportes(portee(d.b.userId), CLE).details.size).toBe(0);
      expect(JSON.stringify(listerMonAgenda(portee(d.b.userId), FENETRE, CLE, journal))).not.toContain(TITRE);
    });

    it('un déchiffrement impossible rend le créneau sans texte, sans lever, et le journal compte l’incident (nº 6)', () => {
      const autreCle = randomBytes(32).toString('base64');
      let creneaux: ReturnType<typeof listerMonAgenda> = [];
      expect(() => {
        creneaux = importes(listerMonAgenda(portee(d.a.userId), FENETRE, autreCle, journal));
      }).not.toThrow();
      expect(creneaux).toHaveLength(1);
      expect(creneaux[0]).toMatchObject({ id: creneauId, title: '', description: null, location_name: null });
      expect(avertissements).toEqual([{ message: 'agenda.details_illisibles', champs: { illisibles: 1 } }]);
      expect(JSON.stringify(creneaux)).not.toContain(TITRE);
    });

    it('un blob altéré est illisible mais ne fait pas tomber la liste', () => {
      t.sql.prepare("UPDATE personal_events SET details_cipher = x'0102030405060708090a0b0c0d0e0f1011121314' WHERE id = ?").run(creneauId);
      const creneaux = importes(listerMonAgenda(portee(d.a.userId), FENETRE, CLE, journal));
      expect(creneaux[0]).toMatchObject({ title: '', description: null, location_name: null });
      expect(avertissements).toHaveLength(1);
    });
  });

  describe('stockage', () => {
    it('les colonnes en clair restent vides, les textes ne sont nulle part dans la ligne brute (nº 4)', () => {
      const ligne = ligneBrute(creneauId);
      expect(ligne['title']).toBe('');
      expect(ligne['description']).toBeNull();
      expect(ligne['location_name']).toBeNull();
      expect(Buffer.isBuffer(ligne['details_cipher'])).toBe(true);
      expect((ligne['details_nonce'] as Buffer).length).toBe(12);
      const serialise = Buffer.concat([ligne['details_cipher'] as Buffer, ligne['details_nonce'] as Buffer]).toString('latin1') + JSON.stringify(ligne);
      for (const texte of [TITRE, DESCRIPTION, LIEU, 'oncologie', 'biopsie', 'Saint-Joseph']) expect(serialise).not.toContain(texte);
    });

    it('une plage sans aucun texte laisse les deux colonnes NULL, même avec des chaînes vides (nº 7)', () => {
      const alice = portee(d.a.userId);
      remplacerCreneauxImportes(alice, sourceId, [PLAGE_SANS_TEXTE, { ...PLAGE_SANS_TEXTE, starts_at: '2027-03-03T09:00:00Z', ends_at: '2027-03-03T10:00:00Z', titre: '', description: '', lieu: '' }], CLE);
      const lignes = t.sql.prepare('SELECT details_cipher, details_nonce FROM personal_events WHERE calendar_source_id = ?').all(sourceId);
      expect(lignes).toEqual([
        { details_cipher: null, details_nonce: null },
        { details_cipher: null, details_nonce: null },
      ]);
    });

    it('le remplacement du lot ne laisse aucun blob de l’ancien lot', () => {
      remplacerCreneauxImportes(portee(d.a.userId), sourceId, [PLAGE_SANS_TEXTE], CLE);
      expect(t.sql.prepare('SELECT count(*) FROM personal_events WHERE details_cipher IS NOT NULL').pluck().get()).toBe(0);
    });
  });

  describe('CHECK de cohérence', () => {
    it('sont enregistrés comme contraintes, non comme colonnes (sqlite_master)', () => {
      const sqlTable = t.sql.prepare("SELECT sql FROM sqlite_master WHERE name = 'personal_events'").pluck().get() as string;
      expect(sqlTable).toMatch(/details_cipher BLOB\s+CHECK \(\(details_cipher IS NULL\) = \(details_nonce IS NULL\) AND \(details_cipher IS NULL OR calendar_source_id IS NOT NULL\)\)/);
      const colonnes = t.sql.prepare('SELECT name FROM pragma_table_info(?)').pluck().all('personal_events') as string[];
      expect(colonnes).toEqual(expect.arrayContaining(['details_cipher', 'details_nonce']));
      expect(colonnes).not.toContain('CHECK');
      expect(colonnes.filter((c) => c.startsWith('details_'))).toHaveLength(2);
    });

    it('refuse un details_cipher sans details_nonce, et l’inverse (nº 5)', () => {
      expect(() => t.sql.prepare("UPDATE personal_events SET details_nonce = NULL WHERE id = ?").run(creneauId)).toThrow(/CHECK/);
      expect(() => t.sql.prepare("UPDATE personal_events SET details_cipher = NULL WHERE id = ?").run(creneauId)).toThrow(/CHECK/);
      const sansTexte = remplacerCreneauxImportes(portee(d.a.userId), sourceId, [PLAGE_SANS_TEXTE], CLE);
      expect(sansTexte).toBe(1);
      expect(() => t.sql.prepare("UPDATE personal_events SET details_nonce = x'00' WHERE calendar_source_id = ?").run(sourceId)).toThrow(/CHECK/);
      expect(() => t.sql.prepare("UPDATE personal_events SET details_cipher = x'00' WHERE calendar_source_id = ?").run(sourceId)).toThrow(/CHECK/);
    });

    it('refuse un blob chiffré sur un créneau saisi à la main (nº 5)', () => {
      n += 1;
      const id = `pe-details-${String(n)}`;
      const inserer = (cipher: string | null, nonce: string | null) =>
        t.sql
          .prepare(
            `INSERT INTO personal_events (id, user_id, title, all_day, starts_at, ends_at, time_zone, created_at, updated_at, details_cipher, details_nonce)
             VALUES (?, ?, 'Kiné', 0, '2027-03-01T09:00:00Z', '2027-03-01T10:00:00Z', 'UTC', ?, ?, ${cipher ?? 'NULL'}, ${nonce ?? 'NULL'})`,
          )
          .run(id, d.a.userId, T0, T0);
      expect(() => inserer("x'00'", "x'00'")).toThrow(/CHECK/);
      expect(() => inserer(null, null)).not.toThrow();
      expect(() => t.sql.prepare("UPDATE personal_events SET details_cipher = x'00', details_nonce = x'00' WHERE id = ?").run(id)).toThrow(/CHECK/);
    });
  });

  describe('lecture par les groupes : rien, structurellement', () => {
    const toutesLesTraces = (): string[] => {
      const ligne = ligneBrute(creneauId);
      const cipher = ligne['details_cipher'] as Buffer;
      const nonce = ligne['details_nonce'] as Buffer;
      return [TITRE, DESCRIPTION, LIEU, 'oncologie', 'biopsie', 'Saint-Joseph', cipher.toString('base64'), cipher.toString('hex'), nonce.toString('base64'), nonce.toString('hex'), cipher.toString('latin1')];
    };

    it('partagé en `busy`, un membre du groupe voit « occupé » sans aucun texte, et un membre de B ne voit rien (nº 2)', () => {
      expect(t.sql.prepare('SELECT visibility FROM personal_event_shares WHERE personal_event_id = ?').pluck().all(creneauId)).toEqual(['busy']);
      const vue = vueCarol();
      expect(vue).toHaveLength(1);
      expect(vue[0]).toMatchObject({ id: creneauId, visibility: 'busy', title: null, description: null, location_name: null });
      const serialise = JSON.stringify(vue);
      for (const trace of toutesLesTraces()) expect(serialise).not.toContain(trace);

      // L'attaque : un membre du groupe B ne peut même pas construire une portée sur le groupe A, et sa propre vue ne montre rien.
      expect(() => creerScope(t.base, d.b.userId, d.a.groupId)).toThrow();
      expect(listerDisponibilitesGroupe(d.scopeB, FENETRE)).toEqual([]);
    });

    it('partagé en `details` de force, déclencheurs SUPPRIMÉS : la requête de groupe ne rend toujours aucun texte (nº 3)', () => {
      const declencheurs = t.sql
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_pes_import_sans_details_insert', 'trg_pes_import_sans_details_update')")
        .all() as Array<{ name: string; sql: string }>;
      expect(declencheurs).toHaveLength(2);
      try {
        for (const dec of declencheurs) t.sql.exec(`DROP TRIGGER ${dec.name}`);
        // Preuve que les déclencheurs ont bien disparu : le partage en `details` d'un créneau importé passe maintenant.
        t.sql.prepare("UPDATE personal_event_shares SET visibility = 'details' WHERE personal_event_id = ?").run(creneauId);
        expect(t.sql.prepare('SELECT visibility FROM personal_event_shares WHERE personal_event_id = ?').pluck().get(creneauId)).toBe('details');

        const vue = vueCarol();
        expect(vue).toHaveLength(1);
        expect(vue[0]).toMatchObject({ id: creneauId, visibility: 'details', title: '', description: null, location_name: null });
        const serialise = JSON.stringify(vue);
        for (const trace of toutesLesTraces()) expect(serialise).not.toContain(trace);
        expect(serialise).not.toContain('details_');
        expect(listerDisponibilitesGroupe(d.scopeB, FENETRE)).toEqual([]);
      } finally {
        for (const dec of declencheurs) t.sql.exec(dec.sql);
      }
      // Les déclencheurs sont rétablis et de nouveau actifs.
      const apres = t.sql.prepare("SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_pes_import_sans_details_%'").pluck().get();
      expect(apres).toBe(2);
      expect(() => t.sql.prepare("UPDATE personal_event_shares SET visibility = 'busy' WHERE personal_event_id = ?").run(creneauId)).not.toThrow();
      expect(() => t.sql.prepare("UPDATE personal_event_shares SET visibility = 'details' WHERE personal_event_id = ?").run(creneauId)).toThrow(/partage\.import_sans_details/);
    });
  });
});
