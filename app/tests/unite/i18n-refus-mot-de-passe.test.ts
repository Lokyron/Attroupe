// Un refus que l'utilisateur ne comprend pas est un refus qui le bloque.
//
// Les cinq raisons de `evaluerMotDePasse` n'avaient aucun libellé côté client : l'inscription
// échouait sur « Une erreur est survenue. Réessayez. », cinq fois de suite, jusqu'à ce que la
// limitation de cadence s'en mêle. Le serveur disait pourtant précisément ce qui n'allait pas.
//
// Ce test ferme la classe de défaut, pas seulement le cas : `RaisonRefus` étant un type union,
// le `satisfies Record<RaisonRefus, true>` ci-dessous fait **échouer la compilation** si une
// raison est ajoutée sans être recensée ici, et l'assertion fait échouer le test si elle n'a
// pas de libellé.
import { describe, expect, it } from 'vitest';
import { evaluerMotDePasse, type RaisonRefus } from '../../server/domain/mot-de-passe.js';
import fr from '../../client/src/i18n/fr.json' with { type: 'json' };

const libelles = fr as Record<string, string>;

/** Toutes les raisons de refus. Ajouter une raison à l'union sans l'inscrire ici ne compile pas. */
const RAISONS = {
  'mot_de_passe.trop_court': true,
  'mot_de_passe.trop_long': true,
  'mot_de_passe.trop_courant': true,
  'mot_de_passe.trop_simple': true,
  'mot_de_passe.contient_identifiant': true,
} satisfies Record<RaisonRefus, true>;

describe('refus de mot de passe : l’utilisateur doit savoir quoi corriger', () => {
  it.each(Object.keys(RAISONS) as RaisonRefus[])(
    '%s porte un libellé client, et non le message générique',
    (raison) => {
      const libelle = libelles[`erreur.${raison}`];
      expect(libelle, `erreur.${raison} manque dans app/client/src/i18n/fr.json`).toBeDefined();
      expect(libelle).not.toBe(libelles['erreur.inconnue']);
      expect((libelle ?? '').length).toBeGreaterThan(15);
    },
  );

  // Les raisons doivent rester atteignables : un test vert sur une branche morte ne prouve rien.
  it.each([
    ['court', 'Abc1!', 'mot_de_passe.trop_court'],
    ['courant', 'motdepasse123', 'mot_de_passe.trop_courant'],
    ['simple', 'abababababab', 'mot_de_passe.trop_simple'],
    ['long', 'A1!'.repeat(50), 'mot_de_passe.trop_long'],
  ] as const)('un mot de passe trop %s est bien refusé pour cette raison', (_, essai, attendu) => {
    expect(evaluerMotDePasse(essai)).toBe(attendu);
  });

  it('un mot de passe contenant le nom d’utilisateur est refusé pour cette raison', () => {
    expect(evaluerMotDePasse('Theocaffin-Violette-47', { identifiants: ['theocaffin'] })).toBe(
      'mot_de_passe.contient_identifiant',
    );
  });

  it('un mot de passe correct passe', () => {
    expect(evaluerMotDePasse('Chaussette-Violette-47', { identifiants: ['theocaffin'] })).toBeUndefined();
  });
});
