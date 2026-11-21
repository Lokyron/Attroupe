import { describe, expect, it } from 'vitest';
import { instantDepuisHeureLocale } from '../../client/src/agenda/dates.js';
import {
  composerSemaine,
  creneauDuJour,
  DUREE_MINIMALE_MIN,
  indexJourVisible,
  minuteDeCalage,
  premierDebut,
  placerJour,
  plageUtile,
  semaineVide,
  type EntreeGrille,
} from '../../client/src/agenda/grille-semaine.js';

// Placement de la grille horaire de la semaine : tout le calcul est pur, le composant ne fait que dessiner.
const FUSEAU = 'Europe/Paris';
const MARDI = '2027-03-16';

/** Entrée horaire à partir d'heures murales Paris (`AAAA-MM-JJTHH:MM`) ; `fin` à `null` = sans fin. */
const horaire = (cle: string, debut: string, fin: string | null, extra: Partial<EntreeGrille> = {}): EntreeGrille => ({
  cle,
  titre: cle,
  lien: `#/${cle}`,
  genre: 'evenement',
  couleur: 'indigo',
  annule: false,
  all_day: false,
  starts_at: instantDepuisHeureLocale(debut, FUSEAU),
  ends_at: fin === null ? null : instantDepuisHeureLocale(fin, FUSEAU),
  time_zone: FUSEAU,
  ...extra,
});

const journee = (cle: string, debut: string, fin: string | null = null): EntreeGrille => ({
  cle,
  titre: cle,
  lien: `#/${cle}`,
  genre: 'evenement',
  couleur: 'indigo',
  annule: false,
  all_day: true,
  starts_at: debut,
  ends_at: fin,
  time_zone: FUSEAU,
});

describe('créneau d’une entrée dans un jour', () => {
  it('un événement horaire ordinaire : minutes depuis minuit, dans son fuseau', () => {
    expect(creneauDuJour(horaire('a', `${MARDI}T18:30`, `${MARDI}T20:00`), MARDI)).toEqual({ type: 'horaire', debut: 1110, fin: 1200 });
  });

  it('sans fin : une heure par défaut', () => {
    expect(creneauDuJour(horaire('a', `${MARDI}T09:00`, null), MARDI)).toEqual({
      type: 'horaire',
      debut: 540,
      fin: 600,
    });
  });

  it('un événement qui touche un autre jour n’apparaît pas ici', () => {
    expect(creneauDuJour(horaire('a', `${MARDI}T09:00`, `${MARDI}T10:00`), '2027-03-17')).toBeNull();
  });

  it('une fin à minuit pile ne déborde pas sur le jour suivant', () => {
    const e = horaire('a', `${MARDI}T22:00`, '2027-03-17T00:00');
    expect(creneauDuJour(e, MARDI)).toEqual({
      type: 'horaire',
      debut: 1320,
      fin: 1440,
    });
    expect(creneauDuJour(e, '2027-03-17')).toBeNull();
  });

  it('un événement qui déborde du jour est borné à l’intérieur de chaque jour touché', () => {
    const e = horaire('nuit', `${MARDI}T22:00`, '2027-03-17T02:00');
    expect(creneauDuJour(e, MARDI)).toEqual({
      type: 'horaire',
      debut: 1320,
      fin: 1440,
    });
    expect(creneauDuJour(e, '2027-03-17')).toEqual({
      type: 'horaire',
      debut: 0,
      fin: 120,
    });
  });

  it('un créneau horaire qui couvre tout le jour passe dans la bande « journée entière »', () => {
    const e = horaire('long', `${MARDI}T20:00`, '2027-03-18T10:00');
    expect(creneauDuJour(e, '2027-03-17')).toEqual({ type: 'journee' });
  });

  it('une journée entière couvre chacun de ses jours, et eux seuls', () => {
    const e = journee('vacances', '2027-03-15', '2027-03-17');
    expect(creneauDuJour(e, '2027-03-14')).toBeNull();
    expect(creneauDuJour(e, '2027-03-16')).toEqual({ type: 'journee' });
    expect(creneauDuJour(e, '2027-03-17')).toEqual({ type: 'journee' });
    expect(creneauDuJour(e, '2027-03-18')).toBeNull();
    expect(creneauDuJour(journee('un-jour', MARDI), MARDI)).toEqual({
      type: 'journee',
    });
  });
});

describe('placement des blocs d’un jour', () => {
  it('cas nominal : un événement seul prend toute la largeur', () => {
    const { blocs, journee: bande } = placerJour([horaire('a', `${MARDI}T18:00`, `${MARDI}T20:00`)], MARDI);
    expect(bande).toEqual([]);
    expect(blocs).toHaveLength(1);
    expect(blocs[0]).toMatchObject({
      debut: 1080,
      fin: 1200,
      decalage: 1080,
      hauteur: 120,
      colonne: 0,
      colonnes: 1,
    });
  });

  it('deux événements qui se recouvrent se partagent la largeur', () => {
    const { blocs } = placerJour(
      [horaire('b', `${MARDI}T10:00`, `${MARDI}T12:00`), horaire('a', `${MARDI}T09:00`, `${MARDI}T11:00`)],
      MARDI,
    );
    expect(blocs.map((b) => [b.entree.cle, b.colonne, b.colonnes])).toEqual([
      ['a', 0, 2],
      ['b', 1, 2],
    ]);
  });

  it('trois événements qui se recouvrent : trois colonnes ; un quatrième, plus tard, retrouve toute la largeur', () => {
    const { blocs } = placerJour(
      [
        horaire('a', `${MARDI}T09:00`, `${MARDI}T12:00`),
        horaire('b', `${MARDI}T09:30`, `${MARDI}T11:00`),
        horaire('c', `${MARDI}T10:00`, `${MARDI}T10:30`),
        horaire('d', `${MARDI}T14:00`, `${MARDI}T15:00`),
      ],
      MARDI,
    );
    expect(blocs.map((b) => [b.entree.cle, b.colonne, b.colonnes])).toEqual([
      ['a', 0, 3],
      ['b', 1, 3],
      ['c', 2, 3],
      ['d', 0, 1],
    ]);
  });

  it('une colonne libérée est réutilisée : a puis c côte à côte de b', () => {
    const { blocs } = placerJour(
      [
        horaire('a', `${MARDI}T09:00`, `${MARDI}T10:00`),
        horaire('b', `${MARDI}T09:30`, `${MARDI}T12:00`),
        horaire('c', `${MARDI}T10:30`, `${MARDI}T11:30`),
      ],
      MARDI,
    );
    expect(blocs.map((b) => [b.entree.cle, b.colonne, b.colonnes])).toEqual([
      ['a', 0, 2],
      ['b', 1, 2],
      ['c', 0, 2],
    ]);
  });

  it('deux événements qui se touchent sans se recouvrir restent chacun en pleine largeur', () => {
    const { blocs } = placerJour(
      [horaire('a', `${MARDI}T09:00`, `${MARDI}T10:00`), horaire('b', `${MARDI}T10:00`, `${MARDI}T11:00`)],
      MARDI,
    );
    expect(blocs.map((b) => b.colonnes)).toEqual([1, 1]);
  });

  it('un événement plus court que la hauteur minimale est agrandi, et cède la largeur à celui qu’il recouvre alors', () => {
    const { blocs } = placerJour(
      [horaire('court', `${MARDI}T10:00`, `${MARDI}T10:10`), horaire('suite', `${MARDI}T10:30`, `${MARDI}T11:30`)],
      MARDI,
    );
    expect(blocs[0]).toMatchObject({
      debut: 600,
      fin: 610,
      decalage: 600,
      hauteur: DUREE_MINIMALE_MIN,
    });
    // 10:00 + 48 min dépasse 10:30 : le bloc grossi recouvre le suivant.
    expect(blocs.map((b) => b.colonnes)).toEqual([2, 2]);
  });

  it('un événement court en toute fin de jour garde son heure de début : seule la hauteur s’ajuste', () => {
    const { blocs } = placerJour([horaire('tard', `${MARDI}T23:50`, null)], MARDI);
    // Le bloc commence à 23h50 réelles (et non remonté à 23h12) ; il dépasse minuit plutôt que de mentir sur son début.
    expect(blocs[0]).toMatchObject({
      debut: 1430,
      fin: 1440,
      hauteur: DUREE_MINIMALE_MIN,
      decalage: 1430,
    });
  });

  it('un événement à 23h50 ne crée pas de faux chevauchement avec un événement de 23h00 à 23h45', () => {
    // (23h15-23h45 ne conviendrait pas : grossi à 48 min il finit à 00h03, il recouvre réellement 23h50.)
    const { blocs } = placerJour([horaire('tard', `${MARDI}T23:50`, null), horaire('avant', `${MARDI}T23:00`, `${MARDI}T23:45`)], MARDI);
    expect(blocs.map((b) => [b.entree.cle, b.decalage, b.colonnes])).toEqual([
      ['avant', 1380, 1],
      ['tard', 1430, 1],
    ]);
  });

  it('un événement de durée nulle prend la hauteur minimale, pas l’heure par défaut', () => {
    const { blocs } = placerJour([horaire('zero', `${MARDI}T10:00`, `${MARDI}T10:00`)], MARDI);
    expect(blocs[0]).toMatchObject({
      decalage: 600,
      hauteur: DUREE_MINIMALE_MIN,
    });
    // À 10h50 il ne le recouvre pas (10h48) : avec 60 minutes il aurait élargi le chevauchement.
    const { blocs: deux } = placerJour(
      [horaire('zero', `${MARDI}T10:00`, `${MARDI}T10:00`), horaire('suite', `${MARDI}T10:50`, `${MARDI}T11:30`)],
      MARDI,
    );
    expect(deux.map((b) => b.colonnes)).toEqual([1, 1]);
  });

  it('les journées entières vont dans la bande, pas dans les blocs', () => {
    const jour = placerJour([journee('ferie', MARDI), horaire('a', `${MARDI}T09:00`, `${MARDI}T10:00`)], MARDI);
    expect(jour.journee.map((e) => e.cle)).toEqual(['ferie']);
    expect(jour.blocs.map((b) => b.entree.cle)).toEqual(['a']);
  });

  it('un événement multi-jours apparaît sur chaque jour touché', () => {
    const e = horaire('nuit', `${MARDI}T22:00`, '2027-03-17T02:00');
    expect(placerJour([e], MARDI).blocs).toHaveLength(1);
    expect(placerJour([e], '2027-03-17').blocs).toHaveLength(1);
    expect(placerJour([e], '2027-03-18').blocs).toHaveLength(0);
  });
});

describe('plage horaire utile', () => {
  it('sans événement : la plage par défaut, 8 h à 22 h', () => {
    expect(plageUtile([])).toEqual({ debut: 8, fin: 22 });
  });

  it('un événement dans la plage ne la change pas', () => {
    const { blocs } = placerJour([horaire('a', `${MARDI}T10:00`, `${MARDI}T11:00`)], MARDI);
    expect(plageUtile(blocs)).toEqual({ debut: 8, fin: 22 });
  });

  it('un événement à 3 h du matin élargit la plage vers le haut ; un à 23 h vers le bas', () => {
    const { blocs } = placerJour(
      [horaire('nuit', `${MARDI}T03:15`, `${MARDI}T04:00`), horaire('tard', `${MARDI}T22:30`, `${MARDI}T23:10`)],
      MARDI,
    );
    expect(plageUtile(blocs)).toEqual({ debut: 3, fin: 24 });
  });
});

// Changement d'heure (Europe/Paris, 2027) : la grille est en heure murale, un jour de 23 h ou de 25 h ne décale donc rien.
describe('changement d’heure', () => {
  const PRINTEMPS = '2027-03-28'; // 02:00 devient 03:00 : jour de 23 h
  const AUTOMNE = '2027-10-31'; // 03:00 devient 02:00 : jour de 25 h

  it('jour du passage à l’heure d’été : un événement après le saut est à sa position murale', () => {
    const { blocs } = placerJour(
      [horaire('matin', `${PRINTEMPS}T10:00`, `${PRINTEMPS}T11:30`), horaire('tot', `${PRINTEMPS}T03:30`, `${PRINTEMPS}T04:00`)],
      PRINTEMPS,
    );
    expect(blocs.map((b) => [b.entree.cle, b.decalage, b.hauteur])).toEqual([
      ['tot', 210, DUREE_MINIMALE_MIN],
      ['matin', 600, 90],
    ]);
  });

  it('jour du passage à l’heure d’hiver : un événement après le saut est à sa position murale', () => {
    const { blocs } = placerJour(
      [horaire('matin', `${AUTOMNE}T10:00`, `${AUTOMNE}T11:30`), horaire('soir', `${AUTOMNE}T23:00`, `${AUTOMNE}T23:30`)],
      AUTOMNE,
    );
    expect(blocs.map((b) => [b.entree.cle, b.decalage, b.hauteur])).toEqual([
      ['matin', 600, 90],
      ['soir', 1380, DUREE_MINIMALE_MIN],
    ]);
  });

  it('un événement qui enjambe le saut est tracé sur les heures murales, pas sur sa durée réelle', () => {
    // 01h00 CET → 04h00 CEST : 2 h réelles, 3 h sur la grille.
    expect(creneauDuJour(horaire('nuit', `${PRINTEMPS}T01:00`, `${PRINTEMPS}T04:00`), PRINTEMPS)).toEqual({
      type: 'horaire',
      debut: 60,
      fin: 240,
    });
  });

  // Limites connues et assumées de toute grille en heure murale.
  it('limite : deux événements disjoints dans l’heure répétée d’octobre s’affichent côte à côte', () => {
    const premier = {
      ...horaire('ete', `${AUTOMNE}T10:00`, null),
      starts_at: '2027-10-31T00:10:00Z',
      ends_at: '2027-10-31T00:40:00Z',
    }; // 02h10-02h40 CEST
    const second = {
      ...horaire('hiver', `${AUTOMNE}T10:00`, null),
      starts_at: '2027-10-31T01:10:00Z',
      ends_at: '2027-10-31T01:40:00Z',
    }; // 02h10-02h40 CET
    const { blocs } = placerJour([premier, second], AUTOMNE);
    expect(blocs.map((b) => [b.decalage, b.colonnes])).toEqual([
      [130, 2],
      [130, 2],
    ]);
  });

  it('limite : un créneau de 02h30 (heure d’été) à 02h15 (heure d’hiver) est traité comme une durée minimale', () => {
    const e = {
      ...horaire('retour', `${AUTOMNE}T10:00`, null),
      starts_at: '2027-10-31T00:30:00Z',
      ends_at: '2027-10-31T01:15:00Z',
    };
    const { blocs } = placerJour([e], AUTOMNE);
    expect(blocs[0]).toMatchObject({
      decalage: 150,
      hauteur: DUREE_MINIMALE_MIN,
    });
  });
});

describe('semaine vide', () => {
  const semaine = ['2027-03-15', MARDI, '2027-03-17', '2027-03-18', '2027-03-19', '2027-03-20', '2027-03-21'];

  it('sans rien : vide ; avec un événement horaire ou une journée entière : non', () => {
    expect(semaineVide(composerSemaine(semaine, []))).toBe(true);
    expect(semaineVide(composerSemaine(semaine, [horaire('a', `${MARDI}T09:00`, `${MARDI}T10:00`)]))).toBe(false);
    expect(semaineVide(composerSemaine(semaine, [journee('j', MARDI)]))).toBe(false);
    // Un événement d'une autre semaine ne compte pas.
    expect(semaineVide(composerSemaine(semaine, [horaire('x', '2027-04-20T09:00', '2027-04-20T10:00')]))).toBe(true);
  });
});

describe('composition de la semaine', () => {
  const semaine = ['2027-03-15', MARDI, '2027-03-17', '2027-03-18', '2027-03-19', '2027-03-20', '2027-03-21'];

  it('place chaque jour, calcule la plage sur toute la semaine et plafonne la bande à trois lignes', () => {
    const placee = composerSemaine(semaine, [
      horaire('matin', '2027-03-18T05:00', '2027-03-18T06:00'),
      journee('a', MARDI),
      journee('b', MARDI),
      journee('c', MARDI),
      journee('d', MARDI),
    ]);
    expect(placee.jours.map((j) => j.jour)).toEqual(semaine);
    expect(placee.plage).toEqual({ debut: 5, fin: 22 });
    expect(placee.lignesBande).toBe(3);
  });

  it('une semaine vide : pas de bande, plage par défaut', () => {
    expect(composerSemaine(semaine, [])).toMatchObject({
      plage: { debut: 8, fin: 22 },
      lignesBande: 0,
    });
  });
});

describe('jour visible au défilement', () => {
  it('arrondit au jour le plus proche et reste dans la semaine', () => {
    expect(indexJourVisible(0, 300, 7)).toBe(0);
    expect(indexJourVisible(449, 300, 7)).toBe(1);
    expect(indexJourVisible(451, 300, 7)).toBe(2);
    expect(indexJourVisible(99_999, 300, 7)).toBe(6);
    expect(indexJourVisible(-20, 300, 7)).toBe(0);
  });

  it('une largeur nulle (grille masquée) retombe sur le premier jour', () => {
    expect(indexJourVisible(500, 0, 7)).toBe(0);
  });
});

// Défilement vertical à l'ouverture : la décision est pure (minutes), le composant ne fait que convertir en pixels.
describe('calage à l’ouverture', () => {
  const plageJournee = { debut: 0, fin: 24 };
  const VISIBLE = 480; // 8 h visibles

  it('semaine en cours : l’heure courante moins une heure, même si la plage couvre toute la journée', () => {
    expect(minuteDeCalage(plageJournee, 11 * 60, 10 * 60, VISIBLE)).toBe(10 * 60);
  });

  it('hors semaine en cours : le premier événement moins une heure', () => {
    expect(minuteDeCalage(plageJournee, null, 10 * 60 + 30, VISIBLE)).toBe(9 * 60 + 30);
  });

  it('sans événement : le début de la plage utile', () => {
    expect(minuteDeCalage({ debut: 8, fin: 22 }, null, null, VISIBLE)).toBe(8 * 60);
  });

  it('borné : jamais au-dessus du début de la plage, ni assez bas pour montrer du vide après sa fin', () => {
    expect(minuteDeCalage({ debut: 8, fin: 22 }, 8 * 60 + 10, null, VISIBLE)).toBe(8 * 60);
    expect(minuteDeCalage({ debut: 8, fin: 22 }, 23 * 60, null, VISIBLE)).toBe(22 * 60 - VISIBLE);
    // Fenêtre plus haute que la plage : on reste en haut.
    expect(minuteDeCalage({ debut: 8, fin: 22 }, 20 * 60, null, 24 * 60)).toBe(8 * 60);
  });

  it('premier début : d’un jour, ou de toute la semaine', () => {
    const jours = [
      placerJour([horaire('a', `${MARDI}T14:00`, `${MARDI}T15:00`)], MARDI),
      placerJour([horaire('b', '2027-03-17T09:00', '2027-03-17T10:00'), horaire('c', '2027-03-17T23:50', null)], '2027-03-17'),
      placerJour([], '2027-03-18'),
    ];
    expect(premierDebut(jours, 0)).toBe(840);
    expect(premierDebut(jours, 1)).toBe(540);
    expect(premierDebut(jours, 2)).toBeNull();
    expect(premierDebut(jours, null)).toBe(540);
  });
});
