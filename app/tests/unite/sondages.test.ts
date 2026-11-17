import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { creerScope } from '../../server/db/scope.js';
import {
  calculerCompteurs,
  classerOptions,
  comparerOptions,
  memeCreneauOption,
  optionGagnante,
  optionsOntDoublon,
  sondageOuvert,
} from '../../server/domain/sondages.js';
import type { Contexte } from '../../server/http/contexte.js';
import {
  ajouterOption,
  annulerSondage,
  convertirSondage,
  creerSondage,
  detailSondage,
  listerSondages,
  modifierSondage,
  retirerOption,
  voterSondage,
} from '../../server/services/sondages.js';
import { DiffuseurTempsReel } from '../../server/services/temps-reel.js';
import { baseTemporaire, deuxGroupes, type BaseTemporaire, type DeuxGroupes } from '../fixtures/base.js';

describe('calculerCompteurs (pondération : oui = 2, peut-être = 1, non = 0)', () => {
  it('retourne zéro partout sans vote', () => {
    expect(calculerCompteurs([])).toEqual({ yes: 0, maybe: 0, no: 0, score: 0 });
  });

  it('additionne les oui (×2), les peut-être (×1) et ignore les non dans le score', () => {
    expect(calculerCompteurs(['yes', 'yes', 'maybe', 'no', 'no'])).toEqual({
      yes: 2,
      maybe: 1,
      no: 2,
      score: 5,
    });
    expect(calculerCompteurs([{ value: 'maybe' }, { value: 'yes' }, { value: 'no' }])).toEqual({
      yes: 1,
      maybe: 1,
      no: 1,
      score: 3,
    });
  });
});

describe('départage déterministe des options (classerOptions / optionGagnante)', () => {
  it('retourne null quand il n’y a aucune option', () => {
    expect(optionGagnante([])).toBeNull();
  });

  it('1. classe d’abord par score décroissant', () => {
    const a = { id: 'opt-a', position: 1, compteurs: { yes: 1, score: 2 } };
    const b = { id: 'opt-b', position: 2, compteurs: { yes: 2, score: 4 } };
    const c = { id: 'opt-c', position: 3, compteurs: { yes: 1, score: 3 } };
    expect(classerOptions([a, b, c]).map((o) => o.id)).toEqual(['opt-b', 'opt-c', 'opt-a']);
    expect(optionGagnante([a, b, c])?.id).toBe('opt-b');
  });

  it('2. à score égal, départage par nombre de « oui » décroissant (1 oui bat 2 peut-être)', () => {
    const deuxPeutEtre = { id: 'opt-1', position: 1, compteurs: calculerCompteurs(['maybe', 'maybe']) };
    const unOui = { id: 'opt-2', position: 2, compteurs: calculerCompteurs(['yes', 'no']) };
    expect(deuxPeutEtre.compteurs.score).toBe(2);
    expect(unOui.compteurs.score).toBe(2);
    expect(classerOptions([deuxPeutEtre, unOui]).map((o) => o.id)).toEqual(['opt-2', 'opt-1']);
    expect(optionGagnante([deuxPeutEtre, unOui])?.id).toBe('opt-2');
  });

  it('3. à score et nombre de « oui » égaux, départage par position croissante', () => {
    const tardive = { id: 'opt-a', position: 5, compteurs: { yes: 2, score: 4 } };
    const premiere = { id: 'opt-z', position: 1, compteurs: { yes: 2, score: 4 } };
    expect(classerOptions([tardive, premiere]).map((o) => o.id)).toEqual(['opt-z', 'opt-a']);
  });

  it('4. à score, nombre de « oui » et position égaux, départage par identifiant lexicographique croissant', () => {
    const b = { id: 'opt-b', position: 1, compteurs: { yes: 1, score: 2 } };
    const a = { id: 'opt-a', position: 1, compteurs: { yes: 1, score: 2 } };
    expect(classerOptions([b, a]).map((o) => o.id)).toEqual(['opt-a', 'opt-b']);
    expect(comparerOptions(a, a)).toBe(0);
  });
});

describe('détection des doublons d’options', () => {
  it('distingue des créneaux de début ou de fin différents', () => {
    expect(
      optionsOntDoublon([
        { all_day: false, starts_at: '2027-04-10T18:00:00Z', ends_at: null },
        { all_day: false, starts_at: '2027-04-10T18:00:00Z', ends_at: '2027-04-10T22:00:00Z' },
        { all_day: true, starts_at: '2027-04-10', ends_at: null },
      ]),
    ).toBe(false);
  });

  it('détecte deux options ayant le même triplet (all_day, starts_at, ends_at)', () => {
    expect(
      optionsOntDoublon([
        { all_day: false, starts_at: '2027-04-10T18:00:00Z', ends_at: null },
        { all_day: false, starts_at: '2027-04-11T18:00:00Z', ends_at: null },
        { all_day: false, starts_at: '2027-04-10T18:00:00Z', ends_at: undefined },
      ]),
    ).toBe(true);
    expect(
      memeCreneauOption(
        { all_day: true, starts_at: '2027-04-10', ends_at: '2027-04-12' },
        { all_day: true, starts_at: '2027-04-10', ends_at: '2027-04-12' },
      ),
    ).toBe(true);
  });
});

describe('sondageOuvert', () => {
  const maintenant = '2027-04-01T12:00:00Z';

  it('est ouvert si status = open et closes_at est null ou futur', () => {
    expect(sondageOuvert({ status: 'open', closes_at: null }, maintenant)).toBe(true);
    expect(sondageOuvert({ status: 'open', closes_at: '2027-04-01T12:00:01Z' }, maintenant)).toBe(true);
  });

  it('est fermé dès que closes_at <= maintenant ou que status !== open', () => {
    expect(sondageOuvert({ status: 'open', closes_at: maintenant }, maintenant)).toBe(false);
    expect(sondageOuvert({ status: 'open', closes_at: '2027-04-01T11:59:59Z' }, maintenant)).toBe(false);
    expect(sondageOuvert({ status: 'closed', closes_at: null }, maintenant)).toBe(false);
    expect(sondageOuvert({ status: 'converted', closes_at: null }, maintenant)).toBe(false);
    expect(sondageOuvert({ status: 'cancelled', closes_at: null }, maintenant)).toBe(false);
  });
});

describe('service et requêtes des sondages (parcours complet en base)', () => {
  let t: BaseTemporaire;
  let d: DeuxGroupes;
  let instantCourant: Date;
  let contexte: Contexte;

  beforeEach(() => {
    t = baseTemporaire();
    d = deuxGroupes(t.base);
    instantCourant = new Date('2027-04-01T10:00:00Z');
    contexte = {
      base: t.base,
      horloge: () => instantCourant,
      diffuseur: new DiffuseurTempsReel({ horloge: () => instantCourant }),
    } as unknown as Contexte;
  });
  afterEach(() => t.nettoyer());

  it('crée un sondage, gère les votes de 3 membres, départage et convertit en événement avec fil et trace bidirectionnelle', () => {
    const T0 = '2027-04-01T10:00:00Z';
    t.sql
      .prepare('INSERT INTO users (id, email, username, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('u2', 'bob2@exemple.test', 'bob2', 'Bob', T0, T0);
    t.sql
      .prepare('INSERT INTO memberships (id, group_id, user_id, role, status, joined_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('m2', d.a.groupId, 'u2', 'member', 'active', T0, T0, T0);
    t.sql
      .prepare('INSERT INTO users (id, email, username, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('u3', 'carole@exemple.test', 'carole', 'Carole', T0, T0);
    t.sql
      .prepare('INSERT INTO memberships (id, group_id, user_id, role, status, joined_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('m3', d.a.groupId, 'u3', 'member', 'active', T0, T0, T0);

    const scopeAlice = d.scopeA;
    const scopeAutreMembre = creerScope(t.base, 'u2', d.a.groupId);
    const scopeCarole = creerScope(t.base, 'u3', d.a.groupId);

    const cree = creerSondage(contexte, scopeAlice, {
      title: 'Dîner de printemps',
      description: 'Choisissez vos disponibilités',
      closes_at: '2027-04-05T18:00:00Z',
      options: [
        { all_day: false, starts_at: '2027-04-10T19:00:00Z', ends_at: '2027-04-10T23:00:00Z' },
        { all_day: false, starts_at: '2027-04-11T19:00:00Z', ends_at: '2027-04-11T23:00:00Z' },
      ],
    });
    expect(cree.options).toHaveLength(2);

    // Ajout d'une 3e option puis retrait
    const avecTrois = ajouterOption(contexte, scopeAlice, cree.id, {
      all_day: false,
      starts_at: '2027-04-12T19:00:00Z',
      ends_at: null,
    });
    expect(avecTrois.options).toHaveLength(3);
    const opt1 = avecTrois.options[0]?.id ?? '';
    const opt2 = avecTrois.options[1]?.id ?? '';
    const opt3 = avecTrois.options[2]?.id ?? '';

    voterSondage(contexte, scopeAlice, cree.id, opt3, 'yes');
    const apresRetrait = retirerOption(contexte, scopeAlice, cree.id, opt3);
    expect(apresRetrait.options.map((o) => o.id)).toEqual([opt1, opt2]);

    // Votes des 3 membres : opt1 = maybe + maybe + yes (score 4, 1 yes) ; opt2 = yes + yes + no (score 4, 2 yes -> gagnante)
    voterSondage(contexte, scopeAlice, cree.id, opt1, 'maybe');
    voterSondage(contexte, scopeAutreMembre, cree.id, opt1, 'maybe');
    voterSondage(contexte, scopeCarole, cree.id, opt1, 'yes');

    voterSondage(contexte, scopeAlice, cree.id, opt2, 'yes');
    voterSondage(contexte, scopeAutreMembre, cree.id, opt2, 'yes');
    const detail = voterSondage(contexte, scopeCarole, cree.id, opt2, 'no');

    expect(detail.option_gagnante_id).toBe(opt2);
    expect(detail.options.find((o) => o.id === opt1)?.compteurs).toEqual({ yes: 1, maybe: 2, no: 0, score: 4 });
    expect(detail.options.find((o) => o.id === opt2)?.compteurs).toEqual({ yes: 2, maybe: 0, no: 1, score: 4 });

    // Clôture par dépassement de closes_at : vote refusé (409 sondage.ferme)
    instantCourant = new Date('2027-04-06T00:00:00Z');
    expect(() => voterSondage(contexte, scopeAlice, cree.id, opt1, 'yes')).toThrowError('sondage.ferme');

    // Conversion en événement : trace bidirectionnelle + fil créé
    const { sondage: converti, evenement } = convertirSondage(contexte, scopeAlice, cree.id, {
      location_name: 'Bistrot du coin',
    });
    expect(converti.status).toBe('converted');
    expect(converti.resulting_event_id).toBe(evenement.id);
    expect(evenement.source_date_poll_id).toBe(cree.id);
    expect(evenement.starts_at).toBe('2027-04-11T19:00:00Z');
    expect(evenement.location_name).toBe('Bistrot du coin');
    expect(typeof evenement.thread_id).toBe('string');

    // Liste et refus après conversion
    expect(listerSondages(scopeAlice)).toHaveLength(1);
    expect(detailSondage(scopeAlice, cree.id).resulting_event_id).toBe(evenement.id);
    expect(() => modifierSondage(contexte, scopeAlice, cree.id, { title: 'Autre' })).toThrowError('sondage.deja_converti');
    expect(() => annulerSondage(contexte, scopeAlice, cree.id)).toThrowError('sondage.deja_converti');
    expect(() => convertirSondage(contexte, scopeAlice, cree.id, {})).toThrowError('sondage.deja_converti');
  });
});
