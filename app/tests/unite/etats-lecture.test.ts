import { describe, expect, it } from 'vitest';
import { fusionnerEtats, premiereErreur } from '../../client/src/hooks/etatsLecture.js';

// Fusion des états de lectures parallèles (celle du groupe et celle de la page) : un seul squelette, une seule erreur.
describe('fusionnerEtats', () => {
  it('tout prêt donne prêt', () => {
    expect(fusionnerEtats('pret', 'pret')).toBe('pret');
  });

  it('un seul chargement suffit à garder le squelette', () => {
    expect(fusionnerEtats('pret', 'chargement')).toBe('chargement');
    expect(fusionnerEtats('chargement', 'pret')).toBe('chargement');
  });

  it('l’erreur l’emporte sur le chargement', () => {
    expect(fusionnerEtats('chargement', 'erreur')).toBe('erreur');
    expect(fusionnerEtats('erreur', 'pret', 'chargement')).toBe('erreur');
  });

  it('sans argument, rien n’est en attente', () => {
    expect(fusionnerEtats()).toBe('pret');
  });
});

describe('premiereErreur', () => {
  it('rend le premier message non nul, dans l’ordre donné', () => {
    expect(premiereErreur(null, 'b')).toBe('b');
    expect(premiereErreur('a', 'b')).toBe('a');
  });

  it('rend null si aucune lecture n’a échoué', () => {
    expect(premiereErreur(null, null)).toBeNull();
    expect(premiereErreur()).toBeNull();
  });
});
