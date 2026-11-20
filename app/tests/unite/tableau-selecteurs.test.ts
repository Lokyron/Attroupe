import { describe, expect, it } from 'vitest';
import {
  compterSurJours,
  couleursParGroupe,
  elementsCalendrier,
  evenementsAVenir,
  fenetreCalendrier,
  filtrerParGroupe,
  groupeCible,
  groupeDesDepenses,
  groupeDesPhotos,
  grouperParJour,
  lienElementCalendrier,
  nombreAVenirDuMois,
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
    const titres = elementsCalendrier(donnees, '', 'tous').map((e) => e.title);
    expect(titres).toEqual(['Randonnée', 'Dentiste', 'Dîner']);
  });

  it('l’onglet « perso » ne garde que le perso, l’onglet « groupes » que les groupes', () => {
    expect(elementsCalendrier(donnees, '', 'perso').map((e) => e.sorte)).toEqual(['perso']);
    expect(elementsCalendrier(donnees, '', 'groupes').every((e) => e.sorte === 'groupe')).toBe(true);
  });

  it('le filtre de groupe écarte les autres groupes mais pas le perso', () => {
    const titres = elementsCalendrier(donnees, 'a', 'tous').map((e) => e.title);
    expect(titres).toEqual(['Dentiste', 'Dîner']);
  });

  it('un événement sur plusieurs jours figure dans chacun', () => {
    const el = elementsCalendrier(
      { evenements: [groupe('a', 'Week-end', '2027-03-06', { ends_at: '2027-03-07' })], evenements_perso: [] },
      '',
      'tous',
    );
    const parJour = grouperParJour(el);
    expect([...parJour.keys()]).toEqual(['2027-03-06', '2027-03-07']);
    expect(compterSurJours(['2027-03-05', '2027-03-06', '2027-03-07'], parJour)).toBe(2);
  });
});

describe('événements à venir', () => {
  const elements = elementsCalendrier(donnees, '', 'tous');

  it('garde ce qui commence aujourd’hui ou plus tard', () => {
    expect(evenementsAVenir(elements, '2027-03-12').map((e) => e.title)).toEqual(['Dentiste', 'Dîner']);
    expect(evenementsAVenir(elements, '2027-04-01')).toEqual([]);
  });

  it('compte ceux du mois du jour actuel', () => {
    const avenir = evenementsAVenir(elements, '2027-03-10');
    expect(nombreAVenirDuMois(avenir, '2027-03-10')).toBe(2);
    // Les événements d'un autre mois, y compris le même mois d'une autre année, sont écartés : la valeur reste 2.
    const horsMois = elementsCalendrier(
      {
        evenements: [groupe('a', 'Mai', '2027-05-01'), groupe('a', 'Avril', '2027-04-01'), groupe('a', 'Mars suivant', '2028-03-15')],
        evenements_perso: [],
      },
      '',
      'tous',
    );
    expect(nombreAVenirDuMois(horsMois, '2027-03-10')).toBe(0);
    expect(nombreAVenirDuMois([...avenir, ...horsMois], '2027-03-10')).toBe(2);
  });
});

describe('regroupement par jour (grouperParJour)', () => {
  const elements = elementsCalendrier(
    {
      evenements: [groupe('a', 'Long', '2027-03-10', { ends_at: '2027-03-12' }), groupe('a', 'Court', '2027-03-11')],
      evenements_perso: [perso('Seul', '2027-03-20')],
    },
    '',
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
      '',
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

  it('filtrerParGroupe : « » garde tout', () => {
    const l = [g('a'), g('b')];
    expect(filtrerParGroupe(l, '')).toHaveLength(2);
    expect(filtrerParGroupe(l, 'b')).toEqual([g('b')]);
  });

  it('le groupe des photos : visibles d’abord, puis tous', () => {
    const a = g('a', true);
    const b = g('b', true);
    expect(groupeDesPhotos([b], [a, b])).toBe(b);
    expect(groupeDesPhotos([g('c')], [a, b])).toBe(a);
    expect(groupeDesPhotos([], [g('c')])).toBeUndefined();
  });

  it('le groupe des dépenses : dépense, solde, cible, premier groupe, puis rien', () => {
    const a = { group_id: 'a' };
    const b = { group_id: 'b' };
    const c = { group_id: 'c' };
    expect(groupeDesDepenses([a], [b], c, [c])).toBe('a');
    expect(groupeDesDepenses([], [b], c, [c])).toBe('b');
    expect(groupeDesDepenses([], [], c, [a])).toBe('c');
    expect(groupeDesDepenses([], [], null, [a])).toBe('a');
    expect(groupeDesDepenses([], [], null, [])).toBe('');
  });
});

describe('liens', () => {
  it('un événement de groupe mène à sa page, le perso au compte', () => {
    const [g] = elementsCalendrier({ evenements: [groupe('a/b', 'x', '2027-03-01')], evenements_perso: [] }, '', 'tous');
    expect(g && lienElementCalendrier(g)).toBe('#/groupe/a%2Fb/evenement/a%2Fb-x');
    const [p] = elementsCalendrier({ evenements: [], evenements_perso: [perso('y', '2027-03-01')] }, '', 'tous');
    expect(p && lienElementCalendrier(p)).toBe('#/compte');
  });
});

// Les cas « heure fixe » : la conversion de fuseau est le seul endroit où une erreur ne se voit pas à l'œil (un événement
// rangé la veille ou le lendemain). Fuseaux de référence en 2027 : Paris est en UTC+1 jusqu'au dimanche 28 mars (01 h UTC),
// puis en UTC+2 ; Los Angeles est en UTC-8 jusqu'au 14 mars.
describe('événements à heure fixe et fuseaux', () => {
  const fixe = (titre: string, debut: string, extra: object = {}) =>
    groupe('a', titre, debut, { all_day: false, time_zone: 'Europe/Paris', ...extra });
  const elementsDe = (...evenements: ReturnType<typeof fixe>[]) =>
    elementsCalendrier({ evenements, evenements_perso: [] }, '', 'tous');
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
    // Il est dans la liste « à venir », mais il compte pour avril et non pour mars.
    expect(nombreAVenirDuMois(avenir, '2027-03-10')).toBe(1);
    expect(nombreAVenirDuMois(avenir, '2027-04-01')).toBe(1);
  });

  it('un événement perso à heure fixe suit lui aussi son fuseau', () => {
    const el = elementsCalendrier(
      { evenements: [], evenements_perso: [perso('RDV tardif', '2027-03-11T23:30:00Z', { all_day: false })] },
      '',
      'tous',
    );
    expect([...grouperParJour(el).keys()]).toEqual(['2027-03-12']);
    expect(evenementsAVenir(el, '2027-03-12')).toHaveLength(1);
  });
});
