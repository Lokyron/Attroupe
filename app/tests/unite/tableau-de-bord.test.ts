import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { creerPorteeUtilisateur } from '../../server/db/portee-utilisateur.js';
import { creerCreneauPersonnel } from '../../server/db/queries/agenda-personnel.js';
import { creerDepense } from '../../server/db/queries/depenses.js';
import { creerEvenement, repondre } from '../../server/db/queries/evenements.js';
import { creerAlbum, enregistrerConfigImmich, synchroniserAssetsAlbum } from '../../server/db/queries/immich.js';
import { lireTableauDeBord } from '../../server/db/queries/tableau-de-bord.js';
import { verifierSignatureMedia } from '../../server/domain/immich.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';

const T0 = '2026-11-15T10:00:00Z';
const MAINTENANT = new Date(T0);

describe('tableau de bord multi-groupes : lireTableauDeBord', () => {
  let t: BaseTemporaire;
  let dg: DeuxGroupes;
  let secretUrlSignee: string;

  beforeEach(() => {
    t = baseTemporaire();
    dg = deuxGroupes(t.base);
    secretUrlSignee = randomBytes(32).toString('base64');
  });

  afterEach(() => {
    t.nettoyer();
  });

  function ajouterAutreMembre(groupId: string, userId: string, membershipId: string, displayName: string): void {
    t.sql
      .prepare(`INSERT INTO users (id, email, username, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(userId, `${userId}@exemple.test`, `user_${userId}`, displayName, T0, T0);
    t.sql
      .prepare(
        `INSERT INTO memberships (id, group_id, user_id, role, joined_at, created_at, updated_at)
         VALUES (?, ?, ?, 'member', ?, ?, ?)`,
      )
      .run(membershipId, groupId, userId, T0, T0, T0);
  }

  it('retourne uniquement les événements, créneaux personnels, dépenses, soldes et photos signées de A pour Alice, jamais ceux de B', () => {
    // Un deuxième membre dans A et dans B pour produire des soldes non nuls.
    ajouterAutreMembre(dg.a.groupId, 'uA2', 'mA2', 'Camille A');
    ajouterAutreMembre(dg.b.groupId, 'uB2', 'mB2', 'Damien B');

    // Événements : eA et eB (2026-12-01) existent déjà via deuxGroupes.
    // On répond présent à eA, et on crée un brouillon dans A (qui ne doit pas apparaître) + un événement hors fenêtre > 90j.
    repondre(dg.scopeA, dg.a.eventId, { status: 'yes', guests_count: 0, comment: null }, T0);
    creerEvenement(dg.scopeA, {
      title: 'Hors fenêtre',
      description: null,
      location_name: null,
      location_address: null,
      location_lat: null,
      location_lon: null,
      all_day: false,
      starts_at: '2027-06-01T18:00:00Z',
      ends_at: null,
      time_zone: 'Europe/Paris',
      arrival_note: null,
      host_membership_id: null,
      currency_code: null,
      capacity: null,
    });
    const { id: idBrouillonA } = creerEvenement(dg.scopeA, {
      title: 'Brouillon A',
      description: null,
      location_name: null,
      location_address: null,
      location_lat: null,
      location_lon: null,
      all_day: false,
      starts_at: '2026-12-05T18:00:00Z',
      ends_at: null,
      time_zone: 'Europe/Paris',
      arrival_note: null,
      host_membership_id: null,
      currency_code: null,
      capacity: null,
    });
    t.sql.prepare(`UPDATE events SET status = 'draft' WHERE id = ?`).run(idBrouillonA);

    // Créneaux personnels : un pour Alice (uA), un pour Bob (uB).
    const porteeAlice = creerPorteeUtilisateur(t.base, dg.a.userId);
    const porteeBob = creerPorteeUtilisateur(t.base, dg.b.userId);
    creerCreneauPersonnel(porteeAlice, {
      title: 'Dentiste Alice',
      description: null,
      location_name: null,
      all_day: false,
      starts_at: '2026-11-20T09:00:00Z',
      ends_at: '2026-11-20T10:00:00Z',
      time_zone: 'Europe/Paris',
    });
    creerCreneauPersonnel(porteeBob, {
      title: 'Dentiste Bob',
      description: null,
      location_name: null,
      all_day: false,
      starts_at: '2026-11-21T09:00:00Z',
      ends_at: '2026-11-21T10:00:00Z',
      time_zone: 'Europe/Paris',
    });

    // Dépenses : Alice paie 2000 centimes partagés à parts égales entre mA et mA2 (solde Alice = +1000).
    creerDepense(
      dg.scopeA,
      {
        event_id: dg.a.eventId,
        label: 'Courses A',
        spent_on: '2026-11-14',
        payer_membership_id: dg.a.membershipId,
        amount_minor: 2000,
        currency_code: 'EUR',
        target_currency_code: 'EUR',
        rate_ppm: 1_000_000,
        rate_source: 'identity',
        rate_fetched_at: null,
        amount_target_minor: 2000,
        split_mode: 'equal',
        note: null,
      },
      [
        { membership_id: dg.a.membershipId, weight: 1, share_minor: 1000, share_target_minor: 1000 },
        { membership_id: 'mA2', weight: 1, share_minor: 1000, share_target_minor: 1000 },
      ],
    );
    // Dépense dans B pour Bob.
    creerDepense(
      dg.scopeB,
      {
        event_id: dg.b.eventId,
        label: 'Courses B',
        spent_on: '2026-11-14',
        payer_membership_id: dg.b.membershipId,
        amount_minor: 4000,
        currency_code: 'EUR',
        target_currency_code: 'EUR',
        rate_ppm: 1_000_000,
        rate_source: 'identity',
        rate_fetched_at: null,
        amount_target_minor: 4000,
        split_mode: 'equal',
        note: null,
      },
      [
        { membership_id: dg.b.membershipId, weight: 1, share_minor: 2000, share_target_minor: 2000 },
        { membership_id: 'mB2', weight: 1, share_minor: 2000, share_target_minor: 2000 },
      ],
    );

    // Config Immich + albums + photos dans A et dans B.
    const configBase = {
      base_url: 'https://immich.exemple.test',
      api_key_cipher: Buffer.from('cipher'),
      api_key_nonce: Buffer.from('0123456789ab'),
      api_key_fingerprint: 'deadbeef',
      immich_user_id: null,
      status: 'ok' as const,
      last_checked_at: T0,
      last_error: null,
    };
    enregistrerConfigImmich(dg.scopeA, configBase);
    enregistrerConfigImmich(dg.scopeB, configBase);

    const albumA = creerAlbum(dg.scopeA, { title: 'Album A', event_id: dg.a.eventId, immich_album_id: 'imm-alb-a' });
    synchroniserAssetsAlbum(
      dg.scopeA,
      albumA.id,
      [{ id: 'asset-a1', type: 'IMAGE', fileCreatedAt: '2026-11-14T12:00:00Z', exifInfo: null, duration: null }],
      T0,
    );

    const albumB = creerAlbum(dg.scopeB, { title: 'Album B', event_id: dg.b.eventId, immich_album_id: 'imm-alb-b' });
    synchroniserAssetsAlbum(
      dg.scopeB,
      albumB.id,
      [{ id: 'asset-b1', type: 'IMAGE', fileCreatedAt: '2026-11-14T12:00:00Z', exifInfo: null, duration: null }],
      T0,
    );

    const tdbAlice = lireTableauDeBord(t.base, porteeAlice, {
      maintenant: MAINTENANT,
      signedUrlSecret: secretUrlSignee,
    });

    // Groupes : uniquement A.
    expect(tdbAlice.groupes).toEqual([
      { group_id: dg.a.groupId, name: 'Groupe A', role: 'admin', photos_actives: true },
    ]);

    // Événements de groupe : uniquement eA (publié et dans les 90 jours), avec ma_presence = 'yes'.
    expect(tdbAlice.evenements).toHaveLength(1);
    expect(tdbAlice.evenements[0]).toMatchObject({
      id: dg.a.eventId,
      group_id: dg.a.groupId,
      group_name: 'Groupe A',
      title: 'Soirée A',
      ma_presence: 'yes',
      type: 'groupe',
    });

    // Créneaux personnels : uniquement celui d'Alice.
    expect(tdbAlice.evenements_perso).toHaveLength(1);
    expect(tdbAlice.evenements_perso[0]?.title).toBe('Dentiste Alice');

    // Dépenses : uniquement celles de A (Dépense A du 2026-12-01 puis Courses A du 2026-11-14), jamais celles de B.
    expect(tdbAlice.depenses.map((d) => d.label)).toEqual(['Dépense A', 'Courses A']);
    expect(tdbAlice.depenses[1]).toMatchObject({
      group_id: dg.a.groupId,
      group_name: 'Groupe A',
      label: 'Courses A',
      payer_name: 'Membre A',
    });

    // Soldes : uniquement le solde non nul de A (+1000 EUR).
    expect(tdbAlice.soldes).toEqual([
      { group_id: dg.a.groupId, group_name: 'Groupe A', currency_code: 'EUR', net_minor: 1000 },
    ]);

    // Photos : uniquement asset-a1, avec URL signée valide pour Alice.
    expect(tdbAlice.photos).toHaveLength(1);
    const photoA = tdbAlice.photos[0];
    expect(photoA).toMatchObject({
      album_id: albumA.id,
      album_title: 'Album A',
      group_id: dg.a.groupId,
      group_name: 'Groupe A',
      immich_asset_id: 'asset-a1',
      kind: 'image',
    });
    if (photoA === undefined) throw new Error('Photo attendue');
    const parsedUrl = new URL(photoA.thumbnail_url, 'https://exemple.test');
    expect(parsedUrl.pathname).toBe(`/media/${albumA.id}/asset-a1/thumbnail`);
    const verif = verifierSignatureMedia(
      {
        albumId: albumA.id,
        assetId: 'asset-a1',
        taille: 'thumbnail',
        userId: dg.a.userId,
        exp: parsedUrl.searchParams.get('exp') ?? '',
        sig: parsedUrl.searchParams.get('sig') ?? '',
        maintenant: MAINTENANT,
      },
      secretUrlSignee,
    );
    expect(verif).toMatchObject({ valide: true, taille: 'thumbnail' });
  });

  it("vide toutes les données du groupe A si Alice est retirée de A (status = 'removed')", () => {
    ajouterAutreMembre(dg.a.groupId, 'uA2', 'mA2', 'Camille A');
    creerDepense(
      dg.scopeA,
      {
        event_id: dg.a.eventId,
        label: 'Courses A',
        spent_on: '2026-11-14',
        payer_membership_id: dg.a.membershipId,
        amount_minor: 2000,
        currency_code: 'EUR',
        target_currency_code: 'EUR',
        rate_ppm: 1_000_000,
        rate_source: 'identity',
        rate_fetched_at: null,
        amount_target_minor: 2000,
        split_mode: 'equal',
        note: null,
      },
      [
        { membership_id: dg.a.membershipId, weight: 1, share_minor: 1000, share_target_minor: 1000 },
        { membership_id: 'mA2', weight: 1, share_minor: 1000, share_target_minor: 1000 },
      ],
    );
    enregistrerConfigImmich(dg.scopeA, {
      base_url: 'https://immich.exemple.test',
      api_key_cipher: Buffer.from('cipher'),
      api_key_nonce: Buffer.from('0123456789ab'),
      api_key_fingerprint: 'deadbeef',
      immich_user_id: null,
      status: 'ok',
      last_checked_at: T0,
      last_error: null,
    });
    const albumA = creerAlbum(dg.scopeA, { title: 'Album A', event_id: dg.a.eventId, immich_album_id: 'imm-alb-a' });
    synchroniserAssetsAlbum(
      dg.scopeA,
      albumA.id,
      [{ id: 'asset-a1', type: 'IMAGE', fileCreatedAt: '2026-11-14T12:00:00Z', exifInfo: null, duration: null }],
      T0,
    );

    // Retrait d'Alice du groupe A.
    t.sql.prepare(`UPDATE memberships SET status = 'removed', ended_at = ? WHERE id = ?`).run(T0, dg.a.membershipId);

    const porteeAlice = creerPorteeUtilisateur(t.base, dg.a.userId);
    const tdb = lireTableauDeBord(t.base, porteeAlice, {
      maintenant: MAINTENANT,
      signedUrlSecret: secretUrlSignee,
    });

    expect(tdb.groupes).toEqual([]);
    expect(tdb.evenements).toEqual([]);
    expect(tdb.depenses).toEqual([]);
    expect(tdb.soldes).toEqual([]);
    expect(tdb.photos).toEqual([]);
  });

  it('filtre les événements de groupe et créneaux personnels selon la fenêtre { du, au } fournie', () => {
    creerEvenement(dg.scopeA, {
      title: 'Événement Juin 2027',
      description: null,
      location_name: null,
      location_address: null,
      location_lat: null,
      location_lon: null,
      all_day: false,
      starts_at: '2027-06-10T18:00:00Z',
      ends_at: null,
      time_zone: 'Europe/Paris',
      arrival_note: null,
      host_membership_id: null,
      currency_code: null,
      capacity: null,
    });

    const porteeAlice = creerPorteeUtilisateur(t.base, dg.a.userId);
    creerCreneauPersonnel(porteeAlice, {
      title: 'Perso Novembre 2026',
      description: null,
      location_name: null,
      all_day: false,
      starts_at: '2026-11-20T09:00:00Z',
      ends_at: '2026-11-20T10:00:00Z',
      time_zone: 'Europe/Paris',
    });
    creerCreneauPersonnel(porteeAlice, {
      title: 'Perso Juin 2027',
      description: null,
      location_name: null,
      all_day: false,
      starts_at: '2027-06-15T14:00:00Z',
      ends_at: '2027-06-15T15:00:00Z',
      time_zone: 'Europe/Paris',
    });

    const tdbJuin = lireTableauDeBord(t.base, porteeAlice, {
      maintenant: MAINTENANT,
      signedUrlSecret: secretUrlSignee,
      du: '2027-05-31',
      au: '2027-07-02',
    });

    expect(tdbJuin.evenements.map((e) => e.title)).toEqual(['Événement Juin 2027']);
    expect(tdbJuin.evenements[0]?.time_zone).toBe('Europe/Paris');
    expect(tdbJuin.evenements_perso.map((e) => e.title)).toEqual(['Perso Juin 2027']);
    expect(tdbJuin.evenements_perso[0]?.time_zone).toBe('Europe/Paris');
  });
});
