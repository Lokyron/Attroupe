import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diagnostiquer, ErreurRequeteSansGroupe, preparer } from '../../server/db/sql.js';
import type { Decor } from '../fixtures/comptes.js';
import { decor, groupe, personne, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';

// ADR-0017 : le réglage de compte (`users.personal_agenda_visibility`) est un PLAFOND appliqué à la lecture. Ces tests écrivent les lignes de
// partage DIRECTEMENT en base, hors de tout chemin applicatif : ils prouvent que le plafond tient même si une ligne dit « details » (une ligne
// oubliée par le réalignement, un futur chemin d'écriture, une migration). Un test qui ne tomberait pas sans le plafond ne prouverait rien.
describe('agenda personnel : le plafond de compte borne la lecture par les autres membres', () => {
  let d: Decor;
  let alice: Personne;
  let bob: Personne;
  let erik: Personne;
  let famille: GroupeAmorce;
  let voisins: GroupeAmorce;
  let creneauId: string;

  const SECRETS = ['Consultation médicale secrète', 'Détail confidentiel', 'Cabinet du Dr X'];

  /** Ce que `lecteur` voit des disponibilités de `g`. */
  const vue = async (lecteur: Personne, g: GroupeAmorce): Promise<Array<Record<string, unknown>>> => {
    const r = await lecteur.client.get(`/api/groupes/${g.groupId}/disponibilites?du=2027-04-01&au=2027-04-30`);
    expect(r.statut).toBe(200);
    return r.corps['disponibilites'] as Array<Record<string, unknown>>;
  };
  const regler = (valeur: 'none' | 'busy' | 'details'): void => {
    d.sql.prepare('UPDATE users SET personal_agenda_visibility = ? WHERE id = ?').run(valeur, alice.userId);
  };
  /** Force toutes les lignes de partage du créneau à « details », comme le ferait une écriture que le plafond ne connaît pas. */
  const forcerDetails = (): void => {
    d.sql.prepare("UPDATE personal_event_shares SET visibility = 'details' WHERE personal_event_id = ?").run(creneauId);
    expect(d.sql.prepare('SELECT visibility FROM personal_event_shares WHERE personal_event_id = ?').pluck().all(creneauId)).toEqual(['details', 'details']);
  };

  beforeEach(async () => {
    d = decor();
    alice = await personne(d, 'alice_pl');
    bob = await personne(d, 'bob_pl');
    erik = await personne(d, 'erik_pl');
    // Alice est dans deux groupes : Famille (avec Bob) et Voisins (avec Erik, qui n'est PAS dans Famille).
    famille = await groupe(d, 'Famille', [
      { personne: alice, role: 'admin' },
      { personne: bob, role: 'member' },
    ]);
    voisins = await groupe(d, 'Voisins', [
      { personne: alice, role: 'member' },
      { personne: erik, role: 'admin' },
    ]);
    const cree = await alice.client.post('/api/moi/agenda', {
      title: SECRETS[0],
      description: SECRETS[1],
      location_name: SECRETS[2],
      starts_at: '2027-04-10T10:00:00Z',
      ends_at: '2027-04-10T11:00:00Z',
      time_zone: 'Europe/Paris',
    });
    expect(cree.statut).toBe(201);
    creneauId = cree.corps['id'] as string;
  });

  afterEach(() => d.nettoyer());

  it('un membre d’un autre groupe ne voit que « occupé » quand le plafond est à busy, même si la ligne de partage dit details', async () => {
    regler('busy');
    forcerDetails();
    for (const [lecteur, g] of [
      [bob, famille],
      [erik, voisins],
    ] as const) {
      const lu = await vue(lecteur, g);
      expect(lu).toHaveLength(1);
      expect(lu[0]).toMatchObject({ id: creneauId, visibility: 'busy', title: null, description: null, location_name: null });
      const serialise = JSON.stringify(lu);
      for (const secret of SECRETS) expect(serialise).not.toContain(secret);
    }
  });

  it('le plafond none masque un créneau dont la ligne de partage existe', async () => {
    regler('none');
    forcerDetails();
    expect(await vue(bob, famille)).toEqual([]);
    expect(await vue(erik, voisins)).toEqual([]);
    // Le plafond masque, il ne détruit pas : les lignes sont toujours là.
    expect(d.sql.prepare('SELECT count(*) FROM personal_event_shares WHERE personal_event_id = ?').pluck().get(creneauId)).toBe(2);
  });

  it('le plafond details laisse passer le texte, et uniquement lui : un partage busy reste busy', async () => {
    regler('details');
    forcerDetails();
    expect((await vue(bob, famille))[0]).toMatchObject({ visibility: 'details', title: SECRETS[0], description: SECRETS[1], location_name: SECRETS[2] });
    d.sql.prepare("UPDATE personal_event_shares SET visibility = 'busy' WHERE personal_event_id = ?").run(creneauId);
    const lu = await vue(bob, famille);
    expect(lu[0]).toMatchObject({ visibility: 'busy', title: null, description: null, location_name: null });
    for (const secret of SECRETS) expect(JSON.stringify(lu)).not.toContain(secret);
  });

  it('le plafond est celui du PROPRIÉTAIRE du créneau : le réglage d’un lecteur ne change rien à ce qu’il voit', async () => {
    regler('busy');
    forcerDetails();
    // Bob règle SON agenda à details : il ne voit pas pour autant plus de l'agenda d'Alice.
    d.sql.prepare("UPDATE users SET personal_agenda_visibility = 'details' WHERE id = ?").run(bob.userId);
    expect((await vue(bob, famille))[0]).toMatchObject({ visibility: 'busy', title: null });
  });

  it('un identifiant de groupe forgé ne donne rien : Erik ne lit pas les disponibilités de Famille (404)', async () => {
    regler('details');
    forcerDetails();
    const r = await erik.client.get(`/api/groupes/${famille.groupId}/disponibilites?du=2027-04-01&au=2027-04-30`);
    expect(r.statut).toBe(404);
    for (const secret of SECRETS) expect(JSON.stringify(r.corps)).not.toContain(secret);
  });

  it('le réglage de compte se pose sur le compte de la session, jamais sur un autre', async () => {
    const r = await bob.client.patch('/api/moi', { personal_agenda_visibility: 'none' });
    expect(r.statut).toBe(200);
    expect(d.sql.prepare('SELECT personal_agenda_visibility FROM users WHERE id = ?').pluck().get(alice.userId)).toBe('busy');
    expect(d.sql.prepare('SELECT personal_agenda_visibility FROM users WHERE id = ?').pluck().get(bob.userId)).toBe('none');
    // Un identifiant de compte dans le corps est refusé (corps strict).
    const forge = await bob.client.patch('/api/moi', { personal_agenda_visibility: 'none', user_id: alice.userId });
    expect(forge.statut).toBe(400);
  });

  describe('verrou n° 6 : la garde du SQL brut exige le plafond', () => {
    const BASE =
      'SELECT p.starts_at FROM personal_event_shares AS s JOIN personal_events AS p ON s.personal_event_id = p.id ' +
      'JOIN memberships AS m ON m.id = s.membership_id AND m.group_id = s.group_id ';

    it('une lecture de personal_event_shares jointe à personal_events sans filtre de plafond est refusée par la garde', () => {
      const sansPlafond = [
        BASE + 'WHERE s.group_id = ?',
        BASE + 'JOIN users AS u ON u.id = m.user_id WHERE s.group_id = ?',
        'SELECT p.starts_at FROM personal_event_shares AS s JOIN personal_events AS p ON s.personal_event_id = p.id WHERE s.group_id = ?',
      ];
      for (const texte of sansPlafond) {
        expect(diagnostiquer(texte), texte).toMatch(/plafond de compte/);
        expect(() => preparer(d.base, texte)).toThrow(ErreurRequeteSansGroupe);
      }
    });

    it('la même lecture, avec le plafond lié et le rapprochement du compte, est admise et s’exécute', () => {
      const texte = BASE + 'JOIN users AS u ON u.id = m.user_id WHERE s.group_id = ? AND u.personal_agenda_visibility = ? AND s.visibility = ?';
      expect(diagnostiquer(texte)).toBeUndefined();
      expect(preparer(d.base, texte).all(famille.groupId, 'busy', 'busy')).toHaveLength(1);
    });

    it('un plafond qui ne filtre pas vraiment est refusé : littéral, fonction, jointure externe, mauvaise table, sans rapprochement', () => {
      const compte = 'JOIN users AS u ON u.id = m.user_id ';
      const faux = [
        BASE + compte + "WHERE s.group_id = ? AND u.personal_agenda_visibility = 'details'",
        BASE + compte + "WHERE s.group_id = ? AND COALESCE(u.personal_agenda_visibility, 'busy') = ?",
        BASE + 'LEFT JOIN users AS u ON u.id = m.user_id WHERE s.group_id = ? AND u.personal_agenda_visibility = ?',
        BASE + compte + 'WHERE s.group_id = ? AND m.personal_agenda_visibility = ?',
        BASE + 'JOIN users AS u ON u.id = ? WHERE s.group_id = ? AND u.personal_agenda_visibility = ?',
      ];
      for (const texte of faux) expect(diagnostiquer(texte), texte).toBeTypeOf('string');
    });

    it('les lectures légitimes d’une seule des deux tables ne sont pas entravées', () => {
      expect(diagnostiquer('SELECT * FROM personal_events WHERE user_id = ? AND deleted_at IS NULL')).toBeUndefined();
      expect(diagnostiquer('SELECT s.personal_event_id FROM personal_event_shares AS s WHERE s.group_id = ?')).toBeUndefined();
    });

    it('users.personal_agenda_visibility existe, avec le défaut busy et son CHECK : la garde en dépend par son nom', () => {
      const colonne = d.sql.prepare("SELECT type, \"notnull\" AS obligatoire, dflt_value FROM pragma_table_info('users') WHERE name = 'personal_agenda_visibility'").get();
      expect(colonne).toEqual({ type: 'TEXT', obligatoire: 1, dflt_value: "'busy'" });
      expect(() => d.sql.prepare("UPDATE users SET personal_agenda_visibility = 'tous' WHERE id = ?").run(alice.userId)).toThrow(/CHECK/);
    });
  });
});
