import { describe, expect, it } from 'vitest';
import {
  effacerInvitationEnAttente,
  garderInvitationEnAttente,
  jetonALArrivee,
  lireInvitationEnAttente,
  type Stockage,
} from '../../client/src/invitationEnAttente.js';

const JETON_A = 'A'.repeat(43);
const JETON_B = 'B'.repeat(43);

function stockageEnMemoire(): Stockage & { valeurs: Map<string, string> } {
  const valeurs = new Map<string, string>();
  return {
    valeurs,
    getItem: (cle) => valeurs.get(cle) ?? null,
    setItem: (cle, valeur) => void valeurs.set(cle, valeur),
    removeItem: (cle) => void valeurs.delete(cle),
  };
}

/** Un stockage dont tout accès lève, comme en navigation privée ou données de site bloquées. */
const stockageCasse: Stockage = {
  getItem: () => {
    throw new Error('bloqué');
  },
  setItem: () => {
    throw new Error('bloqué');
  },
  removeItem: () => {
    throw new Error('bloqué');
  },
};

describe('jeton d’invitation en attente', () => {
  it('garde puis relit le jeton, et l’efface', () => {
    const s = stockageEnMemoire();
    expect(garderInvitationEnAttente(JETON_A, s)).toBe(true);
    expect(lireInvitationEnAttente(s)).toBe(JETON_A);
    effacerInvitationEnAttente(s);
    expect(lireInvitationEnAttente(s)).toBeNull();
  });

  it('ne renvoie jamais une valeur altérée', () => {
    const s = stockageEnMemoire();
    s.setItem('attroupe.invitation_en_attente', 'trop-court&x=1');
    expect(lireInvitationEnAttente(s)).toBeNull();
  });

  it('un stockage qui lève ne fait rien planter', () => {
    expect(garderInvitationEnAttente(JETON_A, stockageCasse)).toBe(false);
    expect(lireInvitationEnAttente(stockageCasse)).toBeNull();
    expect(() => effacerInvitationEnAttente(stockageCasse)).not.toThrow();
  });

  it('sans stockage du tout, le parcours reste utilisable', () => {
    expect(garderInvitationEnAttente(JETON_A, null)).toBe(false);
    expect(lireInvitationEnAttente(null)).toBeNull();
    expect(jetonALArrivee(`#jeton=${JETON_A}`, null)).toBe(JETON_A);
  });
});

describe('accesseur du stockage de l’onglet', () => {
  it('un accesseur `sessionStorage` qui lève (navigation privée) ne fait rien planter', () => {
    const avant = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get: () => {
        throw new Error('accès refusé');
      },
    });
    try {
      expect(lireInvitationEnAttente()).toBeNull();
      expect(garderInvitationEnAttente(JETON_A)).toBe(false);
      expect(() => effacerInvitationEnAttente()).not.toThrow();
      expect(jetonALArrivee(`#jeton=${JETON_A}`)).toBe(JETON_A);
    } finally {
      if (avant === undefined) Reflect.deleteProperty(globalThis, 'sessionStorage');
      else Object.defineProperty(globalThis, 'sessionStorage', avant);
    }
  });
});

describe('jetonALArrivee', () => {
  it('garde le jeton du lien', () => {
    const s = stockageEnMemoire();
    expect(jetonALArrivee(`#jeton=${JETON_A}`, s)).toBe(JETON_A);
    expect(lireInvitationEnAttente(s)).toBe(JETON_A);
  });

  it('un lien frais remplace le jeton plus ancien', () => {
    const s = stockageEnMemoire();
    garderInvitationEnAttente(JETON_A, s);
    expect(jetonALArrivee(`#jeton=${JETON_B}`, s)).toBe(JETON_B);
    expect(lireInvitationEnAttente(s)).toBe(JETON_B);
  });

  it('sans fragment, reprend le jeton gardé', () => {
    const s = stockageEnMemoire();
    garderInvitationEnAttente(JETON_A, s);
    expect(jetonALArrivee('', s)).toBe(JETON_A);
  });

  it('un fragment mal formé ne remplace rien', () => {
    const s = stockageEnMemoire();
    garderInvitationEnAttente(JETON_A, s);
    expect(jetonALArrivee('#jeton=court', s)).toBe(JETON_A);
  });
});
