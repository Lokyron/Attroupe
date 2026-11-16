import { describe, expect, it } from 'vitest';
import { lienGoogleAgenda } from '../../client/src/api/lien-google.js';

// Lien « S'abonner avec Google Agenda » de l'écran Compte : seule la construction est éprouvée, pas le comportement chez Google.
describe('lien Google Agenda', () => {
  it('encode l\u2019adresse https du flux dans le paramètre cid', () => {
    const url = 'https://attroupe.exemple.fr/ical/abc_DEF-123.ics';
    expect(lienGoogleAgenda(url)).toBe('https://calendar.google.com/calendar/r?cid=https%3A%2F%2Fattroupe.exemple.fr%2Fical%2Fabc_DEF-123.ics');
  });

  it('ne laisse passer ni « : » ni « / » bruts dans le cid, et se relit à l\u2019identique', () => {
    const url = 'https://h.fr:8443/ical/j.ics?a=1&b=2';
    const cid = new URL(lienGoogleAgenda(url)).searchParams.get('cid');
    expect(lienGoogleAgenda(url).split('cid=')[1]).not.toMatch(/[:/&?]/);
    expect(cid).toBe(url);
  });
});
