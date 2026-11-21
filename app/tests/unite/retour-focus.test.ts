import { describe, expect, it } from 'vitest';
import { premierVisible } from '../../client/src/lib/retour-focus.js';

// Retour du focus de la feuille « Créer » : le déclencheur d'origine d'abord, l'autre s'il a disparu (redimensionnement).
describe('retour du focus de la feuille « Créer »', () => {
  const bandeau = { nom: 'bandeau', visible: true };
  const laterale = { nom: 'laterale', visible: true };
  const visible = (c: { visible: boolean }): boolean => c.visible;

  it('le déclencheur d’origine, quand il est encore visible', () => {
    expect(premierVisible([laterale, bandeau], visible)).toBe(laterale);
    expect(premierVisible([bandeau, laterale], visible)).toBe(bandeau);
  });

  it('l’autre déclencheur, quand celui d’origine a été masqué par un redimensionnement', () => {
    expect(premierVisible([{ ...bandeau, visible: false }, laterale], visible)).toBe(laterale);
    expect(premierVisible([{ ...laterale, visible: false }, bandeau], visible)).toBe(bandeau);
  });

  it('aucun visible : null, l’appelant replie le focus sur le contenu principal', () => {
    expect(premierVisible([{ ...bandeau, visible: false }, { ...laterale, visible: false }], visible)).toBeNull();
    expect(premierVisible([], visible)).toBeNull();
  });
});
