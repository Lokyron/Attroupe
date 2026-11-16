import { describe, expect, it } from 'vitest';
import { echapperTexte, genererCalendrier, plierLigne, sequenceDe, type EvenementIcal, type LibellesIcal } from '../../server/domain/ical.js';
import { base32, FORME_JETON_FLUX, nouveauJetonFlux, urlFlux, urlWebcal } from '../../server/domain/jetons.js';

// Format iCalendar (RFC 5545) : pliage en OCTETS, échappement, structure du VCALENDAR. Logique pure, sans base.

const octets = (texte: string): number => Buffer.byteLength(texte, 'utf8');
/** Dépliage (RFC 5545 §3.1) : CRLF suivi d'une espace ou d'une tabulation disparaît. */
const deplier = (texte: string): string => texte.replace(/\r\n[ \t]/g, '');

const LIBELLES: LibellesIcal = { lieu: 'Lieu', consignes: 'Consignes', fuseau: 'Fuseau', lien: 'Lien' };

function evenement(surcharges: Partial<EvenementIcal> = {}): EvenementIcal {
  return {
    id: 'ev-1',
    groupe: 'La bande',
    titre: 'Soirée raclette',
    description: null,
    lieuNom: null,
    lieuAdresse: null,
    consignes: null,
    journeeEntiere: false,
    debut: '2027-03-20T18:00:00Z',
    fin: '2027-03-20T22:30:00Z',
    fuseau: 'Europe/Paris',
    annule: false,
    modifieLe: '2026-11-15T12:00:00Z',
    organisateur: 'Alice',
    lien: 'https://attroupe.test/#/groupe/g1/evenement/ev-1',
    ...surcharges,
  };
}

describe('pliage à 75 octets', () => {
  it('ne touche pas une ligne courte', () => {
    expect(plierLigne('SUMMARY:court')).toBe('SUMMARY:court');
  });

  it('plie un titre accentué long sur les OCTETS, jamais au milieu d’un caractère', () => {
    // « é » pèse 2 octets : 75 caractères feraient 150 octets. Un pliage « à 75 caractères » dépasserait la limite de moitié.
    const ligne = `SUMMARY:${'é'.repeat(120)}`;
    const pliee = plierLigne(ligne);
    const lignes = pliee.split('\r\n');
    expect(lignes.length).toBeGreaterThan(1);
    for (const l of lignes) expect(octets(l), `« ${l} » dépasse 75 octets`).toBeLessThanOrEqual(75);
    // Les continuations commencent par UNE espace, comptée dans les 75 octets.
    for (const l of lignes.slice(1)) expect(l.startsWith(' ')).toBe(true);
    // Rien n'est perdu ni coupé en deux : le dépliage rend la ligne d'origine.
    expect(deplier(pliee)).toBe(ligne);
    expect(pliee).not.toContain('�');
  });

  it('remplit les lignes au plus près : 75 octets pour la première, 75 (espace comprise) ensuite', () => {
    const lignes = plierLigne(`X:${'a'.repeat(200)}`).split('\r\n');
    expect(lignes.map(octets)).toEqual([75, 75, 54]);
  });

  it('ne coupe pas non plus un caractère sur 3 octets (€) ni sur 4 (émoji)', () => {
    for (const caractere of ['€', '🎉']) {
      const ligne = `SUMMARY:${caractere.repeat(60)}`;
      const pliee = plierLigne(ligne);
      for (const l of pliee.split('\r\n')) expect(octets(l)).toBeLessThanOrEqual(75);
      expect(deplier(pliee)).toBe(ligne);
    }
  });

  it('une coupure qui tomberait pile sur la limite ne produit pas de ligne vide', () => {
    const lignes = plierLigne(`X:${'a'.repeat(73)}`).split('\r\n'); // 75 octets exactement
    expect(lignes).toEqual([`X:${'a'.repeat(73)}`]);
  });
});

describe('échappement des valeurs de texte', () => {
  it('échappe l’antislash, le point-virgule, la virgule et les retours à la ligne', () => {
    expect(echapperTexte('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
    expect(echapperTexte('ligne1\r\nligne2\rligne3')).toBe('ligne1\\nligne2\\nligne3');
  });

  it('échappe l’antislash AVANT le reste (pas de double échappement)', () => {
    // Entrée : antislash + point-virgule. Sortie : antislash doublé, puis point-virgule échappé (trois antislashs en tout).
    expect(echapperTexte(String.raw`\;`)).toBe(String.raw`\\\;`);
  });

  it('supprime les caractères de commande (hors tabulation)', () => {
    expect(echapperTexte('a\u0000b\u0007c\td')).toBe('abc\td');
  });
});

describe('VCALENDAR', () => {
  const ics = genererCalendrier('Attroupe', [evenement()], LIBELLES);

  it('commence et finit comme il faut, avec les propriétés obligatoires', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    for (const ligne of ['VERSION:2.0', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Attroupe']) expect(ics).toContain(`\r\n${ligne}\r\n`);
    expect(ics).toMatch(/\r\nPRODID:-\/\/Attroupe/);
  });

  it('termine TOUTES les lignes par CRLF (aucun saut de ligne nu)', () => {
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('un événement à l’heure : DTSTART en UTC, UID stable, préfixe du groupe dans SUMMARY', () => {
    expect(ics).toContain('\r\nUID:ev-1@attroupe\r\n');
    expect(ics).toContain('\r\nDTSTART:20270320T180000Z\r\n');
    expect(ics).toContain('\r\nDTEND:20270320T223000Z\r\n');
    expect(ics).toContain('\r\nSUMMARY:[La bande] Soirée raclette\r\n');
    expect(ics).toContain('\r\nSTATUS:CONFIRMED\r\n');
    expect(ics).not.toContain('TZID');
    expect(ics).not.toContain('VTIMEZONE');
  });

  it('une journée entière : DTSTART;VALUE=DATE, et la fin est EXCLUSIVE (lendemain du dernier jour)', () => {
    const jour = genererCalendrier('A', [evenement({ journeeEntiere: true, debut: '2027-03-20', fin: '2027-03-21' })], LIBELLES);
    expect(jour).toContain('\r\nDTSTART;VALUE=DATE:20270320\r\n');
    expect(jour).toContain('\r\nDTEND;VALUE=DATE:20270322\r\n');
    const sansFin = genererCalendrier('A', [evenement({ journeeEntiere: true, debut: '2027-12-31', fin: null })], LIBELLES);
    expect(sansFin).toContain('\r\nDTEND;VALUE=DATE:20280101\r\n');
  });

  it('un événement annulé reste dans le flux, en STATUS:CANCELLED (c’est ce qui le fait disparaître du téléphone)', () => {
    const annule = genererCalendrier('A', [evenement({ annule: true })], LIBELLES);
    expect(annule).toContain('\r\nSTATUS:CANCELLED\r\n');
    expect(annule).toContain('\r\nUID:ev-1@attroupe\r\n');
  });

  it('un titre malveillant ne peut pas ouvrir une nouvelle propriété', () => {
    const piege = genererCalendrier('A', [evenement({ titre: 'x\r\nATTENDEE:mailto:pirate@exemple.test\r\nEND:VEVENT' })], LIBELLES);
    expect(piege).not.toMatch(/\r\nATTENDEE:/);
    expect(piege.match(/\r\nEND:VEVENT\r\n/g)).toHaveLength(1);
    expect(piege).toContain('SUMMARY:[La bande] x\\nATTENDEE:mailto:pirate@exemple.test\\nEND:VEVENT');
  });

  it('échappe les caractères spéciaux du titre, du lieu et de la description', () => {
    const e = evenement({ titre: 'Dîner; chez Léa, 2e étage', lieuNom: 'Chez Léa', lieuAdresse: '12, rue A; Lyon', description: 'Ligne 1\nLigne 2' });
    const texte = deplier(genererCalendrier('A', [e], LIBELLES));
    expect(texte).toContain('SUMMARY:[La bande] Dîner\\; chez Léa\\, 2e étage');
    expect(texte).toContain('LOCATION:Chez Léa\\, 12\\, rue A\\; Lyon');
    expect(texte).toContain('DESCRIPTION:Ligne 1\\nLigne 2\\nLieu : Chez Léa\\, 12\\, rue A\\; Lyon');
  });

  it('la DESCRIPTION porte lieu, consignes, fuseau d’origine et lien — jamais d’autre chose', () => {
    const e = evenement({ lieuNom: 'Chez Léa', consignes: 'Sonner deux fois' });
    const texte = deplier(genererCalendrier('A', [e], LIBELLES));
    expect(texte).toContain('Consignes : Sonner deux fois');
    expect(texte).toContain('Fuseau : Europe/Paris');
    expect(texte).toContain('Lien : https://attroupe.test/#/groupe/g1/evenement/ev-1');
  });

  it('plie les longues lignes d’un vrai flux (titre accentué de 140 caractères)', () => {
    const ics140 = genererCalendrier('A', [evenement({ titre: 'é'.repeat(140) })], LIBELLES);
    for (const ligne of ics140.split('\r\n')) expect(octets(ligne)).toBeLessThanOrEqual(75);
    expect(deplier(ics140)).toContain(`SUMMARY:[La bande] ${'é'.repeat(140)}`);
  });

  it('l’organisateur ne divulgue aucune adresse e-mail réelle', () => {
    expect(ics).toContain('\r\nORGANIZER;CN="Alice":mailto:organisateur@attroupe.invalid\r\n');
  });

  it('un nom d’organisateur ne peut pas sortir de ses guillemets', () => {
    const texte = genererCalendrier('A', [evenement({ organisateur: 'Al"ice\r\nX-PIRATE:1' })], LIBELLES);
    expect(texte).not.toMatch(/\r\nX-PIRATE/);
    expect(texte).toContain('ORGANIZER;CN="AliceX-PIRATE:1":');
  });
});

describe('SEQUENCE', () => {
  it('croît avec updated_at', () => {
    expect(sequenceDe('2026-11-15T12:00:01Z')).toBeGreaterThan(sequenceDe('2026-11-15T12:00:00Z'));
    expect(sequenceDe('2026-01-01T00:00:00Z')).toBe(0);
  });

  it('est un entier 32 bits pour longtemps', () => {
    expect(sequenceDe('2060-01-01T00:00:00Z')).toBeLessThan(2 ** 31);
  });
});

describe('jeton de flux', () => {
  it('base32 : alphabet RFC 4648 en minuscules, sans remplissage', () => {
    expect(base32(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]))).toBe('77777777');
    expect(base32(new TextEncoder().encode('foobar'))).toBe('mzxw6ytboi');
  });

  it('32 octets donnent 52 caractères a-z2-7, tous différents d’un tirage à l’autre', () => {
    const a = nouveauJetonFlux();
    expect(a).toMatch(FORME_JETON_FLUX);
    expect(a).toHaveLength(52);
    expect(nouveauJetonFlux()).not.toBe(a);
  });
});

describe('URL du flux : https pour copier, webcal:// pour s’abonner', () => {
  const jeton = 'a'.repeat(52);

  it('construit l’URL depuis une base https, avec ou sans barre oblique finale', () => {
    expect(urlFlux('https://attroupe.test', jeton)).toBe(`https://attroupe.test/ical/${jeton}.ics`);
    expect(urlFlux('https://attroupe.test/', jeton)).toBe(`https://attroupe.test/ical/${jeton}.ics`);
    expect(urlFlux('https://attroupe.test///', jeton)).toBe(`https://attroupe.test/ical/${jeton}.ics`);
  });

  it('remplace https:// par webcal://', () => {
    expect(urlWebcal(urlFlux('https://attroupe.test', jeton))).toBe(`webcal://attroupe.test/ical/${jeton}.ics`);
    expect(urlWebcal(urlFlux('https://attroupe.test/', jeton))).toBe(`webcal://attroupe.test/ical/${jeton}.ics`);
  });

  it('remplace http:// par webcal:// (développement local), port conservé', () => {
    expect(urlWebcal(urlFlux('http://localhost:3000', jeton))).toBe(`webcal://localhost:3000/ical/${jeton}.ics`);
    expect(urlWebcal(urlFlux('http://localhost:3000/', jeton))).toBe(`webcal://localhost:3000/ical/${jeton}.ics`);
  });

  it('refuse une URL qui n’est ni http ni https plutôt que de la déguiser', () => {
    expect(() => urlWebcal('ftp://attroupe.test/x.ics')).toThrow();
    expect(() => urlWebcal('attroupe.test/x.ics')).toThrow();
  });
});
