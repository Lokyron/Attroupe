import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiffuseurTempsReel } from '../../server/services/temps-reel.js';
import type { Decor } from '../fixtures/comptes.js';
import { serveurFlux, type ServeurFlux } from '../fixtures/flux-sse.js';
import { decor, groupe, personne, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';

// Suppression d'un groupe : DELETE /api/groupes/:g (administrateur). Le groupe disparaît pour tous ses membres, et ceux qui avaient le
// flux temps réel ouvert reçoivent `groupe.supprime` AVANT que le groupe ne disparaisse (le flux revérifie l'appartenance à chaque envoi).
describe('suppression d’un groupe (intégration HTTP)', () => {
  let d: Decor;
  let diffuseur: DiffuseurTempsReel;
  let sse: ServeurFlux;
  let alice: Personne; // administratrice de A
  let carole: Personne; // membre de A
  let bob: Personne; // administrateur de B
  let a: GroupeAmorce;
  let b: GroupeAmorce;

  const nomsDeMesGroupes = async (p: Personne): Promise<string[]> =>
    ((await p.client.get('/api/groupes')).corps['groupes'] as Array<{ group_id: string }>).map((x) => x.group_id);

  beforeEach(async () => {
    diffuseur = new DiffuseurTempsReel({ intervalleBattementMs: 3_600_000 });
    d = decor({ diffuseur });
    sse = await serveurFlux(d.app);
    alice = await personne(d, 'alice_gs');
    carole = await personne(d, 'carole_gs');
    bob = await personne(d, 'bob_gs');
    a = await groupe(d, 'Groupe A', [
      { personne: alice, role: 'admin' },
      { personne: carole, role: 'member' },
    ]);
    b = await groupe(d, 'Groupe B', [{ personne: bob, role: 'admin' }]);
  });
  afterEach(async () => {
    await sse.arreter();
    diffuseur.fermerTout();
    d.nettoyer();
  });

  it('l’administrateur supprime : le groupe répond ensuite 404 à tous ses membres et sort de leur liste ; B n’est pas touché', async () => {
    expect(await nomsDeMesGroupes(carole)).toEqual([a.groupId]);
    const r = await alice.client.delete(`/api/groupes/${a.groupId}`);
    expect(r.statut).toBe(200);
    expect(r.corps).toEqual({ ok: true });

    for (const p of [alice, carole]) {
      const lecture = await p.client.get(`/api/groupes/${a.groupId}`);
      expect(lecture.statut).toBe(404);
      expect(lecture.corps).toEqual({ error: 'groupe.introuvable' });
      expect(await nomsDeMesGroupes(p)).not.toContain(a.groupId);
    }
    expect((await alice.client.delete(`/api/groupes/${a.groupId}`)).statut, 'une seconde suppression ne trouve plus rien').toBe(404);
    expect(await nomsDeMesGroupes(bob)).toEqual([b.groupId]);
    expect((await bob.client.get(`/api/groupes/${b.groupId}`)).statut).toBe(200);
  });

  it('un simple membre ne peut pas supprimer (403) et un étranger ne voit pas le groupe (404) : rien n’est supprimé', async () => {
    expect((await carole.client.delete(`/api/groupes/${a.groupId}`)).statut).toBe(403);
    expect((await bob.client.delete(`/api/groupes/${a.groupId}`)).statut).toBe(404);
    expect((await alice.client.get(`/api/groupes/${a.groupId}`)).statut).toBe(200);
  });

  it('les autres membres, flux ouvert, reçoivent `groupe.supprime` ; un flux d’un autre groupe ne reçoit rien', async () => {
    const fluxCarole = await sse.ouvrir(carole.client, a.groupId);
    const fluxBob = await sse.ouvrir(bob.client, b.groupId);
    expect((await alice.client.delete(`/api/groupes/${a.groupId}`)).statut).toBe(200);

    const e = await fluxCarole.attendre((x) => x.type === 'groupe.supprime');
    expect(e).toMatchObject({ type: 'groupe.supprime', ressource: 'groupe', id: a.groupId, parent_id: null });
    expect(Object.keys(e).sort()).toEqual(['at', 'id', 'par', 'parent_id', 'ressource', 'type']);
    expect(fluxBob.evenements).toEqual([]);
  });

  it('une seconde suppression est refusée avant toute diffusion : le flux déjà ouvert ne reçoit qu’un seul `groupe.supprime`', async () => {
    const fluxCarole = await sse.ouvrir(carole.client, a.groupId);
    expect((await alice.client.delete(`/api/groupes/${a.groupId}`)).statut).toBe(200);
    await fluxCarole.attendre((x) => x.type === 'groupe.supprime');

    expect((await alice.client.delete(`/api/groupes/${a.groupId}`)).statut).toBe(404);
    // Le flux écoute pendant la seconde requête ; la diffusion, si elle partait, serait écrite avant la réponse 404. Marge de livraison.
    await new Promise((resolu) => setTimeout(resolu, 150));
    expect(fluxCarole.evenements.filter((x) => x.type === 'groupe.supprime')).toHaveLength(1);

    const nouveauFlux = await sse.ouvrir(carole.client, a.groupId);
    expect(nouveauFlux.statut, 'plus de flux sur un groupe supprimé').toBe(404);
  });
});
