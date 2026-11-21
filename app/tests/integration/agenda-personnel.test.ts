import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JOURNAL_SILENCIEUX } from '../../server/http/middleware/journal.js';
import type { Decor } from '../fixtures/comptes.js';
import { secretFactice } from '../fixtures/env.js';
import { demarrerFauxAgenda, ICS_UN_EVENEMENT, type FauxAgenda } from '../fixtures/faux-agenda.js';
import { decor, groupe, membreDe, personne, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';

// Agenda personnel et disponibilités de groupe (lot 8) : les routes HTTP, le cloisonnement (404 agenda.introuvable)
// et la confidentialité 'busy' vs 'details', sous le réglage de compte unique (ADR-0017).
describe('agenda personnel et disponibilités (API)', () => {
  let d: Decor;
  let alice: Personne;
  let bob: Personne;
  let erik: Personne; // hors du groupe principal
  let g: GroupeAmorce;
  let autre: GroupeAmorce; // groupe étranger à Alice

  beforeEach(async () => {
    d = decor();
    alice = await personne(d, 'alice_ap');
    bob = await personne(d, 'bob_ap');
    erik = await personne(d, 'erik_ap');
    g = await groupe(d, 'Famille', [
      { personne: alice, role: 'admin' },
      { personne: bob, role: 'member' },
    ]);
    autre = await groupe(d, 'Voisins', [{ personne: erik, role: 'admin' }]);
  });

  afterEach(() => d.nettoyer());

  const NOUVEAU = {
    title: 'Kiné',
    description: 'Séance dos',
    location_name: 'Cabinet Pasteur',
    starts_at: '2027-04-10T10:00:00Z',
    ends_at: '2027-04-10T11:00:00Z',
    time_zone: 'Europe/Paris',
  } as const;

  it('POST et GET /api/moi/agenda créent, listent et filtrent par fenêtre', async () => {
    const cree1 = await alice.client.post('/api/moi/agenda', NOUVEAU);
    expect(cree1.statut).toBe(201);
    expect(cree1.corps).toMatchObject({
      title: 'Kiné',
      description: 'Séance dos',
      location_name: 'Cabinet Pasteur',
      all_day: false,
      starts_at: '2027-04-10T10:00:00Z',
      ends_at: '2027-04-10T11:00:00Z',
      time_zone: 'Europe/Paris',
    });
    // Le champ `partages` n'existe plus (ADR-0017) : le réglage est le même pour tous les créneaux.
    expect(cree1.corps).not.toHaveProperty('partages');

    const cree2 = await alice.client.post('/api/moi/agenda', {
      title: 'Vacances',
      all_day: true,
      starts_at: '2027-05-01',
      ends_at: '2027-05-03',
      time_zone: 'Europe/Paris',
    });
    expect(cree2.statut).toBe(201);

    const tout = await alice.client.get('/api/moi/agenda');
    expect(tout.statut).toBe(200);
    expect((tout.corps['creneaux'] as unknown[]).length).toBe(2);

    const fenetre = await alice.client.get('/api/moi/agenda?du=2027-04-01&au=2027-04-30');
    expect(fenetre.statut).toBe(200);
    expect((fenetre.corps['creneaux'] as Array<{ title: string }>).map((c) => c.title)).toEqual(['Kiné']);

    // Bob ne voit pas les créneaux d'Alice dans son propre agenda personnel.
    const agendaBob = await bob.client.get('/api/moi/agenda');
    expect(agendaBob.statut).toBe(200);
    expect(agendaBob.corps['creneaux']).toEqual([]);
  });

  it('POST /api/moi/agenda refuse les entrées invalides en 400', async () => {
    const finAvantDebut = await alice.client.post('/api/moi/agenda', {
      ...NOUVEAU,
      ends_at: '2027-04-10T09:00:00Z',
    });
    expect(finAvantDebut.statut).toBe(400);
    expect(finAvantDebut.corps['error']).toBe('requete.invalide');

    const champInconnu = await alice.client.post('/api/moi/agenda', {
      ...NOUVEAU,
      recurrence_rule: 'FREQ=WEEKLY',
    });
    expect(champInconnu.statut).toBe(400);
    expect(champInconnu.corps['error']).toBe('requete.invalide');
  });

  it('GET /api/moi/agenda/:creneauId lit mon créneau, et renvoie 404 agenda.introuvable à tout autre compte (identifiant forgé)', async () => {
    const cree = await alice.client.post('/api/moi/agenda', NOUVEAU);
    const id = cree.corps['id'] as string;

    const lu = await alice.client.get(`/api/moi/agenda/${id}`);
    expect(lu.statut).toBe(200);
    expect(lu.corps).toMatchObject({ id, title: 'Kiné', all_day: false, calendar_source_id: null });

    // Bob (même groupe) et Erik (autre groupe) forgent l'identifiant d'Alice : même 404 que pour un identifiant inexistant.
    for (const intrus of [bob, erik]) {
      const r = await intrus.client.get(`/api/moi/agenda/${id}`);
      expect(r.statut).toBe(404);
      expect(r.corps['error']).toBe('agenda.introuvable');
    }
    const inconnu = await alice.client.get('/api/moi/agenda/inexistant');
    expect(inconnu.statut).toBe(404);

    // Supprimé : introuvable, même pour son propriétaire.
    await alice.client.delete(`/api/moi/agenda/${id}`);
    expect((await alice.client.get(`/api/moi/agenda/${id}`)).statut).toBe(404);
  });

  it('PATCH et DELETE /api/moi/agenda/:id modifient et suppriment, et renvoient 404 agenda.introuvable pour un autre compte', async () => {
    const cree = await alice.client.post('/api/moi/agenda', NOUVEAU);
    const id = cree.corps['id'] as string;

    const maj = await alice.client.patch(`/api/moi/agenda/${id}`, {
      title: 'Ostéopathe',
      location_name: 'Clinique Sud',
    });
    expect(maj.statut).toBe(200);
    expect(maj.corps).toMatchObject({ id, title: 'Ostéopathe', location_name: 'Clinique Sud' });

    // Refus 400 si la nouvelle fin est antérieure au début existant.
    const majInvalide = await alice.client.patch(`/api/moi/agenda/${id}`, {
      ends_at: '2027-04-10T08:00:00Z',
    });
    expect(majInvalide.statut).toBe(400);

    // Bob (pourtant dans le même groupe) reçoit 404 agenda.introuvable sur PATCH et DELETE.
    const patchBob = await bob.client.patch(`/api/moi/agenda/${id}`, { title: 'Piraté' });
    expect(patchBob.statut).toBe(404);
    expect(patchBob.corps['error']).toBe('agenda.introuvable');

    const delBob = await bob.client.delete(`/api/moi/agenda/${id}`);
    expect(delBob.statut).toBe(404);
    expect(delBob.corps['error']).toBe('agenda.introuvable');

    // Alice peut supprimer son créneau, puis il devient introuvable.
    const delAlice = await alice.client.delete(`/api/moi/agenda/${id}`);
    expect(delAlice.statut).toBe(200);
    expect(delAlice.corps).toEqual({ ok: true });

    const listeApres = await alice.client.get('/api/moi/agenda');
    expect(listeApres.corps['creneaux']).toEqual([]);

    const patchApres = await alice.client.patch(`/api/moi/agenda/${id}`, { title: 'Trop tard' });
    expect(patchApres.statut).toBe(404);
    expect(patchApres.corps['error']).toBe('agenda.introuvable');
  });

  /** Ce que Bob lit dans les disponibilités du groupe, sur la fenêtre d'avril 2027 (et novembre 2026 pour les imports). */
  const disponibilitesVuesParBob = async (du = '2027-04-01', au = '2027-04-30'): Promise<Array<Record<string, unknown>>> => {
    const r = await bob.client.get(`/api/groupes/${g.groupId}/disponibilites?du=${du}&au=${au}`);
    expect(r.statut).toBe(200);
    return r.corps['disponibilites'] as Array<Record<string, unknown>>;
  };

  const regler = async (qui: Personne, visibilite: string): Promise<void> => {
    const r = await qui.client.patch('/api/moi', { personal_agenda_visibility: visibilite });
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    expect(r.corps['personal_agenda_visibility']).toBe(visibilite);
  };

  it('PATCH /api/moi règle la visibilité de l’agenda personnel (défaut busy), GET /api/moi la relit, une valeur inconnue est refusée', async () => {
    expect((await alice.client.get('/api/moi')).corps['personal_agenda_visibility']).toBe('busy');
    await regler(alice, 'none');
    await regler(alice, 'details');
    expect((await alice.client.get('/api/moi')).corps['personal_agenda_visibility']).toBe('details');
    // Le réglage est celui du COMPTE : Bob n'est pas touché.
    expect((await bob.client.get('/api/moi')).corps['personal_agenda_visibility']).toBe('busy');

    for (const corps of [{ personal_agenda_visibility: 'tous' }, { personal_agenda_visibility: null }, { personal_agenda_visibility: 2 }]) {
      const refus = await alice.client.patch('/api/moi', corps);
      expect(refus.statut).toBe(400);
      expect(refus.corps['error']).toBe('requete.invalide');
    }
    expect((await alice.client.get('/api/moi')).corps['personal_agenda_visibility']).toBe('details');
  });

  it('les deux routes d’écriture des partages n’existent plus (ADR-0017)', async () => {
    const cree = await alice.client.post('/api/moi/agenda', NOUVEAU);
    const id = cree.corps['id'] as string;
    expect((await alice.client.put(`/api/moi/agenda/${id}/partages`, { group_id: g.groupId, visibility: 'details' })).statut).toBe(404);
    expect((await alice.client.put(`/api/groupes/${g.groupId}/ma-visibilite`, { visibility: 'details' })).statut).toBe(404);
    // Et rien n'a bougé : le partage reste celui du réglage de compte (busy).
    expect(d.sql.prepare('SELECT visibility FROM personal_event_shares WHERE personal_event_id = ?').pluck().all(id)).toEqual(['busy']);
  });

  it('GET /api/groupes/:groupId/disponibilites suit le réglage de compte : details, busy puis none', async () => {
    await regler(alice, 'details');
    const cree = await alice.client.post('/api/moi/agenda', {
      title: 'Café au soleil',
      description: 'Terrasse ouverte',
      location_name: 'Place Bellecour',
      starts_at: '2027-04-12T15:00:00Z',
      ends_at: '2027-04-12T16:00:00Z',
      time_zone: 'Europe/Paris',
    });
    expect(cree.statut).toBe(201);

    const enDetails = await disponibilitesVuesParBob();
    expect(enDetails).toHaveLength(1);
    expect(enDetails[0]).toMatchObject({
      id: cree.corps['id'],
      membership_id: membreDe(g, alice),
      visibility: 'details',
      title: 'Café au soleil',
      description: 'Terrasse ouverte',
      location_name: 'Place Bellecour',
    });

    // Abaisser le réglage masque le texte tout de suite, sans toucher au créneau.
    await regler(alice, 'busy');
    const enBusy = await disponibilitesVuesParBob();
    expect(enBusy).toHaveLength(1);
    expect(enBusy[0]).toMatchObject({ visibility: 'busy', title: null, description: null, location_name: null });
    const serialise = JSON.stringify(enBusy);
    for (const secret of ['Café', 'Terrasse', 'Bellecour']) expect(serialise).not.toContain(secret);

    await regler(alice, 'none');
    expect(await disponibilitesVuesParBob()).toEqual([]);

    // Un membre d'un autre groupe (Erik) n'a aucun accès aux disponibilités de Famille, quel que soit le réglage : 404, jamais 403.
    await regler(alice, 'details');
    const intrus = await erik.client.get(`/api/groupes/${g.groupId}/disponibilites?du=2027-04-01&au=2027-04-30`);
    expect(intrus.statut).toBe(404);
    expect(JSON.stringify(intrus.corps)).not.toContain('Café');
    expect((await erik.client.get(`/api/groupes/${autre.groupId}/disponibilites?du=2027-04-01&au=2027-04-30`)).corps['disponibilites']).toEqual([]);

    // Alice, elle, voit toujours tout de son propre agenda.
    const agenda = await alice.client.get('/api/moi/agenda');
    expect((agenda.corps['creneaux'] as Array<{ title: string }>).map((c) => c.title)).toEqual(['Café au soleil']);
  });

  it('le réglage de compte s’applique à un créneau créé APRÈS le réglage (aucun appel de réglage entre les deux)', async () => {
    await regler(alice, 'busy');
    const cree = await alice.client.post('/api/moi/agenda', NOUVEAU);
    expect(cree.statut).toBe(201);
    const vu = await disponibilitesVuesParBob();
    expect(vu).toHaveLength(1);
    expect(vu[0]).toMatchObject({ id: cree.corps['id'], visibility: 'busy', title: null, description: null, location_name: null });
    for (const secret of ['Kiné', 'Séance dos', 'Cabinet Pasteur']) expect(JSON.stringify(vu)).not.toContain(secret);

    // Même chose en « rien » : le créneau créé ensuite n'est partagé nulle part.
    await regler(alice, 'none');
    const cache = await alice.client.post('/api/moi/agenda', { ...NOUVEAU, title: 'Secret total', starts_at: '2027-04-12T08:00:00Z', ends_at: '2027-04-12T09:00:00Z' });
    expect(d.sql.prepare('SELECT count(*) FROM personal_event_shares WHERE personal_event_id = ?').pluck().get(cache.corps['id'])).toBe(0);
    // Le réglage « rien » masque aussi le premier créneau, déjà partagé.
    expect(await disponibilitesVuesParBob()).toEqual([]);
  });
});

describe('réglage de visibilité et créneaux importés d’un agenda externe', () => {
  let faux: FauxAgenda;
  let d: Decor;
  let alice: Personne;
  let bob: Personne;
  let g: GroupeAmorce;

  beforeEach(async () => {
    faux = await demarrerFauxAgenda();
    faux.reponse = { statut: 200, corps: ICS_UN_EVENEMENT, entetes: { 'content-type': 'text/calendar' } };
    d = decor({ agendaExterne: faux.dependances, journal: JOURNAL_SILENCIEUX }, { ATTROUPE_ENCRYPTION_KEY: secretFactice() });
    alice = await personne(d, 'alice_imp');
    bob = await personne(d, 'bob_imp');
    g = await groupe(d, 'Famille', [
      { personne: alice, role: 'admin' },
      { personne: bob, role: 'member' },
    ]);
    const creation = await alice.client.post('/api/moi/agenda/sources', { url: faux.url, label: 'Mon agenda' });
    expect(creation.statut, JSON.stringify(creation.corps)).toBe(201);
  });

  afterEach(async () => {
    d.nettoyer();
    await faux.arreter();
  });

  const vuParBob = async (): Promise<Array<Record<string, unknown>>> => {
    const r = await bob.client.get(`/api/groupes/${g.groupId}/disponibilites?du=2026-11-01&au=2026-12-31`);
    expect(r.statut).toBe(200);
    return r.corps['disponibilites'] as Array<Record<string, unknown>>;
  };
  const regler = async (visibilite: string): Promise<void> => {
    expect((await alice.client.patch('/api/moi', { personal_agenda_visibility: visibilite })).statut).toBe(200);
  };
  const partages = (): Array<{ visibility: string; calendar_source_id: string | null }> =>
    d.sql
      .prepare('SELECT s.visibility AS visibility, p.calendar_source_id AS calendar_source_id FROM personal_event_shares AS s JOIN personal_events AS p ON p.id = s.personal_event_id ORDER BY p.calendar_source_id IS NULL, p.starts_at')
      .all() as Array<{ visibility: string; calendar_source_id: string | null }>;

  it('abaisser le réglage masque immédiatement les créneaux déjà importés, sans rien supprimer ; remonter les rend', async () => {
    expect(await vuParBob()).toHaveLength(1); // l'import a partagé en « occupé » (défaut)
    const avant = partages();

    await regler('none');
    expect(await vuParBob()).toEqual([]);
    // Le plafond masque, il ne détruit rien : les lignes de partage sont intactes.
    expect(partages()).toEqual(avant);

    await regler('busy');
    const revu = await vuParBob();
    expect(revu).toHaveLength(1);
    expect(revu[0]).toMatchObject({ visibility: 'busy', title: null, description: null, location_name: null });
    expect(JSON.stringify(revu)).not.toContain('Secret médical');
  });

  it('élargir à details réaligne les créneaux manuels existants, et laisse les importés à occupé', async () => {
    const manuel = await alice.client.post('/api/moi/agenda', {
      title: 'Dîner chez Léa',
      description: 'Apporter le dessert',
      location_name: 'Chez Léa',
      starts_at: '2026-11-25T18:00:00Z',
      ends_at: '2026-11-25T21:00:00Z',
      time_zone: 'Europe/Paris',
    });
    expect(manuel.statut).toBe(201);
    // Avant : tout est en « occupé » (le défaut).
    expect(partages().map((p) => p.visibility)).toEqual(['busy', 'busy']);

    await regler('details');
    expect(partages()).toEqual([
      { visibility: 'busy', calendar_source_id: expect.any(String) },
      { visibility: 'details', calendar_source_id: null },
    ]);

    const vu = await vuParBob();
    expect(vu).toHaveLength(2);
    const importe = vu.find((x) => x['title'] !== 'Dîner chez Léa');
    const saisi = vu.find((x) => x['title'] === 'Dîner chez Léa');
    expect(saisi).toMatchObject({ visibility: 'details', description: 'Apporter le dessert', location_name: 'Chez Léa' });
    // Le créneau importé reste « occupé » : jamais de texte, même avec « les détails ».
    expect(importe).toMatchObject({ visibility: 'busy', description: null, location_name: null });
    expect(JSON.stringify(vu)).not.toContain('Secret médical');
  });

  it('élargir depuis « rien » crée les partages qui manquaient', async () => {
    await regler('none');
    const manuel = await alice.client.post('/api/moi/agenda', {
      title: 'Cinéma',
      starts_at: '2026-11-26T18:00:00Z',
      ends_at: '2026-11-26T20:00:00Z',
      time_zone: 'Europe/Paris',
    });
    expect(d.sql.prepare('SELECT count(*) FROM personal_event_shares WHERE personal_event_id = ?').pluck().get(manuel.corps['id'])).toBe(0);

    await regler('details');
    expect(d.sql.prepare('SELECT visibility FROM personal_event_shares WHERE personal_event_id = ?').pluck().all(manuel.corps['id'])).toEqual(['details']);
    expect((await vuParBob()).some((x) => x['title'] === 'Cinéma' && x['visibility'] === 'details')).toBe(true);
  });
});
