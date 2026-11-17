// Un lien d'e-mail qui ne mène nulle part est un compte bloqué.
//
// Le serveur fabrique `BASE_URL + chemin + '#jeton=…'` (GABARITS_A_JETON) ; le client reconnaît ces pages au
// CHEMIN, parce que son routeur ordinaire route sur le fragment, déjà occupé par le jeton. Les deux tables
// vivaient dans deux paquets différents : rien ne garantissait qu'elles disent la même chose, et c'est
// exactement ce qui est arrivé — le serveur envoyait `/verification-email`, le client n'en avait jamais
// entendu parler, et le lien tombait sur l'accueil sans rien faire.
//
// Ce test les confronte. Ajouter un gabarit à jeton côté serveur sans écrire la page du client échoue ici.
import { describe, expect, it } from 'vitest';
import { GABARITS_A_JETON, lienAvecJeton } from '../../server/services/emails.js';
import { CHEMINS_LIEN, jetonDuFragment, pageDuLien } from '../../client/src/lien.js';

const JETON = 'a'.repeat(43);

describe('liens à jeton : le serveur et le client parlent du même chemin', () => {
  it('chaque gabarit du serveur a une page du client', () => {
    const cotéServeur = Object.values(GABARITS_A_JETON).map((g) => g.chemin).sort();
    const cotéClient = Object.keys(CHEMINS_LIEN).sort();
    expect(cotéServeur).toEqual(cotéClient);
  });

  it.each(Object.entries(GABARITS_A_JETON))('le lien de %s est reconnu et son jeton relu', (_nom, gabarit) => {
    const url = new URL(lienAvecJeton('https://beta.attroupe.fr', gabarit, JETON));
    expect(pageDuLien(url.pathname)).not.toBeNull();
    expect(jetonDuFragment(url.hash)).toBe(JETON);
  });

  it('le jeton reste dans le fragment, jamais dans le chemin ni la requête', () => {
    for (const gabarit of Object.values(GABARITS_A_JETON)) {
      const url = new URL(lienAvecJeton('https://beta.attroupe.fr', gabarit, JETON));
      expect(url.pathname).not.toContain(JETON);
      expect(url.search).toBe('');
      expect(url.hash).toBe(`#jeton=${JETON}`);
    }
  });

  it('un lien tronqué ou sans jeton ne passe pas pour un jeton valide', () => {
    expect(jetonDuFragment('#jeton=' + 'a'.repeat(42))).toBeNull();
    expect(jetonDuFragment('#jeton=a/b')).toBeNull();
    expect(jetonDuFragment('#')).toBeNull();
    expect(jetonDuFragment('')).toBeNull();
  });

  it('une page qui n’est pas un lien à jeton n’est pas reconnue', () => {
    expect(pageDuLien('/')).toBeNull();
    expect(pageDuLien('/groupe/abc')).toBeNull();
    expect(pageDuLien('/verification-email/autre')).toBeNull();
  });

  it('une barre finale ne fait pas rater la page', () => {
    expect(pageDuLien('/verification-email/')).toBe('verification-email');
  });
});
