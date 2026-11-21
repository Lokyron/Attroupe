import { describe, expect, it } from 'vitest';
import {
  compterSurJours,
  couleursParGroupe,
  elementsCalendrier,
  entreesGrilleDepuisElements,
  evenementsAVenir,
  fenetreCalendrier,
  groupeCible,
  groupeDesPhotos,
  grouperParJour,
  lienElementCalendrier,
  prochainEvenement,
  nonTermines,
  dateEnClair,
  partiesSolde,
  actionsAttendues,
  soldesParGroupe,
  MAX_REPONSES_ATTENDUES,
  resumerSoldes,
} from '../../client/src/pages/tableau/selecteurs.js';

// Dérivations pures du tableau de bord (découpage de TableauDeBord.tsx) : aucune n'a besoin du DOM.
const groupe = (id: string, titre: string, debut: string, extra: object = {}) => ({
  id: `${id}-${titre}`,
  group_id: id,
  group_name: `Groupe ${id}`,
  title: titre,
  starts_at: debut,
  ends_at: null,
  all_day: true,
  time_zone: 'Europe/Paris',
  location_name: null,
  mon_statut: null,
  ...extra,
});
const perso = (titre: string, debut: string, extra: object = {}) => ({
  id: `perso-${titre}`,
  title: titre,
  starts_at: debut,
  ends_at: null,
  all_day: true,
  time_zone: 'Europe/Paris',
  location_name: null,
  ...extra,
});

const donnees = {
  evenements: [groupe('a', 'Dîner', '2027-03-20'), groupe('b', 'Randonnée', '2027-03-05')],
  evenements_perso: [perso('Dentiste', '2027-03-12')],
};

describe('éléments du calendrier', () => {
  it('fusionne groupes et agenda perso, triés par début', () => {
    const titres = elementsCalendrier(donnees, 'tous').map((e) => e.title);
    expect(titres).toEqual(['Randonnée', 'Dentiste', 'Dîner']);
  });

  it('l’onglet « perso » ne garde que le perso, l’onglet « groupes » que les groupes', () => {
    expect(elementsCalendrier(donnees, 'perso').map((e) => e.sorte)).toEqual(['perso']);
    expect(elementsCalendrier(donnees, 'groupes').every((e) => e.sorte === 'groupe')).toBe(true);
  });

  it('un événement sur plusieurs jours figure dans chacun', () => {
    const el = elementsCalendrier(
      { evenements: [groupe('a', 'Week-end', '2027-03-06', { ends_at: '2027-03-07' })], evenements_perso: [] },
      'tous',
    );
    const parJour = grouperParJour(el);
    expect([...parJour.keys()]).toEqual(['2027-03-06', '2027-03-07']);
    expect(compterSurJours(['2027-03-05', '2027-03-06', '2027-03-07'], parJour)).toBe(2);
  });
});

describe('événements à venir', () => {
  const elements = elementsCalendrier(donnees, 'tous');

  it('garde ce qui commence aujourd’hui ou plus tard', () => {
    expect(evenementsAVenir(elements, '2027-03-12').map((e) => e.title)).toEqual(['Dentiste', 'Dîner']);
    expect(evenementsAVenir(elements, '2027-04-01')).toEqual([]);
  });
});

describe('regroupement par jour (grouperParJour)', () => {
  const elements = elementsCalendrier(
    {
      evenements: [groupe('a', 'Long', '2027-03-10', { ends_at: '2027-03-12' }), groupe('a', 'Court', '2027-03-11')],
      evenements_perso: [perso('Seul', '2027-03-20')],
    },
    'tous',
  );

  it('range chaque élément dans chacun de ses jours, en gardant l’ordre d’entrée', () => {
    const parJour = grouperParJour(elements);
    expect([...parJour.keys()]).toEqual(['2027-03-10', '2027-03-11', '2027-03-12', '2027-03-20']);
    expect(parJour.get('2027-03-11')?.map((e) => e.title)).toEqual(['Long', 'Court']);
    expect(parJour.get('2027-03-12')?.map((e) => e.title)).toEqual(['Long']);
  });

  it('ne partage aucun tableau entre deux jours et ne modifie pas l’entrée', () => {
    const copie = [...elements];
    const parJour = grouperParJour(elements);
    expect(parJour.get('2027-03-10')).not.toBe(parJour.get('2027-03-11'));
    expect(elements).toEqual(copie);
  });

  it('rend une table vide pour une entrée vide et reste linéaire sur un grand volume', () => {
    expect(grouperParJour([]).size).toBe(0);
    const beaucoup = elementsCalendrier(
      { evenements: [], evenements_perso: Array.from({ length: 20000 }, (_, i) => perso(`E${i}`, '2027-03-12')) },
      'tous',
    );
    const debut = performance.now();
    const parJour = grouperParJour(beaucoup);
    expect(parJour.get('2027-03-12')).toHaveLength(20000);
    expect(performance.now() - debut).toBeLessThan(1000);
  });
});

describe('fenêtre du calendrier', () => {
  it('la liste n’en demande aucune', () => {
    expect(fenetreCalendrier('liste', '2027-03-10')).toBeUndefined();
  });

  it('le mois couvre sa grille complète, plus un jour de marge', () => {
    // La grille de mars 2027 va du lundi 1er au dimanche 4 avril.
    expect(fenetreCalendrier('mois', '2027-03-10')).toEqual({ du: '2027-02-28', au: '2027-04-05' });
  });

  it('la semaine couvre lundi à dimanche, plus un jour de marge', () => {
    expect(fenetreCalendrier('semaine', '2027-03-17')).toEqual({ du: '2027-03-14', au: '2027-03-22' });
  });
});

describe('soldes', () => {
  const solde = (g: string, devise: string, net: number) => ({ group_id: g, currency_code: devise, net_minor: net });

  it('sans solde : aucun', () => {
    expect(resumerSoldes([])).toEqual({ devises: [], total: 0, sens: 'aucun' });
  });

  it('additionne les groupes d’une même devise', () => {
    expect(resumerSoldes([solde('a', 'EUR', 500), solde('b', 'EUR', -200)])).toEqual({
      devises: [['EUR', 300]],
      total: 300,
      sens: 'positif',
    });
    expect(resumerSoldes([solde('a', 'EUR', -500)]).sens).toBe('negatif');
    expect(resumerSoldes([solde('a', 'EUR', 500), solde('b', 'EUR', -500)]).sens).toBe('equilibre');
  });

  it('n’additionne jamais deux devises', () => {
    const r = resumerSoldes([solde('a', 'EUR', 500), solde('b', 'USD', 700)]);
    expect(r.sens).toBe('multi');
    expect(r.devises).toEqual([['EUR', 500], ['USD', 700]]);
    expect(r.total).toBe(0);
  });
});

describe('groupes', () => {
  const g = (id: string, photos = false) => ({ group_id: id, photos_actives: photos });

  it('chaque groupe garde sa couleur selon son rang, en boucle', () => {
    const couleurs = couleursParGroupe(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => g(id)));
    expect(couleurs.get('a')).toBe('indigo');
    expect(couleurs.get('b')).toBe('cyan');
    expect(couleurs.get('g')).toBe('indigo');
  });

  it('la cible est l’unique groupe, sinon celui du filtre, sinon rien', () => {
    expect(groupeCible([g('a')], '')?.group_id).toBe('a');
    expect(groupeCible([g('a'), g('b')], 'b')?.group_id).toBe('b');
    expect(groupeCible([g('a'), g('b')], '')).toBeNull();
    expect(groupeCible([g('a'), g('b')], 'inconnu')).toBeNull();
    expect(groupeCible([], '')).toBeNull();
  });

  it('le groupe des photos : visibles d’abord, puis tous', () => {
    const a = g('a', true);
    const b = g('b', true);
    expect(groupeDesPhotos([b], [a, b])).toBe(b);
    expect(groupeDesPhotos([g('c')], [a, b])).toBe(a);
    expect(groupeDesPhotos([], [g('c')])).toBeUndefined();
  });
});

describe('liens', () => {
  it('un événement de groupe mène à sa page', () => {
    const [g] = elementsCalendrier({ evenements: [groupe('a/b', 'x', '2027-03-01')], evenements_perso: [] }, 'tous');
    expect(g && lienElementCalendrier(g)).toBe('#/groupe/a%2Fb/evenement/a%2Fb-x');
  });

  it('un événement personnel mène à sa propre page, pas au compte', () => {
    const [p] = elementsCalendrier({ evenements: [], evenements_perso: [perso('y/z', '2027-03-01')] }, 'tous');
    expect(p && lienElementCalendrier(p)).toBe('#/agenda/perso-y%2Fz');
  });
});

// Les cas « heure fixe » : la conversion de fuseau est le seul endroit où une erreur ne se voit pas à l'œil (un événement
// rangé la veille ou le lendemain). Fuseaux de référence en 2027 : Paris est en UTC+1 jusqu'au dimanche 28 mars (01 h UTC),
// puis en UTC+2 ; Los Angeles est en UTC-8 jusqu'au 14 mars.
describe('événements à heure fixe et fuseaux', () => {
  const fixe = (titre: string, debut: string, extra: object = {}) =>
    groupe('a', titre, debut, { all_day: false, time_zone: 'Europe/Paris', ...extra });
  const elementsDe = (...evenements: ReturnType<typeof fixe>[]) =>
    elementsCalendrier({ evenements, evenements_perso: [] }, 'tous');
  const joursRanges = (...evenements: ReturnType<typeof fixe>[]) => [...grouperParJour(elementsDe(...evenements)).keys()];

  it('un événement de 23 h 30 UTC est rangé au lendemain à Paris', () => {
    const el = elementsDe(fixe('Soirée tardive', '2027-03-11T23:30:00Z'));
    expect([...grouperParJour(el).keys()]).toEqual(['2027-03-12']);
    expect(evenementsAVenir(el, '2027-03-12').map((e) => e.title)).toEqual(['Soirée tardive']);
    // Il n'est plus à venir le 13, et il n'est pas non plus rangé au 11.
    expect(evenementsAVenir(el, '2027-03-13')).toEqual([]);
    expect(grouperParJour(el).has('2027-03-11')).toBe(false);
  });

  it('un événement du matin UTC reste le même jour à Paris', () => {
    const el = elementsDe(fixe('Petit-déjeuner', '2027-03-12T06:00:00Z'));
    expect(joursRanges(fixe('Petit-déjeuner', '2027-03-12T06:00:00Z'))).toEqual(['2027-03-12']);
    expect(evenementsAVenir(el, '2027-03-12')).toHaveLength(1);
    expect(evenementsAVenir(el, '2027-03-13')).toEqual([]);
  });

  it('à l’ouest de UTC, un événement de 3 h UTC est rangé à la veille', () => {
    // 03 h UTC le 12 = 19 h le 11 à Los Angeles (UTC-8).
    const e = fixe('Apéro californien', '2027-03-12T03:00:00Z', { time_zone: 'America/Los_Angeles' });
    expect(joursRanges(e)).toEqual(['2027-03-11']);
    expect(evenementsAVenir(elementsDe(e), '2027-03-11')).toHaveLength(1);
    expect(evenementsAVenir(elementsDe(e), '2027-03-12')).toEqual([]);
  });

  it('le même instant tombe un jour différent selon le fuseau de l’événement', () => {
    const instant = '2027-03-11T23:30:00Z';
    expect(joursRanges(fixe('Paris', instant))).toEqual(['2027-03-12']);
    expect(joursRanges(fixe('Londres', instant, { time_zone: 'Europe/London' }))).toEqual(['2027-03-11']);
    expect(joursRanges(fixe('Tokyo', instant, { time_zone: 'Asia/Tokyo' }))).toEqual(['2027-03-12']);
  });

  it('une journée entière et un événement à heure fixe du même jour : la journée entière passe en premier', () => {
    // Le tri compare les chaînes `starts_at` : « 2027-03-12 » est un préfixe de « 2027-03-12T… », donc il précède.
    const el = elementsDe(
      fixe('Dîner à 20 h', '2027-03-12T19:00:00Z'),
      fixe('Journée libre', '2027-03-12', { all_day: true }),
    );
    expect(el.map((e) => e.title)).toEqual(['Journée libre', 'Dîner à 20 h']);
    const parJour = grouperParJour(el);
    expect(parJour.get('2027-03-12')?.map((e) => e.title)).toEqual(['Journée libre', 'Dîner à 20 h']);
  });

  it('le tri compare l’instant UTC, pas le jour local : une soirée tardive précède la journée entière du jour local', () => {
    // 23 h 30 UTC le 11 est le 12 à 00 h 30 à Paris, mais « …-11T23:30 » < « …-12 » : l'ordre est figé tel qu'observé.
    // Pour l'utilisateur, cet événement du 12 s'affiche donc avant la journée entière du 12.
    const el = elementsDe(
      fixe('Journée libre', '2027-03-12', { all_day: true }),
      fixe('Soirée tardive', '2027-03-11T23:30:00Z'),
    );
    expect(el.map((e) => e.title)).toEqual(['Soirée tardive', 'Journée libre']);
    expect(grouperParJour(el).get('2027-03-12')?.map((e) => e.title)).toEqual(['Soirée tardive', 'Journée libre']);
  });

  it('la borne de début est incluse : un événement à minuit local pile est « à venir » ce jour-là', () => {
    // 23 h 00 UTC le 11 = 00 h 00 le 12 à Paris.
    const el = elementsDe(fixe('Minuit pile', '2027-03-11T23:00:00Z'));
    expect(evenementsAVenir(el, '2027-03-12')).toHaveLength(1);
    expect(evenementsAVenir(el, '2027-03-13')).toEqual([]);
  });

  it('une seconde avant minuit local, l’événement appartient encore à la veille', () => {
    const el = elementsDe(fixe('Juste avant', '2027-03-11T22:59:59Z'));
    expect(joursRanges(fixe('Juste avant', '2027-03-11T22:59:59Z'))).toEqual(['2027-03-11']);
    expect(evenementsAVenir(el, '2027-03-12')).toEqual([]);
  });

  it('la dernière seconde du jour local reste dans ce jour, et non dans le suivant', () => {
    // 22 h 59 min 59 s UTC le 12 = 23 h 59 min 59 s le 12 à Paris.
    const el = elementsDe(fixe('Dernière seconde', '2027-03-12T22:59:59Z'));
    expect(joursRanges(fixe('Dernière seconde', '2027-03-12T22:59:59Z'))).toEqual(['2027-03-12']);
    expect(evenementsAVenir(el, '2027-03-13')).toEqual([]);
  });

  it('une fin exactement à minuit local compte pour le jour suivant (borne de fin incluse)', () => {
    // Début le 12 à 22 h locale, fin le 13 à 00 h 00 locale (23 h UTC le 12) : l'événement touche le 12 et le 13.
    const e = fixe('Nuit', '2027-03-12T21:00:00Z', { ends_at: '2027-03-12T23:00:00Z' });
    expect(joursRanges(e)).toEqual(['2027-03-12', '2027-03-13']);
    // Une minute plus tôt, il ne déborde pas.
    const avant = fixe('Nuit courte', '2027-03-12T21:00:00Z', { ends_at: '2027-03-12T22:59:00Z' });
    expect(joursRanges(avant)).toEqual(['2027-03-12']);
  });

  it('un événement de nuit à cheval sur minuit figure dans les deux jours locaux', () => {
    const e = fixe('Soirée', '2027-03-12T21:00:00Z', { ends_at: '2027-03-13T01:00:00Z' });
    const parJour = grouperParJour(elementsDe(e));
    expect([...parJour.keys()]).toEqual(['2027-03-12', '2027-03-13']);
    expect(compterSurJours(['2027-03-12', '2027-03-13'], parJour)).toBe(2);
  });

  it('une fin antérieure au début ne produit pas de jour fantôme', () => {
    const e = fixe('Incohérent', '2027-03-12T10:00:00Z', { ends_at: '2027-03-10T10:00:00Z' });
    expect(joursRanges(e)).toEqual(['2027-03-12']);
  });

  it('passage à l’heure d’été : 00 h 30 UTC le 28 mars est encore en UTC+1, donc le 28 à 01 h 30', () => {
    expect(joursRanges(fixe('Avant bascule', '2027-03-28T00:30:00Z'))).toEqual(['2027-03-28']);
    // La veille au soir (UTC+1) : 23 h 30 UTC le 27 est déjà le 28 à Paris.
    expect(joursRanges(fixe('Veille', '2027-03-27T23:30:00Z'))).toEqual(['2027-03-28']);
  });

  it('après la bascule en UTC+2, 22 h 30 UTC est rangé au lendemain, alors que 21 h 30 UTC reste le jour même', () => {
    // La veille de la bascule, 22 h 30 UTC (UTC+1) donnerait 23 h 30 le 27 : le seuil de minuit local a glissé d'une heure.
    expect(joursRanges(fixe('Après bascule', '2027-03-28T22:30:00Z'))).toEqual(['2027-03-29']);
    expect(joursRanges(fixe('Juste avant minuit', '2027-03-28T21:30:00Z'))).toEqual(['2027-03-28']);
    expect(joursRanges(fixe('Avant bascule, même heure', '2027-03-27T22:30:00Z'))).toEqual(['2027-03-27']);
  });

  it('le mois d’un événement suit l’heure locale : 22 h 30 UTC le 31 mars est le 1er avril à Paris', () => {
    const el = elementsDe(fixe('Fin de mois', '2027-03-31T22:30:00Z'), fixe('Mi-mars', '2027-03-15T12:00:00Z'));
    const avenir = evenementsAVenir(el, '2027-03-10');
    expect(avenir).toHaveLength(2);
    // Il est dans la liste « à venir », mais il tombe en avril et non en mars.
    expect([...grouperParJour(avenir).keys()]).toEqual(['2027-03-15', '2027-04-01']);
  });

  it('un événement perso à heure fixe suit lui aussi son fuseau', () => {
    const el = elementsCalendrier(
      { evenements: [], evenements_perso: [perso('RDV tardif', '2027-03-11T23:30:00Z', { all_day: false })] },
      'tous',
    );
    expect([...grouperParJour(el).keys()]).toEqual(['2027-03-12']);
    expect(evenementsAVenir(el, '2027-03-12')).toHaveLength(1);
  });
});

describe('adaptateur vers la grille de la semaine', () => {
  const donnees = {
    evenements: [groupe('g1', 'Brunch', '2027-03-16', { all_day: false, starts_at: '2027-03-16T09:00:00Z' })],
    evenements_perso: [
      {
        id: 'p1',
        title: 'Dentiste',
        starts_at: '2027-03-16T13:00:00Z',
        ends_at: '2027-03-16T14:00:00Z',
        all_day: false,
        time_zone: 'Europe/Paris',
        location_name: null,
      },
    ],
  };
  const elements = elementsCalendrier(donnees, 'tous');
  const couleurs = couleursParGroupe([{ group_id: 'g0' }, { group_id: 'g1' }]);

  it('un événement de groupe prend la couleur de son groupe et mène à sa page', () => {
    const entree = entreesGrilleDepuisElements(elements, couleurs, (el) => el.title).find((e) => e.cle.startsWith('groupe-'));
    expect(entree).toMatchObject({ titre: 'Brunch', couleur: 'cyan', genre: 'evenement', lien: '#/groupe/g1/evenement/g1-Brunch', time_zone: 'Europe/Paris' });
  });

  it('un événement personnel est violet et mène à l’agenda personnel', () => {
    const entree = entreesGrilleDepuisElements(elements, couleurs, (el) => el.title).find((e) => e.cle.startsWith('perso-'));
    expect(entree).toMatchObject({ cle: 'perso-p1', couleur: 'violet', lien: '#/agenda/p1', starts_at: '2027-03-16T13:00:00Z' });
  });

  it('un groupe inconnu de la palette retombe sur l’indigo, et le libellé est celui que fournit l’appelant', () => {
    const [entree] = entreesGrilleDepuisElements(elements.slice(0, 1), new Map(), (el) => `[${el.title}]`);
    expect(entree).toMatchObject({ couleur: 'indigo', titre: expect.stringMatching(/^\[.*\]$/) as string });
  });
});

describe('prochain événement', () => {
  const el = (...e: ReturnType<typeof groupe>[]) => elementsCalendrier({ evenements: e, evenements_perso: [] }, 'tous');

  it('saute ce qui est terminé et garde ce qui est en cours', () => {
    const liste = el(
      groupe('a', 'Fini', '2027-03-10T08:00:00Z', { all_day: false, ends_at: '2027-03-10T09:00:00Z' }),
      groupe('a', 'En cours', '2027-03-10T09:30:00Z', { all_day: false, ends_at: '2027-03-10T12:00:00Z' }),
      groupe('a', 'Plus tard', '2027-03-10T18:00:00Z', { all_day: false }),
    );
    expect(prochainEvenement(liste, new Date('2027-03-10T10:00:00Z'), '2027-03-10')?.title).toBe('En cours');
    expect(prochainEvenement(liste, new Date('2027-03-10T13:00:00Z'), '2027-03-10')?.title).toBe('Plus tard');
    expect(prochainEvenement(liste, new Date('2027-03-10T19:00:00Z'), '2027-03-10')).toBeNull();
  });

  it('sans fin, un événement à heure fixe s’arrête à son début', () => {
    const liste = el(groupe('a', 'Dîner', '2027-03-10T18:00:00Z', { all_day: false }), groupe('a', 'Brunch', '2027-03-11', {}));
    expect(prochainEvenement(liste, new Date('2027-03-10T18:00:01Z'), '2027-03-10')?.title).toBe('Brunch');
  });

  it('une journée entière dure jusqu’à son dernier jour', () => {
    const liste = el(groupe('a', 'Week-end', '2027-03-06', { ends_at: '2027-03-08' }));
    expect(prochainEvenement(liste, new Date('2027-03-08T20:00:00Z'), '2027-03-08')?.title).toBe('Week-end');
    expect(prochainEvenement(liste, new Date('2027-03-09T08:00:00Z'), '2027-03-09')).toBeNull();
  });

  it('un événement personnel peut être le prochain ; sans rien : null', () => {
    const liste = elementsCalendrier({ evenements: [], evenements_perso: [perso('Dentiste', '2027-03-12')] }, 'tous');
    expect(prochainEvenement(liste, new Date('2027-03-10T10:00:00Z'), '2027-03-10')?.sorte).toBe('perso');
    expect(prochainEvenement([], new Date('2027-03-10T10:00:00Z'), '2027-03-10')).toBeNull();
  });
});

describe('ce qui attend une action', () => {
  const aVenir = (...e: ReturnType<typeof groupe>[]) => elementsCalendrier({ evenements: e, evenements_perso: [perso('Dentiste', '2027-03-11')] }, 'tous');

  it('rien à faire : bloc vide', () => {
    const r = actionsAttendues(aVenir(groupe('a', 'Dîner', '2027-03-20', { mon_statut: 'yes' })), 0, null);
    expect(r).toEqual({ invitations: 0, reponses: [], total: 0 });
  });

  it('compte les invitations et les événements sans réponse, jamais le perso', () => {
    const liste = aVenir(groupe('a', 'Dîner', '2027-03-20'), groupe('a', 'Ciné', '2027-03-22', { mon_statut: 'maybe' }));
    const r = actionsAttendues(liste, 2, null);
    expect(r.invitations).toBe(2);
    expect(r.reponses.map((e) => e.title)).toEqual(['Dîner']);
    expect(r.total).toBe(3);
  });

  it('écarte l’événement mis en avant, dont la carte porte déjà l’action', () => {
    const liste = aVenir(groupe('a', 'Dîner', '2027-03-20'), groupe('a', 'Pique-nique', '2027-03-25'));
    const r = actionsAttendues(liste, 0, liste.find((e) => e.title === 'Dîner') ?? null);
    expect(r.reponses.map((e) => e.title)).toEqual(['Pique-nique']);
    expect(r.total).toBe(1);
  });

  it('plafonne les réponses montrées mais pas le total', () => {
    const evenements = ['A', 'B', 'C', 'D', 'E'].map((n, i) => groupe('a', n, `2027-03-${String(20 + i)}`));
    const r = actionsAttendues(aVenir(...evenements), -3, null);
    expect(r.reponses).toHaveLength(MAX_REPONSES_ATTENDUES);
    expect(r.invitations).toBe(0);
    expect(r.total).toBe(5);
  });
});

describe('solde net par groupe', () => {
  const s = (g: string, devise: string, net: number) => ({ group_id: g, group_name: `Groupe ${g}`, currency_code: devise, net_minor: net });

  it('aucun solde : liste vide, le bloc se replie', () => {
    expect(soldesParGroupe([])).toEqual([]);
  });

  it('un chiffre par groupe, sans mélanger les groupes', () => {
    expect(soldesParGroupe([s('a', 'EUR', 500), s('b', 'EUR', -200)])).toEqual([
      { group_id: 'a', group_name: 'Groupe a', devises: [['EUR', 500]], sens: 'positif' },
      { group_id: 'b', group_name: 'Groupe b', devises: [['EUR', -200]], sens: 'negatif' },
    ]);
  });

  it('un groupe à deux devises garde un montant par devise et le sens « multi »', () => {
    const [g] = soldesParGroupe([s('a', 'EUR', 500), s('a', 'USD', -100)]);
    expect(g?.sens).toBe('multi');
    expect(g?.devises).toEqual([['EUR', 500], ['USD', -100]]);
  });
});

describe('éléments non terminés', () => {
  it('écarte un événement du matin dès l’après-midi, même sans réponse', () => {
    const el = elementsCalendrier(
      { evenements: [groupe('a', 'Brunch', '2027-03-10T08:00:00Z', { all_day: false, ends_at: '2027-03-10T09:00:00Z' })], evenements_perso: [] },
      'tous',
    );
    expect(nonTermines(el, new Date('2027-03-10T08:30:00Z'), '2027-03-10')).toHaveLength(1);
    expect(nonTermines(el, new Date('2027-03-10T14:00:00Z'), '2027-03-10')).toEqual([]);
  });
});

describe('date en clair', () => {
  const journee = (jour: string) => elementsCalendrier({ evenements: [], evenements_perso: [perso('T', jour)] }, 'tous')[0];
  const l = { aujourdhui: 'Auj', demain: 'Dem', horaire: 'H' };

  it('aujourd’hui et demain sont nommés, sinon jour et date en toutes lettres', () => {
    const [a, b, c] = [journee('2027-03-10'), journee('2027-03-11'), journee('2027-03-12')];
    expect(a && dateEnClair(a, '2027-03-10', l)).toBe('Auj · H');
    expect(b && dateEnClair(b, '2027-03-10', l)).toBe('Dem · H');
    expect(c && dateEnClair(c, '2027-03-10', l)).toBe('vendredi 12 mars · H');
  });
});

describe('parties du solde', () => {
  const g = (devises: readonly (readonly [string, number])[]) => ({ group_id: 'a', group_name: 'A', devises, sens: 'multi' as const });
  const eti = { positif: 'doit', negatif: 'devez', equilibre: 'eq' };
  const montant = (n: number, d: string) => `${String(n)} ${d}`;

  it('chaque devise garde son propre sens et un montant positif', () => {
    expect(partiesSolde(g([['EUR', 2000], ['USD', -1500]]), montant, eti)).toEqual([
      { devise: 'EUR', sens: 'positif', etiquette: 'doit', montant: '2000 EUR' },
      { devise: 'USD', sens: 'negatif', etiquette: 'devez', montant: '1500 USD' },
    ]);
  });

  it('un net nul est à l’équilibre', () => {
    expect(partiesSolde(g([['EUR', 0]]), montant, eti)[0]?.sens).toBe('equilibre');
  });
});
