import { describe, expect, it } from 'vitest';
import { aFormeDIdentifiant, decoderSegment, estFragmentDeRoute, separerFragment } from '../../client/src/lib/fragment-route.js';

describe('estFragmentDeRoute', () => {
  it('accepte les fragments de route', () => {
    for (const hash of ['', '#', '#/', '#/nouveau', '#/groupe/abc/agenda']) {
      expect(estFragmentDeRoute(hash), hash).toBe(true);
    }
  });

  it("refuse les ancres de page, dont celle du lien d'évitement", () => {
    for (const hash of ['#contenu-principal', '#main', '#groupe/abc']) {
      expect(estFragmentDeRoute(hash), hash).toBe(false);
    }
  });
});

describe('separerFragment', () => {
  it('sépare le chemin de la requête', () => {
    expect(separerFragment('#/groupe/g1/agenda?vue=semaine&date=2027-03-12')).toEqual({
      segments: ['groupe', 'g1', 'agenda'],
      requete: 'vue=semaine&date=2027-03-12',
    });
  });

  it('rend une requête vide quand il n’y en a pas', () => {
    expect(separerFragment('#/groupe/g1/albums/a1')).toEqual({ segments: ['groupe', 'g1', 'albums', 'a1'], requete: '' });
    expect(separerFragment('#/groupe/g1/agenda?')).toEqual({ segments: ['groupe', 'g1', 'agenda'], requete: '' });
  });

  it('garde les segments vides, que le routeur traite comme une route inconnue', () => {
    expect(separerFragment('#/groupe//agenda').segments).toEqual(['groupe', '', 'agenda']);
  });

  it('reste une route : un fragment avec requête commence toujours par #/', () => {
    expect(estFragmentDeRoute('#/groupe/g1/agenda?vue=liste')).toBe(true);
  });

  it('ne lève pas sur le fragment vide ou sans chemin', () => {
    expect(separerFragment('')).toEqual({ segments: [], requete: '' });
    expect(separerFragment('#')).toEqual({ segments: [], requete: '' });
    expect(separerFragment('#/?vue=liste')).toEqual({ segments: [''], requete: 'vue=liste' });
  });
});

describe('decoderSegment', () => {
  it('décode un segment bien formé', () => {
    expect(decoderSegment('g%201')).toBe('g 1');
    expect(decoderSegment('%C3%A9t%C3%A9')).toBe('été');
    expect(decoderSegment('abc')).toBe('abc');
  });

  it('rend null, sans lever, sur un pourcentage mal formé', () => {
    for (const segment of ['%E0', '%', '%zz', 'a%2', '%C3%28']) {
      expect(decoderSegment(segment), segment).toBeNull();
    }
  });
});

describe('aFormeDIdentifiant', () => {
  it('reconnaît un UUID v7 et refuse les mots de page ou les segments mal formés', () => {
    expect(aFormeDIdentifiant('0193a5c2-7b1e-7c3a-9f4d-1a2b3c4d5e6f')).toBe(true);
    for (const segment of ['sources', 'nouveau', '', '0193a5c2', '0193A5C2-7B1E-7C3A-9F4D-1A2B3C4D5E6F', '../x']) {
      expect(aFormeDIdentifiant(segment), segment).toBe(false);
    }
  });
});
