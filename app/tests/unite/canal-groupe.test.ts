import { describe, expect, it, vi } from 'vitest';
import {
  creerCanalGroupe,
  type EtatFlux,
  type EvenementTempsReel,
  type ReferenceAbonne,
} from '../../client/src/api/canalGroupe.js';

// Le multiplexeur du flux SSE d'un groupe : pur, sans React ni EventSource (le transport reste `ouvrirTempsReel`).

const evenement = (id: string): EvenementTempsReel => ({
  type: 'liste.creee',
  ressource: 'liste',
  id,
  parent_id: null,
  par: 'm1',
  at: '2027-03-01T10:00:00Z',
});

/** Un abonné espion : journalise ce qu'il reçoit dans `journal` pour vérifier l'ordre entre abonnés. */
function abonne(nom: string, journal: string[] = []) {
  const onEvenement = vi.fn((e: EvenementTempsReel) => void journal.push(`${nom}:${e.id}`));
  const onOuvert = vi.fn(() => void journal.push(`${nom}:ouvert`));
  const onEtat = vi.fn((etat: EtatFlux) => void journal.push(`${nom}:${etat}`));
  const ref: ReferenceAbonne = { current: { onEvenement, onOuvert, onEtat } };
  return { ref, onEvenement, onOuvert, onEtat };
}

describe('canal du groupe', () => {
  it('distribue un message à tous les abonnés, une fois chacun, dans l’ordre d’inscription', () => {
    const canal = creerCanalGroupe();
    const journal: string[] = [];
    const a = abonne('a', journal);
    const b = abonne('b', journal);
    const c = abonne('c', journal);
    canal.abonner(a.ref);
    canal.abonner(b.ref);
    canal.abonner(c.ref);
    canal.diffuser(evenement('x'));
    expect(journal).toEqual(['a:x', 'b:x', 'c:x']);
    expect(a.onEvenement).toHaveBeenCalledTimes(1);
    expect(c.onEvenement).toHaveBeenCalledTimes(1);
  });

  it('une désinscription retire l’abonné, et un second appel est sans effet', () => {
    const canal = creerCanalGroupe();
    const a = abonne('a');
    const b = abonne('b');
    const retirerA = canal.abonner(a.ref);
    canal.abonner(b.ref);
    expect(canal.nombreAbonnes()).toBe(2);
    retirerA();
    expect(canal.nombreAbonnes()).toBe(1);
    retirerA();
    expect(canal.nombreAbonnes()).toBe(1);
    canal.diffuser(evenement('x'));
    canal.signalerOuverture();
    expect(a.onEvenement).not.toHaveBeenCalled();
    expect(a.onOuvert).not.toHaveBeenCalled();
    expect(b.onEvenement).toHaveBeenCalledTimes(1);
  });

  it('appelle onOuvert chez tous les abonnés à CHAQUE connexion, pas seulement la première', () => {
    const canal = creerCanalGroupe();
    const a = abonne('a');
    const b = abonne('b');
    canal.abonner(a.ref);
    canal.abonner(b.ref);
    canal.signalerOuverture();
    canal.signalerOuverture();
    expect(a.onOuvert).toHaveBeenCalledTimes(2);
    expect(b.onOuvert).toHaveBeenCalledTimes(2);
  });

  it('un abonné tardif reçoit onOuvert tout de suite ; un abonné antérieur ne le reçoit qu’une fois', () => {
    const canal = creerCanalGroupe();
    const tot = abonne('tot');
    canal.abonner(tot.ref);
    canal.signalerOuverture();
    const tard = abonne('tard');
    canal.abonner(tard.ref);
    expect(tot.onOuvert).toHaveBeenCalledTimes(1);
    expect(tard.onOuvert).toHaveBeenCalledTimes(1);
  });

  it('un abonné n’est pas rechargé tant que le flux ne s’est jamais ouvert', () => {
    const canal = creerCanalGroupe();
    const a = abonne('a');
    canal.abonner(a.ref);
    expect(a.onOuvert).not.toHaveBeenCalled();
  });

  it('rejoue le dernier état du flux au nouvel abonné, et rien s’il n’y en a pas eu', () => {
    const canal = creerCanalGroupe();
    const sans = abonne('sans');
    canal.abonner(sans.ref);
    expect(sans.onEtat).not.toHaveBeenCalled();

    canal.signalerEtat('reconnexion');
    expect(sans.onEtat).toHaveBeenCalledWith('reconnexion');
    const avec = abonne('avec');
    canal.abonner(avec.ref);
    expect(avec.onEtat).toHaveBeenCalledTimes(1);
    expect(avec.onEtat).toHaveBeenCalledWith('reconnexion');
  });

  it('un abonné qui lève ne prive pas les suivants, et l’erreur est journalisée', () => {
    const canal = creerCanalGroupe();
    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const casse = abonne('casse');
      casse.onEvenement.mockImplementation(() => {
        throw new Error('boum');
      });
      const suivant = abonne('suivant');
      canal.abonner(casse.ref);
      canal.abonner(suivant.ref);
      canal.diffuser(evenement('x'));
      expect(suivant.onEvenement).toHaveBeenCalledTimes(1);
      expect(erreurs).toHaveBeenCalledTimes(1);
    } finally {
      erreurs.mockRestore();
    }
  });

  it('relit les rappels dans la ref : remplacer current suffit, sans réabonnement', () => {
    const canal = creerCanalGroupe();
    const ancien = abonne('ancien');
    const nouveau = abonne('nouveau');
    // Même objet de ref, rappels remplacés : c'est ce que fait `useTempsReelGroupe` à chaque rendu.
    const ref = { current: ancien.ref.current } as { current: ReferenceAbonne['current'] };
    canal.abonner(ref);
    canal.diffuser(evenement('1'));
    ref.current = nouveau.ref.current;
    canal.diffuser(evenement('2'));
    expect(ancien.onEvenement).toHaveBeenCalledTimes(1);
    expect(nouveau.onEvenement).toHaveBeenCalledTimes(1);
    expect(nouveau.onEvenement).toHaveBeenCalledWith(evenement('2'));
    expect(canal.nombreAbonnes()).toBe(1);
  });
});
