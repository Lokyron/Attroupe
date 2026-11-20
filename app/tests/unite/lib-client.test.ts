import { describe, expect, it } from 'vitest';
import { initialesDe } from '../../client/src/lib/initiales.js';
import { JOURS_LISTE_MAX, lireEtatAgenda, requeteAgenda, type EtatAgenda } from '../../client/src/lib/etat-agenda.js';
import { lienAlbum, lienAlbums, lienCarte, lienEvenement, lienSondage } from '../../client/src/lib/liens.js';
import { decouperLiens } from '../../client/src/lib/liens-texte.js';
import { cleAccord, formeAccord } from '../../client/src/lib/pluriel.js';
import { separerFragment } from '../../client/src/lib/fragment-route.js';
import { exposantIntl, formaterMontantExposant } from '../../client/src/lib/montants.js';

// Modules partagés issus de la factorisation (montants, initiales, liens) : comportement identique aux copies d'origine.
describe('montants', () => {
  it('formate selon l’exposant fourni, sans signe par défaut', () => {
    expect(formaterMontantExposant(1050, 'EUR', 2)).toContain('10,50');
    expect(formaterMontantExposant(1000, 'JPY', 0)).toContain('1');
    expect(formaterMontantExposant(-333, 'EUR', 2)).toContain('3,33');
  });

  it('préfixe « + » aux seuls montants strictement positifs quand le signe est demandé', () => {
    expect(formaterMontantExposant(500, 'EUR', 2, true).startsWith('+')).toBe(true);
    expect(formaterMontantExposant(0, 'EUR', 2, true).startsWith('+')).toBe(false);
    expect(formaterMontantExposant(-500, 'EUR', 2, true).startsWith('+')).toBe(false);
  });

  it('lit l’exposant des devises dans Intl (ISO 4217)', () => {
    expect(exposantIntl('EUR')).toBe(2);
    expect(exposantIntl('JPY')).toBe(0);
    expect(exposantIntl('KWD')).toBe(3);
  });
});

describe('initiales', () => {
  it('prend deux lettres d’un nom seul, première et dernière initiale sinon', () => {
    expect(initialesDe('Camille')).toBe('CA');
    expect(initialesDe('Camille Durand')).toBe('CD');
    expect(initialesDe('  jean  pierre  martin ')).toBe('JM');
  });

  it('rend « ? » pour un nom vide', () => {
    expect(initialesDe('')).toBe('?');
    expect(initialesDe('   ')).toBe('?');
  });
});

describe('liens', () => {
  it('encode les identifiants', () => {
    expect(lienEvenement('g 1', 'e/2')).toBe('#/groupe/g%201/evenement/e%2F2');
    expect(lienSondage('g1', 's?')).toBe('#/groupe/g1/sondage/s%3F');
  });

  it('forme la route d’un album ouvert, que le routeur sait relire', () => {
    expect(lienAlbum('g1', 'a/2')).toBe('#/groupe/g1/albums/a%2F2');
    const { segments } = separerFragment(lienAlbum('g 1', 'a/2'));
    expect(segments.map(decodeURIComponent)).toEqual(['groupe', 'g 1', 'albums', 'a/2']);
    expect(lienAlbum('g1', 'a')).toBe(`${lienAlbums('g1')}/a`);
  });

  it('encode l’adresse envoyée à la carte, y compris ce qui casserait la requête', () => {
    expect(lienCarte('12 rue de la Paix, Paris')).toBe('https://www.openstreetmap.org/search?query=12%20rue%20de%20la%20Paix%2C%20Paris');
    const piege = lienCarte('x&y=1#frag');
    expect(piege).toBe('https://www.openstreetmap.org/search?query=x%26y%3D1%23frag');
    expect(new URL(piege).searchParams.get('query')).toBe('x&y=1#frag');
  });
});

describe('état de l’agenda dans l’URL', () => {
  const defaut: EtatAgenda = { vue: 'mois', ancre: '2027-03-01', joursListe: 30 };

  it('relit une vue, une ancre et un horizon valides', () => {
    expect(lireEtatAgenda('vue=semaine&date=2027-03-12', defaut)).toEqual({ vue: 'semaine', ancre: '2027-03-12', joursListe: 30 });
    expect(lireEtatAgenda('vue=liste&jours=90', defaut)).toEqual({ vue: 'liste', ancre: '2027-03-01', joursListe: 90 });
  });

  it('retombe sur le défaut pour une requête vide, absente ou invalide, sans lever', () => {
    expect(lireEtatAgenda('', defaut)).toEqual(defaut);
    for (const requete of ['vue=annee', 'vue=', 'date=2027-02-30', 'date=hier', 'date=2027-3-1', 'jours=abc', 'jours=-5', 'jours=0', 'jours=1.5', '%E0%A4%A', '&&==']) {
      expect(lireEtatAgenda(requete, defaut), requete).toEqual(defaut);
    }
  });

  it('plafonne l’horizon de la liste', () => {
    expect(lireEtatAgenda('jours=9999', defaut).joursListe).toBe(JOURS_LISTE_MAX);
    expect(lireEtatAgenda('jours=99999999999', defaut).joursListe).toBe(defaut.joursListe);
    expect(lireEtatAgenda(`jours=${JOURS_LISTE_MAX + 1}`, defaut).joursListe).toBe(JOURS_LISTE_MAX);
  });

  it('sérialise puis relit le même état', () => {
    for (const etat of [
      { vue: 'semaine', ancre: '2027-03-12', joursListe: 30 },
      { vue: 'liste', ancre: '2027-12-31', joursListe: 120 },
      { vue: 'mois', ancre: '2028-02-29', joursListe: 30 },
    ] as const) {
      expect(lireEtatAgenda(requeteAgenda(etat).slice(1), defaut)).toEqual(etat);
    }
  });

  it('n’écrit l’horizon que s’il s’écarte du défaut', () => {
    expect(requeteAgenda({ vue: 'semaine', ancre: '2027-03-12', joursListe: 30 })).toBe('?vue=semaine&date=2027-03-12');
    expect(requeteAgenda({ vue: 'liste', ancre: '2027-03-12', joursListe: 60 })).toBe('?vue=liste&date=2027-03-12&jours=60');
  });
});

describe('détection de liens dans un texte', () => {
  const lien = (texte: string, href: string = texte) => ({ type: 'lien', texte, href });
  const brut = (texte: string) => ({ type: 'texte', texte });

  it('rend un texte sans adresse en un seul morceau, et un texte vide en aucun', () => {
    expect(decouperLiens('Apportez des chaises')).toEqual([brut('Apportez des chaises')]);
    expect(decouperLiens('')).toEqual([]);
  });

  it('reconnaît une adresse au milieu du texte', () => {
    expect(decouperLiens('Plan : https://exemple.fr/plan ici')).toEqual([brut('Plan : '), lien('https://exemple.fr/plan'), brut(' ici')]);
  });

  it('laisse la ponctuation de fin de phrase hors du lien', () => {
    expect(decouperLiens('Voir https://exemple.fr/a.')).toEqual([brut('Voir '), lien('https://exemple.fr/a'), brut('.')]);
    expect(decouperLiens('Voir https://exemple.fr/a?!')).toEqual([brut('Voir '), lien('https://exemple.fr/a'), brut('?!')]);
    expect(decouperLiens('https://exemple.fr/a, puis https://exemple.fr/b;')).toEqual([
      lien('https://exemple.fr/a'),
      brut(', puis '),
      lien('https://exemple.fr/b'),
      brut(';'),
    ]);
  });

  it('gère les parenthèses : seule la fermante sans ouvrante sort du lien', () => {
    expect(decouperLiens('(voir https://exemple.fr/a)')).toEqual([brut('(voir '), lien('https://exemple.fr/a'), brut(')')]);
    expect(decouperLiens('https://fr.wikipedia.org/wiki/Paris_(ville)')).toEqual([lien('https://fr.wikipedia.org/wiki/Paris_(ville)')]);
    expect(decouperLiens('(https://fr.wikipedia.org/wiki/Paris_(ville)).')).toEqual([
      brut('('),
      lien('https://fr.wikipedia.org/wiki/Paris_(ville)'),
      brut(').'),
    ]);
  });

  it('refuse tout schéma autre que http et https', () => {
    for (const piege of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'ftp://exemple.fr/f', 'mailto:a@b.fr', 'file:///etc/passwd']) {
      expect(decouperLiens(piege), piege).toEqual([brut(piege)]);
    }
    // Un schéma dangereux accolé à une vraie adresse ne contamine pas celle-ci.
    expect(decouperLiens('javascript:alert(1) puis https://exemple.fr')).toEqual([brut('javascript:alert(1) puis '), lien('https://exemple.fr', 'https://exemple.fr/')]);
  });

  it('ignore une adresse sans hôte', () => {
    expect(decouperLiens('https://')).toEqual([brut('https://')]);
  });

  it('ne perd ni n’ajoute aucun caractère', () => {
    const entree = 'a https://x.fr/y. (b) http://z.fr/(1)), javascript:1 fin';
    expect(decouperLiens(entree).map((m) => m.texte).join('')).toBe(entree);
  });
});

describe('pluriels', () => {
  it('garde 0 et 1 au singulier, accorde dès 2', () => {
    expect(formeAccord(0)).toBe('singulier');
    expect(formeAccord(1)).toBe('singulier');
    expect(formeAccord(1.5)).toBe('singulier');
    expect(formeAccord(2)).toBe('pluriel');
    expect(formeAccord(12)).toBe('pluriel');
    expect(formeAccord(-3)).toBe('pluriel');
  });

  it('compose la clé de libellé', () => {
    expect(cleAccord('push.appareils', 1)).toBe('push.appareils_singulier');
    expect(cleAccord('push.appareils', 3)).toBe('push.appareils_pluriel');
  });
});
