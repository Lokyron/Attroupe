import { describe, expect, it } from 'vitest';
import { ACTIONS_CREATION, etatActionsCreation, lienActionCreation } from '../../client/src/lib/actions-creation.js';

const a = { group_id: 'a/1', name: 'Famille' };
const b = { group_id: 'b2', name: 'Voisins' };

describe('lienActionCreation', () => {
  it('construit le lien de chaque action dans le groupe, identifiant encodé', () => {
    expect(lienActionCreation('evenement', 'a/1')).toBe('#/groupe/a%2F1/evenement-nouveau');
    expect(lienActionCreation('depense', 'b2')).toBe('#/groupe/b2/depenses');
    expect(lienActionCreation('liste', 'b2')).toBe('#/groupe/b2/listes');
  });
});

describe('etatActionsCreation', () => {
  it('sans groupe : les trois actions sont désactivées, avec la raison « aucun groupe »', () => {
    const etats = etatActionsCreation([], '');
    expect(etats.map((e) => e.action)).toEqual([...ACTIONS_CREATION]);
    for (const e of etats) expect(e).toMatchObject({ lien: null, raison: 'aucun_groupe', groupe: null });
  });

  it('un seul groupe : il est visé d’office', () => {
    for (const e of etatActionsCreation([a], '')) {
      expect(e.raison).toBeNull();
      expect(e.groupe).toEqual(a);
      expect(e.lien).toBe(lienActionCreation(e.action, 'a/1'));
    }
  });

  it('plusieurs groupes sans choix : désactivées, il faut choisir', () => {
    for (const e of etatActionsCreation([a, b], '')) expect(e).toMatchObject({ lien: null, raison: 'choisir_groupe' });
  });

  it('plusieurs groupes avec un choix valide : le groupe choisi est visé', () => {
    for (const e of etatActionsCreation([a, b], 'b2')) expect(e.lien).toBe(lienActionCreation(e.action, 'b2'));
  });

  it('plusieurs groupes avec un choix inconnu (groupe quitté) : pas de cible devinée', () => {
    for (const e of etatActionsCreation([a, b], 'zzz')) expect(e).toMatchObject({ lien: null, raison: 'choisir_groupe' });
  });
});
