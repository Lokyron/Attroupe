import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listerDevises, lireDevise } from '../../server/db/queries/depenses.js';
import { creerEvenement } from '../../server/db/queries/evenements.js';
import { creerScope, type GroupScope } from '../../server/db/scope.js';
import type { Contexte } from '../../server/http/contexte.js';
import { ErreurHttp } from '../../server/http/erreurs.js';
import { JOURNAL_SILENCIEUX } from '../../server/http/middleware/journal.js';
import { LimiteurCadence, REGLES_PAR_DEFAUT } from '../../server/services/cadence.js';
import {
  calculerSoldesGroupe,
  cloturerEvenementService,
  confirmerRemboursementService,
  creerDepenseService,
  creerRemboursementService,
  lireDepenseService,
  listerDepensesService,
  modifierDepenseService,
  reouvrirEvenementService,
  supprimerDepenseService,
} from '../../server/services/depenses.js';
import { DiffuseurTempsReel } from '../../server/services/temps-reel.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';

const T0 = '2026-06-01T10:00:00Z';

function capturerErreurHttp(fn: () => unknown): ErreurHttp {
  try {
    fn();
  } catch (e) {
    if (e instanceof ErreurHttp) return e;
    throw e;
  }
  throw new Error('Une ErreurHttp était attendue.');
}

describe('service dépenses, remboursements, soldes et clôture (lot 9)', () => {
  let t: BaseTemporaire;
  let dg: DeuxGroupes;
  let contexte: Contexte;
  let scopeAlice: GroupScope;
  let scopeCarole: GroupScope;
  let scopeErin: GroupScope;
  let mAlice: string;
  let mCarole: string;
  let mErin: string;
  let mInactif: string;

  beforeEach(() => {
    t = baseTemporaire();
    dg = deuxGroupes(t.base);
    const horloge = (): Date => new Date(T0);
    contexte = {
      base: t.base,
      env: {
        NODE_ENV: 'test',
        PORT: 0,
        ATTROUPE_DB_PATH: ':memory:',
        ATTROUPE_BASE_URL: 'http://localhost',
        ATTROUPE_SESSION_SECRET: 'x'.repeat(32),
        ATTROUPE_LOG_LEVEL: 'silent',
        ATTROUPE_TRUST_PROXY: 0,
        ATTROUPE_SIGNUP_OPEN: true,
        ATTROUPE_SSE_MAX_CONNECTIONS: 20,
      } as unknown as Contexte['env'],
      journal: JOURNAL_SILENCIEUX,
      horloge,
      limiteur: new LimiteurCadence(horloge),
      regles: REGLES_PAR_DEFAUT,
      parametresScrypt: { N: 16384, r: 8, p: 1 },
      delaiMinimalOubliMs: 0,
      cookieSecurise: false,
      diffuseur: new DiffuseurTempsReel({ horloge, journal: JOURNAL_SILENCIEUX }),
    };

    const ajouterMembre = (userId: string, email: string, username: string, membershipId: string, role: 'admin' | 'member', status = 'active'): void => {
      t.sql
        .prepare(
          `INSERT INTO users (id, email, username, display_name, password_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'hash', ?, ?)`,
        )
        .run(userId, email, username, username, T0, T0);
      t.sql
        .prepare(
          `INSERT INTO memberships (id, group_id, user_id, role, status, joined_at, ended_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(membershipId, dg.a.groupId, userId, role, status, T0, status === 'active' ? null : T0, T0, T0);
    };

    mAlice = dg.a.membershipId;
    mCarole = 'm_carole';
    mErin = 'm_erin';
    mInactif = 'm_inactif';
    t.sql.prepare('DELETE FROM expenses WHERE group_id = ?').run(dg.a.groupId);
    ajouterMembre('u_carole', 'carole@test.local', 'Carole', mCarole, 'member');
    ajouterMembre('u_erin', 'erin@test.local', 'Erin', mErin, 'member');
    ajouterMembre('u_inactif', 'inactif@test.local', 'Inactif', mInactif, 'member', 'removed');

    scopeAlice = creerScope(t.base, dg.a.userId, dg.a.groupId);
    scopeCarole = creerScope(t.base, 'u_carole', dg.a.groupId);
    scopeErin = creerScope(t.base, 'u_erin', dg.a.groupId);
  });

  afterEach(() => {
    contexte.diffuseur.fermerTout();
    t.nettoyer();
  });

  it('liste et lit les devises activées dont EUR et JPY (exposant 0)', () => {
    const devises = listerDevises(t.base);
    expect(devises.length).toBeGreaterThanOrEqual(15);
    const jpy = lireDevise(t.base, 'JPY');
    expect(jpy).toMatchObject({ code: 'JPY', exponent: 0, symbol: '¥' });
    expect(lireDevise(t.base, 'ZZZ')).toBeUndefined();
  });

  it('crée une dépense en EUR, répartit le reliquat et calcule les soldes', () => {
    const dep = creerDepenseService(contexte, scopeAlice, {
      event_id: null,
      label: 'Courses apéro',
      spent_on: '2026-06-01',
      payer_membership_id: mAlice,
      amount_minor: 1000,
      currency_code: 'EUR',
      split_mode: 'equal',
      note: null,
      shares: [{ membership_id: mAlice }, { membership_id: mCarole }, { membership_id: mErin }],
    });

    expect(dep.amount_target_minor).toBe(1000);
    expect(dep.rate_ppm).toBe(1_000_000);
    expect(dep.rate_source).toBe('identity');
    const sommeParts = dep.shares.reduce((s, p) => s + p.share_target_minor, 0);
    expect(sommeParts).toBe(1000);

    const bilan = calculerSoldesGroupe(scopeAlice);
    expect(bilan.ardoises).toHaveLength(1);
    const ardoiseEur = bilan.ardoises[0];
    expect(ardoiseEur).toBeDefined();
    expect(ardoiseEur?.currency_code).toBe('EUR');
    expect(ardoiseEur?.transferts.length).toBe(2);
  });

  it('convertit les montants multi-devises, y compris JPY (exposant 0) vers EUR (exposant 2)', () => {
    // 1000 JPY à 0.006 EUR/JPY (rate_ppm = 6000) -> 1000 * 6000 * 10^2 / 1_000_000 = 600 centimes (6,00 €)
    const dep = creerDepenseService(contexte, scopeAlice, {
      event_id: null,
      label: 'Ramen Tokyo',
      spent_on: '2026-06-01',
      payer_membership_id: mAlice,
      amount_minor: 1000,
      currency_code: 'JPY',
      rate_ppm: 6000,
      split_mode: 'equal',
      note: null,
      shares: [{ membership_id: mAlice }, { membership_id: mCarole }],
    });

    expect(dep.currency_code).toBe('JPY');
    expect(dep.target_currency_code).toBe('EUR');
    expect(dep.amount_target_minor).toBe(600);
    expect(dep.shares.map((s) => s.share_target_minor)).toEqual([300, 300]);
  });

  it('rejette une somme exacte inexacte avec 422, une devise inconnue avec 400, et un taux manquant avec 400', () => {
    const errExact = capturerErreurHttp(() =>
      creerDepenseService(contexte, scopeAlice, {
        event_id: null,
        label: 'Test exact',
        spent_on: '2026-06-01',
        payer_membership_id: mAlice,
        amount_minor: 1000,
        currency_code: 'EUR',
        split_mode: 'exact',
        note: null,
        shares: [
          { membership_id: mAlice, share_minor: 400 },
          { membership_id: mCarole, share_minor: 500 },
        ],
      }),
    );
    expect(errExact.statut).toBe(422);
    expect(errExact.cle).toBe('depense.somme_parts_inexacte');

    const errDevise = capturerErreurHttp(() =>
      creerDepenseService(contexte, scopeAlice, {
        event_id: null,
        label: 'Devise inconnue',
        spent_on: '2026-06-01',
        payer_membership_id: mAlice,
        amount_minor: 1000,
        currency_code: 'ZZZ',
        rate_ppm: 1_000_000,
        split_mode: 'equal',
        note: null,
        shares: [{ membership_id: mAlice }],
      }),
    );
    expect(errDevise.statut).toBe(400);
    expect(errDevise.cle).toBe('devise.inconnue');

    const errTaux = capturerErreurHttp(() =>
      creerDepenseService(contexte, scopeAlice, {
        event_id: null,
        label: 'Sans taux',
        spent_on: '2026-06-01',
        payer_membership_id: mAlice,
        amount_minor: 1000,
        currency_code: 'USD',
        split_mode: 'equal',
        note: null,
        shares: [{ membership_id: mAlice }],
      }),
    );
    expect(errTaux.statut).toBe(400);
    expect(errTaux.cle).toBe('taux.requis');
  });

  it('refuse un membre hors groupe (404) ou inactif (409)', () => {
    const errHorsGroupe = capturerErreurHttp(() =>
      creerDepenseService(contexte, scopeAlice, {
        event_id: null,
        label: 'Hors groupe',
        spent_on: '2026-06-01',
        payer_membership_id: dg.b.membershipId,
        amount_minor: 500,
        currency_code: 'EUR',
        split_mode: 'equal',
        note: null,
        shares: [{ membership_id: mAlice }],
      }),
    );
    expect(errHorsGroupe.statut).toBe(404);
    expect(errHorsGroupe.cle).toBe('membre.introuvable');

    const errInactif = capturerErreurHttp(() =>
      creerDepenseService(contexte, scopeAlice, {
        event_id: null,
        label: 'Inactif',
        spent_on: '2026-06-01',
        payer_membership_id: mAlice,
        amount_minor: 500,
        currency_code: 'EUR',
        split_mode: 'equal',
        note: null,
        shares: [{ membership_id: mInactif }],
      }),
    );
    expect(errInactif.statut).toBe(409);
    expect(errInactif.cle).toBe('membre.inactif');
  });

  it('applique les droits fins sur modification/suppression (403) et confirmation de remboursement (403)', () => {
    const dep = creerDepenseService(contexte, scopeAlice, {
      event_id: null,
      label: 'Restaurant',
      spent_on: '2026-06-01',
      payer_membership_id: mCarole,
      amount_minor: 2000,
      currency_code: 'EUR',
      split_mode: 'equal',
      note: null,
      shares: [{ membership_id: mAlice }, { membership_id: mCarole }],
    });

    // Erin (ni auteur, ni payeur, ni admin) ne peut pas modifier ou supprimer
    const errModif = capturerErreurHttp(() => modifierDepenseService(contexte, scopeErin, dep.id, { label: 'Pirate' }));
    expect(errModif.statut).toBe(403);
    expect(errModif.cle).toBe('droit.depense_requise');

    const errSuppr = capturerErreurHttp(() => supprimerDepenseService(contexte, scopeErin, dep.id));
    expect(errSuppr.statut).toBe(403);
    expect(errSuppr.cle).toBe('droit.depense_requise');

    // Carole (payeur) peut modifier
    const modifiee = modifierDepenseService(contexte, scopeCarole, dep.id, { label: 'Bistro' });
    expect(modifiee.label).toBe('Bistro');
    expect(lireDepenseService(scopeAlice, dep.id).label).toBe('Bistro');

    // Remboursement de Carole vers Alice : seule Alice (bénéficiaire) peut confirmer
    const remb = creerRemboursementService(contexte, scopeCarole, {
      event_id: null,
      from_membership_id: mCarole,
      to_membership_id: mAlice,
      amount_minor: 1000,
      currency_code: 'EUR',
      settled_on: '2026-06-02',
      method_note: 'Espèces',
    });

    const errConf = capturerErreurHttp(() => confirmerRemboursementService(contexte, scopeCarole, remb.id));
    expect(errConf.statut).toBe(403);
    expect(errConf.cle).toBe('droit.beneficiaire_requis');

    const confirme = confirmerRemboursementService(contexte, scopeAlice, remb.id);
    expect(confirme.confirmed_by_membership_id).toBe(mAlice);
  });

  it('clôture un événement (fige les soldes, bloque 409 les modifications) puis le rouvre', () => {
    const evt = creerEvenement(scopeAlice, {
      title: 'Week-end ski',
      description: null,
      location_name: null,
      location_address: null,
      location_lat: null,
      location_lon: null,
      all_day: true,
      starts_at: '2026-06-10',
      ends_at: null,
      time_zone: 'Europe/Paris',
      arrival_note: null,
      host_membership_id: null,
      currency_code: 'EUR',
      capacity: null,
    });

    const dep = creerDepenseService(contexte, scopeAlice, {
      event_id: evt.id,
      label: 'Chalet',
      spent_on: '2026-06-10',
      payer_membership_id: mAlice,
      amount_minor: 4000,
      currency_code: 'EUR',
      split_mode: 'equal',
      note: null,
      shares: [{ membership_id: mAlice }, { membership_id: mCarole }],
    });

    // Un membre simple non organisateur ne peut pas clôturer
    const errCloture = capturerErreurHttp(() => cloturerEvenementService(contexte, scopeErin, evt.id));
    expect(errCloture.statut).toBe(403);
    expect(errCloture.cle).toBe('droit.organisateur_requis');

    const cloture = cloturerEvenementService(contexte, scopeAlice, evt.id);
    expect(cloture.cloture).not.toBeNull();
    expect(cloture.cloture?.total_minor).toBe(4000);

    // Toute écriture rattachée à l'événement clôturé échoue en 409
    const errAjout = capturerErreurHttp(() =>
      creerDepenseService(contexte, scopeAlice, {
        event_id: evt.id,
        label: 'Après clôture',
        spent_on: '2026-06-11',
        payer_membership_id: mAlice,
        amount_minor: 500,
        currency_code: 'EUR',
        split_mode: 'equal',
        note: null,
        shares: [{ membership_id: mAlice }],
      }),
    );
    expect(errAjout.statut).toBe(409);
    expect(errAjout.cle).toBe('evenement.cloture');

    const errModif = capturerErreurHttp(() => modifierDepenseService(contexte, scopeAlice, dep.id, { label: 'Modif' }));
    expect(errModif.statut).toBe(409);
    expect(errModif.cle).toBe('evenement.cloture');

    // Réouverture : les écritures redeviennent possibles
    const reouvert = reouvrirEvenementService(contexte, scopeAlice, evt.id);
    expect(reouvert.cloture).toBeNull();
    expect(listerDepensesService(scopeAlice, { event_id: evt.id })).toHaveLength(1);

    const nouvelleDep = creerDepenseService(contexte, scopeAlice, {
      event_id: evt.id,
      label: 'Après réouverture',
      spent_on: '2026-06-11',
      payer_membership_id: mAlice,
      amount_minor: 500,
      currency_code: 'EUR',
      split_mode: 'equal',
      note: null,
      shares: [{ membership_id: mAlice }],
    });
    expect(nouvelleDep.label).toBe('Après réouverture');
  });
});
