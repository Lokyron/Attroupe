import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyserIcs,
  ErreurIcsIllisible,
  ErreurIcsTropGros,
  PLAFONDS,
  type OptionsAnalyse,
  type PlageOccupee,
  type ResultatAnalyse,
} from '../../server/domain/ics-entrant.js';

// Analyseur iCalendar ENTRANT (RFC 5545) : des plages « occupé », avec titre, description et lieu pour leur propriétaire.
// Logique pure, sans base.

const OPTIONS: OptionsAnalyse = {
  horizonDebut: new Date('2027-01-01T00:00:00Z'),
  horizonFin: new Date('2027-12-31T23:59:59Z'),
  fuseauParDefaut: 'Europe/Paris',
};

/** Un VEVENT (les lignes de `corps` s'ajoutent à un UID fixe). */
const ev = (...corps: string[]): string[] => ['BEGIN:VEVENT', 'UID:u1@test', ...corps, 'END:VEVENT'];

/** Un VCALENDAR complet, lignes jointes par CRLF. */
const ics = (...evenements: string[][]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//FR', ...evenements.flat(), 'END:VCALENDAR', ''].join('\r\n');

const analyser = (texte: string, surcharges: Partial<OptionsAnalyse> = {}): ResultatAnalyse =>
  analyserIcs(texte, { ...OPTIONS, ...surcharges });

/** Un événement UTC d'une heure, avec une règle optionnelle. */
const uneHeure = (debut: string, ...supplement: string[]): string[] =>
  ev(`DTSTART:${debut}`, `DTEND:${debut.slice(0, 9)}${String(Number(debut.slice(9, 11)) + 1).padStart(2, '0')}${debut.slice(11)}`, ...supplement);

const debuts = (r: ResultatAnalyse): string[] => r.plages.map((p) => p.debut);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dépliage et découpage des lignes', () => {
  it('déplie une ligne pliée au milieu d\'un caractère UTF-8 avant de l\'interpréter', () => {
    // « é » = 0xC3 0xA9 : on coupe entre les deux octets, comme le font certains exportateurs.
    const entete = Buffer.from('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nSUMMARY:Café du matin\r\n', 'utf8');
    const e = entete.indexOf(0xc3);
    const texte = Buffer.concat([
      entete.subarray(0, e + 1),
      Buffer.from('\r\n ', 'utf8'),
      entete.subarray(e + 1),
      Buffer.from('DTSTART:2027030', 'utf8'),
      Buffer.from('\r\n 8T100000Z\r\nDTEND;TZID=Europe/\r\n Paris:20270308T120000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n', 'utf8'),
    ]).toString('utf8');
    const r = analyser(texte);
    // 10:00Z → 12:00 Paris (CET, +1 : 11:00Z) : DTEND 12:00 Paris = 11:00Z.
    // Le titre n'est pas vérifié ici : `toString('utf8')` ci-dessus a déjà remplacé les octets coupés par U+FFFD.
    expect(r.plages).toEqual([expect.objectContaining({ debut: '2027-03-08T10:00:00Z', fin: '2027-03-08T11:00:00Z', journeeEntiere: false })]);
    expect(r.ignores).toBe(0);
  });

  it('accepte LF seul et tabulation comme marque de pli', () => {
    const r = analyser('BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20270308T10\n\t0000Z\nDTEND:20270308T110000Z\nEND:VEVENT\nEND:VCALENDAR\n');
    expect(debuts(r)).toEqual(['2027-03-08T10:00:00Z']);
  });

  it('un titre aux « ; » et « , » échappés ne perturbe rien : il est lu, pas interprété comme une propriété', () => {
    const r = analyser(ics(ev('SUMMARY:Dej\\, avec Paul\\; DTSTART:20300101T000000Z', 'DTSTART:20270308T100000Z', 'DTEND:20270308T110000Z')));
    expect(debuts(r)).toEqual(['2027-03-08T10:00:00Z']);
    expect(r.plages[0]?.titre).toBe('Dej, avec Paul; DTSTART:20300101T000000Z');
  });

  it('un paramètre entre guillemets peut contenir « : », « ; » et « , »', () => {
    const r = analyser(
      ics(ev('DTSTART;X-NOTE="a:b;c,d";TZID=Europe/Paris:20270601T100000', 'DTEND;TZID=Europe/Paris:20270601T110000')),
    );
    expect(r.plages).toEqual([{ debut: '2027-06-01T08:00:00Z', fin: '2027-06-01T09:00:00Z', journeeEntiere: false }]);
    expect(r.ignores).toBe(0);
  });

  it('accepte un TZID entre guillemets', () => {
    const r = analyser(ics(ev('DTSTART;TZID="Europe/Paris":20270601T100000', 'DTEND;TZID="Europe/Paris":20270601T110000')));
    expect(debuts(r)).toEqual(['2027-06-01T08:00:00Z']);
  });

  it('ignore les propriétés d\'un VALARM imbriqué', () => {
    const r = analyser(
      ics(['BEGIN:VEVENT', 'DTSTART:20270601T100000Z', 'DTEND:20270601T110000Z', 'BEGIN:VALARM', 'DTSTART:20290101T000000Z', 'END:VALARM', 'END:VEVENT']),
    );
    expect(debuts(r)).toEqual(['2027-06-01T10:00:00Z']);
  });
});

describe('dates et durées', () => {
  it('heure flottante : fuseau par défaut du profil', () => {
    const r = analyser(ics(ev('DTSTART:20270615T100000', 'DTEND:20270615T110000')));
    expect(r.plages[0]).toEqual({ debut: '2027-06-15T08:00:00Z', fin: '2027-06-15T09:00:00Z', journeeEntiere: false });
    const ny = analyser(ics(ev('DTSTART:20270615T100000', 'DTEND:20270615T110000')), { fuseauParDefaut: 'America/New_York' });
    expect(ny.plages[0]?.debut).toBe('2027-06-15T14:00:00Z');
  });

  it('DTSTART horodaté sans DTEND ni DURATION : durée nulle, aucune plage, événement compté', () => {
    const r = analyser(ics(ev('DTSTART:20270615T100000Z')));
    expect(r.plages).toEqual([]);
    expect(r.ignores).toBe(1);
  });

  it('DTSTART en date sans DTEND : une journée', () => {
    const r = analyser(ics(ev('DTSTART;VALUE=DATE:20270615')));
    expect(r.plages).toEqual([{ debut: '2027-06-15', fin: '2027-06-15', journeeEntiere: true }]);
  });

  it('DURATION à la place de DTEND', () => {
    const r = analyser(ics(ev('DTSTART:20270615T100000Z', 'DURATION:PT1H30M')));
    expect(r.plages).toEqual([{ debut: '2027-06-15T10:00:00Z', fin: '2027-06-15T11:30:00Z', journeeEntiere: false }]);
    const semaine = analyser(ics(ev('DTSTART;VALUE=DATE:20270615', 'DURATION:P2D')));
    expect(semaine.plages).toEqual([{ debut: '2027-06-15', fin: '2027-06-16', journeeEntiere: true }]);
  });

  it('DURATION nulle, négative ou illisible : événement écarté et compté', () => {
    for (const duree of ['PT0S', '-PT1H', 'une heure', 'P']) {
      const r = analyser(ics(ev('DTSTART:20270615T100000Z', `DURATION:${duree}`)));
      expect(r.plages, duree).toEqual([]);
      expect(r.ignores, duree).toBe(1);
    }
  });

  it('journée entière sur plusieurs jours : la fin est le DERNIER jour inclus (DTEND − 1 jour)', () => {
    const r = analyser(ics(ev('DTSTART;VALUE=DATE:20270310', 'DTEND;VALUE=DATE:20270313')));
    expect(r.plages).toEqual([{ debut: '2027-03-10', fin: '2027-03-12', journeeEntiere: true }]);
  });

  it('dates impossibles ou illisibles : événement écarté et compté', () => {
    for (const debut of ['DTSTART:20270230T100000Z', 'DTSTART:20271301T100000Z', 'DTSTART:pas-une-date', 'DTSTART:20270601T250000Z']) {
      const r = analyser(ics(ev(debut, 'DTEND:20270601T110000Z')));
      expect(r.plages, debut).toEqual([]);
      expect(r.ignores, debut).toBe(1);
    }
  });

  it('DTEND avant DTSTART ou de nature différente : écarté et compté', () => {
    expect(analyser(ics(ev('DTSTART:20270601T100000Z', 'DTEND:20270601T090000Z'))).ignores).toBe(1);
    expect(analyser(ics(ev('DTSTART:20270601T100000Z', 'DTEND;VALUE=DATE:20270602'))).ignores).toBe(1);
  });

  it('ignore ce qui finit avant l\'horizon ou commence après', () => {
    const r = analyser(
      ics(
        uneHeure('20261231T100000Z'),
        uneHeure('20280101T100000Z'),
        uneHeure('20270101T100000Z'),
      ),
    );
    expect(debuts(r)).toEqual(['2027-01-01T10:00:00Z']);
  });
});

describe('récurrences', () => {
  it('COUNT qui s\'épuise avant l\'horizon : aucune occurrence', () => {
    const r = analyser(ics(uneHeure('20260105T100000Z', 'RRULE:FREQ=DAILY;COUNT=3')));
    expect(r.plages).toEqual([]);
    expect(r.ignores).toBe(0);
  });

  it('COUNT compte depuis DTSTART même s\'il précède l\'horizon', () => {
    // 14, 21, 28 décembre 2026 et 4 janvier 2027 : seule la dernière tombe dans l'horizon.
    const r = analyser(ics(uneHeure('20261214T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=4')));
    expect(debuts(r)).toEqual(['2027-01-04T10:00:00Z']);
  });

  it('sans COUNT, saute à l\'horizon mais garde l\'alignement de l\'intervalle', () => {
    // Lundis une semaine sur deux depuis le 2026-12-14 : 28 déc, 11 janv, 25 janv…
    const r = analyser(ics(uneHeure('20261214T100000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20270131T000000Z')));
    expect(debuts(r)).toEqual(['2027-01-11T10:00:00Z', '2027-01-25T10:00:00Z']);
  });

  it('UNTIL en heure flottante (compare en heure murale, borne incluse)', () => {
    const regle = (until: string): string[] =>
      debuts(analyser(ics(ev('DTSTART:20270104T100000', 'DTEND:20270104T110000', `RRULE:FREQ=DAILY;UNTIL=${until}`))));
    expect(regle('20270106T100000')).toEqual(['2027-01-04T09:00:00Z', '2027-01-05T09:00:00Z', '2027-01-06T09:00:00Z']);
    expect(regle('20270106T095959')).toEqual(['2027-01-04T09:00:00Z', '2027-01-05T09:00:00Z']);
  });

  it('UNTIL en UTC et en date', () => {
    const utc = analyser(ics(uneHeure('20270104T100000Z', 'RRULE:FREQ=DAILY;UNTIL=20270105T100000Z')));
    expect(debuts(utc)).toEqual(['2027-01-04T10:00:00Z', '2027-01-05T10:00:00Z']);
    const date = analyser(ics(uneHeure('20270104T100000Z', 'RRULE:FREQ=DAILY;UNTIL=20270105')));
    expect(debuts(date)).toEqual(['2027-01-04T10:00:00Z', '2027-01-05T10:00:00Z']);
  });

  it('FREQ=DAILY avec INTERVAL', () => {
    const r = analyser(ics(uneHeure('20270301T100000Z', 'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3')));
    expect(debuts(r)).toEqual(['2027-03-01T10:00:00Z', '2027-03-03T10:00:00Z', '2027-03-05T10:00:00Z']);
  });

  it('FREQ=WEEKLY avec BYDAY', () => {
    const r = analyser(ics(uneHeure('20270301T100000Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4')));
    expect(debuts(r)).toEqual(['2027-03-01T10:00:00Z', '2027-03-03T10:00:00Z', '2027-03-08T10:00:00Z', '2027-03-10T10:00:00Z']);
  });

  it('FREQ=WEEKLY sans BYDAY : le jour de DTSTART', () => {
    const r = analyser(ics(uneHeure('20270303T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=2')));
    expect(debuts(r)).toEqual(['2027-03-03T10:00:00Z', '2027-03-10T10:00:00Z']);
  });

  it('WKST change les semaines retenues (exemple de la RFC 5545)', () => {
    // 2027-03-02 est un mardi. Une semaine sur deux, mardi et dimanche, 4 occurrences.
    const regle = (wkst: string): string[] =>
      debuts(analyser(ics(uneHeure('20270302T100000Z', `RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=${wkst}`)))).map((d) => d.slice(0, 10));
    expect(regle('MO')).toEqual(['2027-03-02', '2027-03-07', '2027-03-16', '2027-03-21']);
    expect(regle('SU')).toEqual(['2027-03-02', '2027-03-14', '2027-03-16', '2027-03-28']);
  });

  it('FREQ=MONTHLY : le 31 saute les mois trop courts', () => {
    const r = analyser(ics(uneHeure('20270131T100000Z', 'RRULE:FREQ=MONTHLY;COUNT=3')));
    expect(debuts(r).map((d) => d.slice(0, 10))).toEqual(['2027-01-31', '2027-03-31', '2027-05-31']);
  });

  it('FREQ=MONTHLY avec BYMONTHDAY négatif (dernier jour)', () => {
    const r = analyser(ics(uneHeure('20270131T100000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3')));
    expect(debuts(r).map((d) => d.slice(0, 10))).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
  });

  it('FREQ=YEARLY : même date l\'année suivante', () => {
    const r = analyser(ics(uneHeure('20260615T100000Z', 'RRULE:FREQ=YEARLY')));
    expect(debuts(r)).toEqual(['2027-06-15T10:00:00Z']);
  });

  it('FREQ=YEARLY avec BYMONTH', () => {
    const r = analyser(ics(uneHeure('20260310T100000Z', 'RRULE:FREQ=YEARLY;BYMONTH=3,6')));
    expect(debuts(r).map((d) => d.slice(0, 10))).toEqual(['2027-03-10', '2027-06-10']);
  });

  it('BYDAY avec ordinal mensuel : 2TU (deuxième mardi)', () => {
    const r = analyser(ics(uneHeure('20270112T100000Z', 'RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3')));
    expect(debuts(r).map((d) => d.slice(0, 10))).toEqual(['2027-01-12', '2027-02-09', '2027-03-09']);
  });

  it('BYDAY avec ordinal négatif : -1FR (dernier vendredi)', () => {
    const r = analyser(ics(uneHeure('20270129T100000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3')));
    expect(debuts(r).map((d) => d.slice(0, 10))).toEqual(['2027-01-29', '2027-02-26', '2027-03-26']);
  });

  it('BYDAY avec ordinal annuel : 1MO sans BYMONTH (premier lundi de l\'année)', () => {
    const r = analyser(ics(uneHeure('20260105T100000Z', 'RRULE:FREQ=YEARLY;BYDAY=1MO')));
    expect(debuts(r).map((d) => d.slice(0, 10))).toEqual(['2027-01-04']);
  });

  it.each([
    ['BYSETPOS', 'FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO,TU,WE,TH,FR'],
    ['BYWEEKNO', 'FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO'],
    ['BYYEARDAY', 'FREQ=YEARLY;BYYEARDAY=100'],
    ['BYHOUR', 'FREQ=DAILY;BYHOUR=9,14'],
    ['FREQ infra-journalière', 'FREQ=HOURLY;COUNT=5'],
    ['clé inconnue', 'FREQ=DAILY;X-FOO=1'],
    ['ordinal hors MONTHLY/YEARLY', 'FREQ=WEEKLY;BYDAY=2TU'],
    ['INTERVAL nul', 'FREQ=DAILY;INTERVAL=0'],
  ])('règle non prise en charge (%s) : ignorée EN ENTIER, comptée, jamais devinée', (_nom, regle) => {
    const r = analyser(ics(uneHeure('20270301T100000Z', `RRULE:${regle}`)));
    expect(r.plages).toEqual([]);
    expect(r.ignores).toBe(1);
  });

  it('une règle non prise en charge n\'empêche pas les autres événements', () => {
    const r = analyser(ics(uneHeure('20270301T100000Z', 'RRULE:FREQ=DAILY;BYHOUR=9'), uneHeure('20270302T100000Z')));
    expect(debuts(r)).toEqual(['2027-03-02T10:00:00Z']);
    expect(r.ignores).toBe(1);
  });

  it('EXDATE retire des occurrences (UTC, TZID, liste, ligne répétée)', () => {
    const base = uneHeure('20270301T100000Z', 'RRULE:FREQ=DAILY;COUNT=5');
    const utc = analyser(ics([...base.slice(0, -1), 'EXDATE:20270302T100000Z', 'END:VEVENT']));
    expect(debuts(utc).map((d) => d.slice(0, 10))).toEqual(['2027-03-01', '2027-03-03', '2027-03-04', '2027-03-05']);
    const tzid = analyser(ics([...base.slice(0, -1), 'EXDATE;TZID=Europe/Paris:20270302T110000', 'END:VEVENT']));
    expect(debuts(tzid).map((d) => d.slice(0, 10))).toEqual(['2027-03-01', '2027-03-03', '2027-03-04', '2027-03-05']);
    const liste = analyser(ics([...base.slice(0, -1), 'EXDATE:20270302T100000Z,20270303T100000Z', 'EXDATE:20270305T100000Z', 'END:VEVENT']));
    expect(debuts(liste).map((d) => d.slice(0, 10))).toEqual(['2027-03-01', '2027-03-04']);
  });

  it('EXDATE en date sur un événement horodaté exclut le jour', () => {
    const base = uneHeure('20270301T100000Z', 'RRULE:FREQ=DAILY;COUNT=3');
    const r = analyser(ics([...base.slice(0, -1), 'EXDATE;VALUE=DATE:20270302', 'END:VEVENT']));
    expect(debuts(r).map((d) => d.slice(0, 10))).toEqual(['2027-03-01', '2027-03-03']);
  });

  it('EXDATE illisible : événement écarté et compté (on ne devine pas)', () => {
    const base = uneHeure('20270301T100000Z', 'RRULE:FREQ=DAILY;COUNT=3');
    const r = analyser(ics([...base.slice(0, -1), 'EXDATE:n-importe-quoi', 'END:VEVENT']));
    expect(r.plages).toEqual([]);
    expect(r.ignores).toBe(1);
  });

  it('RDATE ajoute des occurrences (avec ou sans règle)', () => {
    const seul = analyser(ics([...uneHeure('20270301T100000Z').slice(0, -1), 'RDATE:20270310T100000Z,20270311T150000Z', 'END:VEVENT']));
    expect(debuts(seul)).toEqual(['2027-03-01T10:00:00Z', '2027-03-10T10:00:00Z', '2027-03-11T15:00:00Z']);
    const avec = analyser(ics([...uneHeure('20270301T100000Z', 'RRULE:FREQ=DAILY;COUNT=2').slice(0, -1), 'RDATE:20270310T100000Z', 'END:VEVENT']));
    expect(debuts(avec).map((d) => d.slice(0, 10))).toEqual(['2027-03-01', '2027-03-02', '2027-03-10']);
  });

  it('RDATE en PERIOD : non pris en charge, événement écarté et compté', () => {
    const r = analyser(ics([...uneHeure('20270301T100000Z').slice(0, -1), 'RDATE;VALUE=PERIOD:20270310T100000Z/PT1H', 'END:VEVENT']));
    expect(r.ignores).toBe(1);
    expect(r.plages).toEqual([]);
  });

  it('RECURRENCE-ID remplace l\'occurrence visée de la série', () => {
    const serie = ev('DTSTART:20270301T100000Z', 'DTEND:20270301T110000Z', 'RRULE:FREQ=DAILY;COUNT=3');
    const exception = [
      'BEGIN:VEVENT', 'UID:u1@test', 'RECURRENCE-ID:20270302T100000Z', 'DTSTART:20270302T160000Z', 'DTEND:20270302T170000Z', 'END:VEVENT',
    ];
    const r = analyser(ics(serie, exception));
    expect(debuts(r)).toEqual(['2027-03-01T10:00:00Z', '2027-03-02T16:00:00Z', '2027-03-03T10:00:00Z']);
  });

  it('RECURRENCE-ID annulé ou libre supprime l\'occurrence sans la remplacer', () => {
    const serie = ev('DTSTART:20270301T100000Z', 'DTEND:20270301T110000Z', 'RRULE:FREQ=DAILY;COUNT=3');
    const annulee = ['BEGIN:VEVENT', 'UID:u1@test', 'RECURRENCE-ID:20270302T100000Z', 'DTSTART:20270302T100000Z', 'STATUS:CANCELLED', 'END:VEVENT'];
    expect(debuts(analyser(ics(serie, annulee)))).toEqual(['2027-03-01T10:00:00Z', '2027-03-03T10:00:00Z']);
  });

  it('RECURRENCE-ID d\'un autre UID ne touche pas la série', () => {
    const serie = ev('DTSTART:20270301T100000Z', 'DTEND:20270301T110000Z', 'RRULE:FREQ=DAILY;COUNT=2');
    const autre = ['BEGIN:VEVENT', 'UID:autre@test', 'RECURRENCE-ID:20270302T100000Z', 'DTSTART:20270302T160000Z', 'DTEND:20270302T170000Z', 'END:VEVENT'];
    expect(debuts(analyser(ics(serie, autre)))).toEqual(['2027-03-01T10:00:00Z', '2027-03-02T10:00:00Z', '2027-03-02T16:00:00Z']);
  });

  it('RECURRENCE-ID avec RANGE (THISANDFUTURE) : exception écartée et comptée', () => {
    const serie = ev('DTSTART:20270301T100000Z', 'DTEND:20270301T110000Z');
    const futur = ['BEGIN:VEVENT', 'UID:u1@test', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20270302T100000Z', 'DTSTART:20270302T160000Z', 'DTEND:20270302T170000Z', 'END:VEVENT'];
    const r = analyser(ics(serie, futur));
    expect(r.ignores).toBe(1);
    expect(debuts(r)).toEqual(['2027-03-01T10:00:00Z']);
  });

  it('deux RRULE sur le même événement : écarté et compté', () => {
    const r = analyser(ics(uneHeure('20270301T100000Z', 'RRULE:FREQ=DAILY;COUNT=2', 'RRULE:FREQ=WEEKLY')));
    expect(r.ignores).toBe(1);
    expect(r.plages).toEqual([]);
  });
});

describe('fuseaux', () => {
  it('TZID IANA valide : heure murale convertie en instant', () => {
    const r = analyser(ics(ev('DTSTART;TZID=America/New_York:20270615T100000', 'DTEND;TZID=America/New_York:20270615T110000')));
    expect(r.plages[0]?.debut).toBe('2027-06-15T14:00:00Z');
    expect(r.avertissements).toEqual([]);
  });

  it('TZID inconnu d\'Intl (nom Windows) : repli sur le fuseau du profil + avertissement', () => {
    const texte = ics(ev('DTSTART;TZID=Romance Standard Time:20270615T100000', 'DTEND;TZID=Romance Standard Time:20270615T110000'));
    const r = analyser(texte);
    expect(r.plages[0]?.debut).toBe('2027-06-15T08:00:00Z');
    expect(r.avertissements).toEqual(['fuseau_inconnu']);
    const ny = analyser(texte, { fuseauParDefaut: 'America/New_York' });
    expect(ny.plages[0]?.debut).toBe('2027-06-15T14:00:00Z');
  });

  it('« Customized Time Zone » : repli, un seul avertissement même répété', () => {
    const r = analyser(
      ics(
        ev('DTSTART;TZID=Customized Time Zone:20270615T100000', 'DTEND;TZID=Customized Time Zone:20270615T110000'),
        ev('DTSTART;TZID=Customized Time Zone:20270616T100000', 'DTEND;TZID=Customized Time Zone:20270616T110000'),
      ),
    );
    expect(r.plages).toHaveLength(2);
    expect(r.avertissements).toEqual(['fuseau_inconnu']);
  });

  it('un « Z » l\'emporte sur un TZID', () => {
    const r = analyser(ics(ev('DTSTART;TZID=Europe/Paris:20270615T100000Z', 'DTEND:20270615T110000Z')));
    expect(r.plages[0]?.debut).toBe('2027-06-15T10:00:00Z');
  });

  it('refuse un fuseau par défaut inconnu et un horizon inversé', () => {
    expect(() => analyser(ics(), { fuseauParDefaut: 'Nulle/Part' })).toThrow(RangeError);
    expect(() => analyser(ics(), { horizonDebut: new Date('2028-01-01Z') })).toThrow(RangeError);
  });

  it('changement d\'heure, heure qui n\'existe pas : décalage d\'avant la transition', () => {
    // 2027-03-28 02:30 n'existe pas à Paris (02:00 → 03:00) : +01:00 d'avant → 01:30Z (= 03:30 locale).
    const r = analyser(ics(ev('DTSTART;TZID=Europe/Paris:20270328T023000', 'DTEND;TZID=Europe/Paris:20270328T043000')));
    expect(r.plages[0]?.debut).toBe('2027-03-28T01:30:00Z');
  });

  it('changement d\'heure, heure qui existe deux fois : le PREMIER décalage', () => {
    // 2027-10-31 02:30 existe deux fois à Paris : 00:30Z (été, +02:00, première) et 01:30Z (hiver). On retient la première.
    const r = analyser(ics(ev('DTSTART;TZID=Europe/Paris:20271031T023000', 'DTEND;TZID=Europe/Paris:20271031T053000')));
    expect(r.plages[0]?.debut).toBe('2027-10-31T00:30:00Z');
  });

  it('une série garde son heure murale à travers le changement d\'heure', () => {
    // Lundi 22 mars (CET, 08:00Z) puis lundi 29 mars (CEST, 07:00Z).
    const r = analyser(ics(ev('DTSTART;TZID=Europe/Paris:20270322T090000', 'DTEND;TZID=Europe/Paris:20270322T100000', 'RRULE:FREQ=WEEKLY;COUNT=2')));
    expect(debuts(r)).toEqual(['2027-03-22T08:00:00Z', '2027-03-29T07:00:00Z']);
  });
});

describe('événements qui ne rendent pas occupé', () => {
  it.each([
    ['TRANSP:TRANSPARENT'],
    ['STATUS:CANCELLED'],
    ['X-MICROSOFT-CDO-BUSYSTATUS:FREE'],
  ])('%s : aucune plage, et pas compté comme ignoré', (ligne) => {
    const r = analyser(ics(uneHeure('20270301T100000Z', ligne)));
    expect(r.plages).toEqual([]);
    expect(r.ignores).toBe(0);
  });

  it('TRANSP:OPAQUE, STATUS:TENTATIVE et BUSYSTATUS:BUSY restent occupés', () => {
    const r = analyser(
      ics(
        uneHeure('20270301T100000Z', 'TRANSP:OPAQUE'),
        uneHeure('20270302T100000Z', 'STATUS:TENTATIVE'),
        uneHeure('20270303T100000Z', 'X-MICROSOFT-CDO-BUSYSTATUS:BUSY'),
      ),
    );
    expect(r.plages).toHaveLength(3);
  });

  it('un événement libre avec une règle exotique n\'est pas compté comme illisible', () => {
    const r = analyser(ics(uneHeure('20270301T100000Z', 'TRANSP:TRANSPARENT', 'RRULE:FREQ=DAILY;BYHOUR=9')));
    expect(r.ignores).toBe(0);
  });
});

describe('aucune fusion', () => {
  it('les plages qui se chevauchent ou se touchent restent distinctes, triées par début', () => {
    const r = analyser(
      ics(
        ev('DTSTART:20270301T110500Z', 'DTEND:20270301T120000Z'), // hors ordre : le tri est à la charge de l'analyseur
        ev('DTSTART:20270301T100000Z', 'DTEND:20270301T110000Z'),
        ev('DTSTART:20270301T103000Z', 'DTEND:20270301T104500Z'), // contenue dans la première
      ),
    );
    expect(r.plages).toEqual([
      { debut: '2027-03-01T10:00:00Z', fin: '2027-03-01T11:00:00Z', journeeEntiere: false },
      { debut: '2027-03-01T10:30:00Z', fin: '2027-03-01T10:45:00Z', journeeEntiere: false },
      { debut: '2027-03-01T11:05:00Z', fin: '2027-03-01T12:00:00Z', journeeEntiere: false },
    ]);
  });

  it('14 minutes d\'écart ne fusionnent pas, 15 minutes non plus', () => {
    const quatorze = analyser(ics(ev('DTSTART:20270301T100000Z', 'DTEND:20270301T110000Z'), ev('DTSTART:20270301T111400Z', 'DTEND:20270301T121400Z')));
    expect(quatorze.plages).toHaveLength(2);
    const quinze = analyser(ics(ev('DTSTART:20270301T100000Z', 'DTEND:20270301T110000Z'), ev('DTSTART:20270301T111500Z', 'DTEND:20270301T121500Z')));
    expect(quinze.plages).toHaveLength(2);
  });

  it('deux rendez-vous espacés de 5 minutes restent DEUX plages, chacune avec son titre', () => {
    const r = analyser(
      ics(
        ev('SUMMARY:Dentiste', 'DTSTART:20270301T100000Z', 'DTEND:20270301T110000Z'),
        ev('SUMMARY:Cinéma', 'DTSTART:20270301T110500Z', 'DTEND:20270301T130000Z'),
      ),
    );
    expect(r.plages).toEqual([
      { debut: '2027-03-01T10:00:00Z', fin: '2027-03-01T11:00:00Z', journeeEntiere: false, titre: 'Dentiste' },
      { debut: '2027-03-01T11:05:00Z', fin: '2027-03-01T13:00:00Z', journeeEntiere: false, titre: 'Cinéma' },
    ]);
  });

  it('une journée entière et un créneau horodaté restent distincts', () => {
    const r = analyser(
      ics(ev('DTSTART;VALUE=DATE:20270301', 'DTEND;VALUE=DATE:20270302'), ev('DTSTART:20270301T100000Z', 'DTEND:20270301T110000Z')),
    );
    expect(r.plages).toEqual([
      { debut: '2027-03-01', fin: '2027-03-01', journeeEntiere: true },
      { debut: '2027-03-01T10:00:00Z', fin: '2027-03-01T11:00:00Z', journeeEntiere: false },
    ]);
  });

  it('les journées entières qui se chevauchent ou se touchent ne fusionnent pas', () => {
    const r = analyser(
      ics(
        ev('DTSTART;VALUE=DATE:20270301', 'DTEND;VALUE=DATE:20270303'),
        ev('DTSTART;VALUE=DATE:20270303', 'DTEND;VALUE=DATE:20270304'),
        ev('DTSTART;VALUE=DATE:20270305'),
      ),
    );
    expect(r.plages).toEqual([
      { debut: '2027-03-01', fin: '2027-03-02', journeeEntiere: true },
      { debut: '2027-03-03', fin: '2027-03-03', journeeEntiere: true },
      { debut: '2027-03-05', fin: '2027-03-05', journeeEntiere: true },
    ]);
  });
});

describe('textes : titre, description, lieu', () => {
  const horaire = ['DTSTART:20270301T100000Z', 'DTEND:20270301T110000Z'];
  const titreDe = (...lignes: string[]): string | undefined => analyser(ics(ev(...lignes, ...horaire))).plages[0]?.titre;
  const unePlage = (...lignes: string[]): PlageOccupee => {
    const plage = analyser(ics(ev(...lignes, ...horaire))).plages[0];
    if (plage === undefined) throw new Error('plage attendue');
    return plage;
  };

  it.each([
    ['\\,', 'SUMMARY:Pain\\, beurre', 'Pain, beurre'],
    ['\\;', 'SUMMARY:Pain\\; beurre', 'Pain; beurre'],
    ['\\\\', 'SUMMARY:C:\\\\dossier', 'C:\\dossier'],
    ['\\n', 'SUMMARY:Haut\\nBas', 'Haut Bas'],
    ['\\N', 'SUMMARY:Haut\\NBas', 'Haut Bas'],
  ])('déséchappe %s dans SUMMARY', (_nom, ligne, attendu) => {
    expect(titreDe(ligne)).toBe(attendu);
  });

  it('déséchappe en une seule passe : « \\\\n » est un antislash suivi de « n », pas un saut de ligne', () => {
    expect(titreDe('SUMMARY:a\\\\nb')).toBe('a\\nb');
  });

  it('SUMMARY absent, vide ou rempli d\'espaces : pas de titre (la clé n\'existe pas)', () => {
    for (const lignes of [[], ['SUMMARY:'], ['SUMMARY:    '], ['SUMMARY:\\n\\n'], ['SUMMARY:\u0001\u0002']]) {
      const plage = unePlage(...lignes);
      expect(plage.titre).toBeUndefined();
      expect('titre' in plage).toBe(false);
    }
  });

  it('coupe les blancs en tête et en queue', () => {
    expect(titreDe('SUMMARY:   Réunion  ')).toBe('Réunion');
  });

  it('retire les caractères de contrôle', () => {
    expect(titreDe('SUMMARY:A\u0000B\u0007C\u001bD\u007fE\u0085F')).toBe('ABCDEF');
  });

  it('tronque à la limite exacte, après déséchappement', () => {
    const limite = 140;
    expect(titreDe(`SUMMARY:${'a'.repeat(limite)}`)).toBe('a'.repeat(limite));
    expect(titreDe(`SUMMARY:${'a'.repeat(limite + 1)}`)).toBe('a'.repeat(limite));
    // 140 « \\, » = 280 caractères bruts mais 140 après déséchappement : rien n'est tronqué.
    expect(titreDe(`SUMMARY:${'\\,'.repeat(limite)}`)).toBe(','.repeat(limite));
    expect(titreDe(`SUMMARY:${'\\,'.repeat(limite + 1)}`)).toBe(','.repeat(limite));
  });

  it('ne coupe pas une paire de substitution (emoji) en deux', () => {
    const limite = 140;
    const texte = 'a'.repeat(limite - 1) + '😀' + 'b';
    const titre = titreDe(`SUMMARY:${texte}`);
    expect(titre).toBe('a'.repeat(limite - 1)); // l'emoji ne tient pas : il saute en entier
    expect(titreDe(`SUMMARY:${'a'.repeat(limite - 2)}😀b`)).toBe(`${'a'.repeat(limite - 2)}😀`); // il tient pile
  });

  it('une coupure qui laisse une espace finale la retire', () => {
    const limite = 140;
    expect(titreDe(`SUMMARY:${'a'.repeat(limite - 1)} b`)).toBe('a'.repeat(limite - 1));
  });

  it('LOCATION : déséchappée, nettoyée et tronquée à 140', () => {
    expect(unePlage('LOCATION:Salle 3\\, bâtiment A').lieu).toBe('Salle 3, bâtiment A');
    expect(unePlage(`LOCATION:${'l'.repeat(140 + 5)}`).lieu).toBe('l'.repeat(140));
    expect('lieu' in unePlage('LOCATION:  ')).toBe(false);
  });

  it('DESCRIPTION multiligne : les sauts de ligne sont conservés, les autres contrôles retirés', () => {
    const plage = unePlage('DESCRIPTION:Ligne 1\\nLigne 2\\N\\nLigne 4\u0001\\, fin');
    expect(plage.description).toBe('Ligne 1\nLigne 2\n\nLigne 4, fin');
  });

  it('DESCRIPTION : blancs et sauts de ligne de tête et de queue coupés, tronquée à 2000', () => {
    expect(unePlage('DESCRIPTION:\\n  texte  \\n').description).toBe('texte');
    expect(unePlage(`DESCRIPTION:${'d'.repeat(2000 + 1)}`).description).toBe('d'.repeat(2000));
    expect(unePlage(`DESCRIPTION:${'d'.repeat(2000)}`).description).toBe('d'.repeat(2000));
  });

  it('un titre sur plusieurs lignes devient une seule ligne', () => {
    expect(titreDe('SUMMARY:Haut\\n\\nBas')).toBe('Haut  Bas');
  });

  it('une journée entière porte aussi ses textes', () => {
    const r = analyser(ics(ev('SUMMARY:Congé', 'LOCATION:Maison', 'DTSTART;VALUE=DATE:20270301')));
    expect(r.plages).toEqual([{ debut: '2027-03-01', fin: '2027-03-01', journeeEntiere: true, titre: 'Congé', lieu: 'Maison' }]);
  });

  it('les occurrences d\'une RRULE héritent du titre, de la description et du lieu de leur master', () => {
    const r = analyser(ics(ev('SUMMARY:Sport', 'DESCRIPTION:Salle\\nSac', 'LOCATION:Gymnase', ...horaire, 'RRULE:FREQ=DAILY;COUNT=3')));
    expect(r.plages).toHaveLength(3);
    for (const p of r.plages) {
      expect(p.titre).toBe('Sport');
      expect(p.description).toBe('Salle\nSac');
      expect(p.lieu).toBe('Gymnase');
    }
  });

  it('les RDATE héritent aussi des textes du master', () => {
    const r = analyser(ics(ev('SUMMARY:Sport', ...horaire, 'RDATE:20270310T100000Z')));
    expect(r.plages.map((p) => p.titre)).toEqual(['Sport', 'Sport']);
  });

  it('une exception RECURRENCE-ID remplace les textes du master pour son occurrence seulement', () => {
    const serie = ev('SUMMARY:Sport', 'LOCATION:Gymnase', ...horaire, 'RRULE:FREQ=DAILY;COUNT=3');
    const exception = [
      'BEGIN:VEVENT', 'UID:u1@test', 'RECURRENCE-ID:20270302T100000Z', 'SUMMARY:Sport (déplacé)',
      'DTSTART:20270302T160000Z', 'DTEND:20270302T170000Z', 'END:VEVENT',
    ];
    const r = analyser(ics(serie, exception));
    expect(r.plages).toEqual([
      { debut: '2027-03-01T10:00:00Z', fin: '2027-03-01T11:00:00Z', journeeEntiere: false, titre: 'Sport', lieu: 'Gymnase' },
      { debut: '2027-03-02T16:00:00Z', fin: '2027-03-02T17:00:00Z', journeeEntiere: false, titre: 'Sport (déplacé)' },
      { debut: '2027-03-03T10:00:00Z', fin: '2027-03-03T11:00:00Z', journeeEntiere: false, titre: 'Sport', lieu: 'Gymnase' },
    ]);
  });
});

describe('plafonds', () => {
  const evenements = (n: number, fabrique: (i: number) => string[]): string =>
    ics(...Array.from({ length: n }, (_, i) => fabrique(i)));
  const plafond = (texte: string, options: Partial<OptionsAnalyse> = {}): string | undefined => {
    try {
      analyser(texte, options);
    } catch (erreur) {
      if (erreur instanceof ErreurIcsTropGros) return erreur.plafond;
      throw erreur;
    }
    return undefined;
  };

  it(`${PLAFONDS.evenements} VEVENT passent, un de plus lève ErreurIcsTropGros`, () => {
    // Transparents : aucune plage, donc le plafond de plages n'entre pas en jeu.
    const un = (): string[] => uneHeure('20270301T100000Z', 'TRANSP:TRANSPARENT');
    expect(plafond(evenements(PLAFONDS.evenements, un))).toBeUndefined();
    expect(plafond(evenements(PLAFONDS.evenements + 1, un))).toBe('evenements');
  });

  it(`plus de ${PLAFONDS.occurrences} occurrences d'une règle dans l'horizon : ErreurIcsTropGros`, () => {
    const regle = ics(uneHeure('20270101T100000Z', 'RRULE:FREQ=DAILY'));
    expect(plafond(regle, { horizonFin: new Date('2027-12-31T23:59:59Z') })).toBeUndefined();
    expect(plafond(regle, { horizonFin: new Date('2029-12-31T23:59:59Z') })).toBe('occurrences');
  });

  it('plafond d\'itérations : un COUNT lointain depuis un DTSTART très ancien', () => {
    const regle = ics(uneHeure('19000101T100000Z', 'RRULE:FREQ=DAILY;COUNT=999999999'));
    const options = { horizonDebut: new Date('2190-01-01T00:00:00Z'), horizonFin: new Date('2190-01-08T00:00:00Z') };
    expect(plafond(regle, options)).toBe('iterations');
    // Même règle, DTSTART plus récent : sous le plafond, aucune occurrence tombant dans l'horizon.
    const proche = ics(uneHeure('20260101T100000Z', 'RRULE:FREQ=DAILY;COUNT=999999999'));
    expect(plafond(proche, { horizonDebut: new Date('2027-01-01Z'), horizonFin: new Date('2027-01-08Z') })).toBeUndefined();
  });

  it('5000 plages passent, une de plus lève ErreurIcsTropGros (valeur figée en littéral)', () => {
    expect(PLAFONDS.plages).toBe(5000);
    // 5 séries quotidiennes de 1000 occurrences = 5000 plages (plus que les 5000 VEVENT permis n'en donneraient un par un).
    const serie = (): string[] => uneHeure('20270101T100000Z', 'RRULE:FREQ=DAILY;COUNT=1000');
    const options = { horizonFin: new Date('2030-12-31T23:59:59Z') };
    const cinq = Array.from({ length: 5 }, serie);
    expect(plafond(ics(...cinq), options)).toBeUndefined();
    expect(plafond(ics(...cinq, uneHeure('20270101T120000Z')), options)).toBe('plages');
  });

  it('2 Mo de texte cumulé passent, un caractère de plus lève ErreurIcsTropGros (valeur figée en littéral)', () => {
    expect(PLAFONDS.texte).toBe(2_000_000);
    const avecTexte = (n: number, longueur: number): string =>
      evenements(n, () => uneHeure('20270301T100000Z', `DESCRIPTION:${'d'.repeat(longueur)}`));
    expect(plafond(avecTexte(1000, 2000))).toBeUndefined(); // 1000 x 2000 = 2 000 000, pile la borne
    expect(plafond(avecTexte(1001, 2000))).toBe('texte');
    // Titre et lieu comptent comme la description : 140 + 140 + 1720 = 2000 par plage.
    const melange = (n: number): string =>
      evenements(n, () => uneHeure('20270301T100000Z', `SUMMARY:${'t'.repeat(140)}`, `LOCATION:${'l'.repeat(140)}`, `DESCRIPTION:${'d'.repeat(1720)}`));
    expect(plafond(melange(1000))).toBeUndefined();
    expect(plafond(melange(1001))).toBe('texte');
    // Le texte d'une série compte une fois par occurrence (il sera stocké plage par plage).
    const serie = ics(uneHeure('20270101T100000Z', `DESCRIPTION:${'d'.repeat(2000)}`, 'RRULE:FREQ=DAILY;COUNT=300'));
    expect(plafond(serie)).toBeUndefined(); // 300 x 2000 = 600 000
    expect(plafond(ics(...Array.from({ length: 4 }, () => uneHeure('20270101T100000Z', `DESCRIPTION:${'d'.repeat(2000)}`, 'RRULE:FREQ=DAILY;COUNT=300'))))).toBe('texte'); // 2 400 000
  });

  it('plafond de plages brutes (mémoire)', () => {
    const horizonFin = new Date(Date.UTC(2027, 0, 1) + 990 * 86_400_000);
    const quotidien = (): string[] => uneHeure('20270101T100000Z', 'RRULE:FREQ=DAILY');
    const n = Math.ceil(PLAFONDS.plagesBrutes / 990) + 1;
    expect(plafond(evenements(n, quotidien), { horizonFin })).toBe('plagesBrutes');
  });

  it('budget de temps épuisé (horloge simulée) : ErreurIcsTropGros', () => {
    const horloge = vi.spyOn(performance, 'now');
    horloge.mockReturnValueOnce(0).mockReturnValue(PLAFONDS.tempsMs + 1);
    // Plus de PERIODE_HORLOGE lignes : la vérification n'a pas lieu à chaque appel.
    const texte = evenements(300, (i) => uneHeure(`2027030${(i % 9) + 1}T100000Z`));
    expect(plafond(texte)).toBe('temps');
  });

  it('sans dépassement de temps, la même entrée passe', () => {
    const texte = ics(...Array.from({ length: 300 }, (_, i) => uneHeure(`2027030${(i % 9) + 1}T100000Z`)));
    expect(analyser(texte).plages.length).toBeGreaterThan(0);
  });

  it('l\'erreur de plafond est typée et porte le plafond', () => {
    const erreur = new ErreurIcsTropGros('plages');
    expect(erreur).toBeInstanceOf(Error);
    expect(erreur.name).toBe('ErreurIcsTropGros');
    expect(erreur.plafond).toBe('plages');
  });
});

describe('texte illisible et calendrier vide', () => {
  it.each([
    ['vide', ''],
    ['texte libre', 'Bonjour, ceci n\'est pas un agenda.'],
    ['JSON', '{"events": []}'],
    ['VEVENT sans VCALENDAR', 'BEGIN:VEVENT\r\nDTSTART:20270301T100000Z\r\nEND:VEVENT\r\n'],
    ['VCALENDAR tronqué', 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20270301T100000Z\r\n'],
    ['END qui ne correspond pas', 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VTODO\r\nEND:VCALENDAR\r\n'],
    ['ligne sans deux-points', 'BEGIN:VCALENDAR\r\nn importe quoi\r\nEND:VCALENDAR\r\n'],
    ['contenu hors composant', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\nDTSTART:20270301T100000Z\r\n'],
  ])('%s : lève ErreurIcsIllisible', (_nom, texte) => {
    expect(() => analyser(texte)).toThrow(ErreurIcsIllisible);
  });

  it('compose avec le BOM UTF-8 en tête', () => {
    expect(analyser(`${'\ufeff'}${ics(uneHeure('20270301T100000Z'))}`).plages).toHaveLength(1);
  });

  it('imbrication excessive : ErreurIcsIllisible', () => {
    const texte = `BEGIN:VCALENDAR\r\n${'BEGIN:X-A\r\n'.repeat(PLAFONDS.profondeur)}`;
    expect(() => analyser(texte)).toThrow(ErreurIcsIllisible);
  });

  it('un calendrier valide sans VEVENT n\'est pas une erreur', () => {
    expect(analyser(ics())).toEqual({ plages: [], ignores: 0, avertissements: [] });
  });

  it('un calendrier avec seulement un VTIMEZONE (non interprété) rend aucune plage', () => {
    const fuseau = ['BEGIN:VTIMEZONE', 'TZID:Romance Standard Time', 'BEGIN:STANDARD', 'DTSTART:16010101T030000', 'END:STANDARD', 'END:VTIMEZONE'];
    expect(analyser(ics(fuseau))).toEqual({ plages: [], ignores: 0, avertissements: [] });
  });

  it('les erreurs sont typées et distinctes', () => {
    expect(new ErreurIcsIllisible('x')).toBeInstanceOf(Error);
    expect(new ErreurIcsIllisible('x').name).toBe('ErreurIcsIllisible');
    expect(new ErreurIcsIllisible('x')).not.toBeInstanceOf(ErreurIcsTropGros);
  });
});
