import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { empreinteJeton } from '../../server/domain/jetons.js';
import { JOUR_MS } from '../../server/domain/instant.js';
import fr from '../../server/i18n/fr.json' with { type: 'json' };
import type { Decor } from '../fixtures/comptes.js';
import { decor, groupe, personne, type GroupeAmorce, type Personne } from '../fixtures/groupes.js';

// Invitations ÉMISES par un groupe (lot 3) : par e-mail (jeton armé à l'envoi) et par nom d'utilisateur exact.
describe('invitations émises', () => {
  let d: Decor;
  let alice: Personne; // administratrice
  let bob: Personne; // membre
  let g: GroupeAmorce;
  beforeEach(async () => {
    d = decor();
    alice = await personne(d, 'alice_m');
    bob = await personne(d, 'bob_m');
    g = await groupe(d, 'Les potes', [
      { personne: alice, role: 'admin' },
      { personne: bob, role: 'member' },
    ]);
  });
  afterEach(() => d.nettoyer());

  const inviter = (p: Personne, corps: unknown): ReturnType<Personne['client']['post']> => p.client.post(`/api/groupes/${g.groupId}/invitations`, corps);
  const lignes = (): Array<{ id: string; kind: string; email: string | null; target_user_id: string | null; status: string; token_hash: string | null; role: string }> =>
    d.sql.prepare('SELECT id, kind, email, target_user_id, status, token_hash, role FROM invitations WHERE group_id = ? AND status <> \'accepted\' ORDER BY created_at, id').all(g.groupId) as never;

  describe('par e-mail', () => {
    it('crée une invitation inerte, met l’e-mail en file sans jeton, puis arme le jeton à l’envoi', async () => {
      const r = await inviter(alice, { email: 'Victime@Exemple.test', message: 'Viens !' });
      expect(r.statut).toBe(202);
      expect(r.corps).toEqual({ ok: true });
      const [ligne] = lignes();
      expect(ligne).toMatchObject({ kind: 'email', email: 'victime@exemple.test', status: 'pending', token_hash: null, role: 'member' });
      // Dans la file : l'identifiant de la ligne, jamais de jeton.
      const [mail] = d.mails('victime@exemple.test');
      expect(mail?.template_key).toBe('invitation_groupe');
      expect(mail?.payload_json).not.toMatch(/[A-Za-z0-9_-]{43}/);
      expect(JSON.parse(mail?.payload_json ?? '{}')).toMatchObject({ jeton_id: ligne?.id, groupe_id: g.groupId, groupe: 'Les potes' });

      await d.remettre();
      const message = d.envoyes.find((m) => m.to === 'victime@exemple.test');
      // Espace fine insécable U+202F à l'intérieur des guillemets, comme tout le fichier de textes
      // serveur. Écrite en échappement pour qu'une espace ASCII ne puisse pas s'y glisser à la relecture.
      expect(message?.sujet).toBe('Invitation \u00e0 rejoindre \u00ab\u202fLes potes\u202f\u00bb');
      expect(message?.texte).toContain('alice_m vous invite');
      expect(message?.texte).toContain('Viens !');
      const jeton = /\/invitation#jeton=([A-Za-z0-9_-]{43})/.exec(message?.texte ?? '')?.[1];
      expect(jeton).toBeDefined();
      // La base ne garde que l'empreinte, et l'échéance (14 jours) part de l'ENVOI.
      const arme = d.sql.prepare('SELECT token_hash, expires_at FROM invitations WHERE id = ?').get(ligne?.id) as { token_hash: string; expires_at: string };
      expect(arme.token_hash).toBe(empreinteJeton(jeton ?? ''));
      expect(arme.expires_at).toBe(new Date(d.temps.maintenant().getTime() + 14 * JOUR_MS).toISOString().replace(/\.\d{3}Z$/, 'Z'));
    });

    it('révoquer avant l’envoi : le lien ne part pas', async () => {
      await inviter(alice, { email: 'victime@exemple.test' });
      const id = lignes()[0]?.id ?? '';
      expect((await alice.client.delete(`/api/groupes/${g.groupId}/invitations/${id}`)).statut).toBe(200);
      await d.remettre();
      expect(d.envoyes.filter((m) => m.to === 'victime@exemple.test')).toEqual([]);
      expect(d.mails('victime@exemple.test')[0]?.status).toBe('failed');
      expect(lignes()[0]?.token_hash).toBeNull();
    });

    it('une seule invitation en attente par adresse et par groupe, même casse différente', async () => {
      await inviter(alice, { email: 'victime@exemple.test' });
      expect((await inviter(alice, { email: 'VICTIME@exemple.test' })).statut).toBe(202);
      expect(lignes()).toHaveLength(1);
      expect(d.mails('victime@exemple.test')).toHaveLength(1);
    });

    it('une invitation périmée libère l’adresse : on peut réinviter', async () => {
      await inviter(alice, { email: 'victime@exemple.test' });
      d.temps.avancer(15 * JOUR_MS);
      await inviter(alice, { email: 'victime@exemple.test' });
      expect(lignes().map((l) => l.status)).toEqual(['expired', 'pending']);
    });

    it('refuse une adresse invalide, un champ inconnu, et les deux voies à la fois', async () => {
      expect((await inviter(alice, { email: 'pas-une-adresse' })).statut).toBe(400);
      expect((await inviter(alice, { email: 'a@exemple.test', group_id: 'autre' })).statut).toBe(400);
      expect((await inviter(alice, { email: 'a@exemple.test', username: 'bob_m' })).statut).toBe(400);
      expect((await inviter(alice, {})).statut).toBe(400);
      expect(lignes()).toEqual([]);
    });

    it('cadence : une même adresse ne se voit pas inonder, d’où qu’on l’invite', async () => {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        d.temps.avancer(1000);
        codes.push((await inviter(alice, { email: 'victime@exemple.test' })).statut);
      }
      expect(codes).toEqual([202, 202, 202, 429]);
    });

    it('cadence : épuiser le couple (adresse, groupe) ne rend pas l’adresse « non invitable » par un autre groupe', async () => {
      for (let i = 0; i < 4; i++) {
        d.temps.avancer(1000);
        await inviter(alice, { email: 'victime@exemple.test' });
      }
      const frank = await personne(d, 'frank_m');
      const autre = await groupe(d, 'Un autre groupe', [{ personne: frank, role: 'admin' }]);
      const r = await frank.client.post(`/api/groupes/${autre.groupId}/invitations`, { email: 'victime@exemple.test' });
      expect(r.statut).toBe(202);
      expect(d.sql.prepare('SELECT count(*) FROM invitations WHERE group_id = ?').pluck().get(autre.groupId)).toBe(1);
    });
  });

  describe('par nom d’utilisateur exact', () => {
    it('crée une invitation À ACCEPTER, jamais une appartenance', async () => {
      const carole = await personne(d, 'Carole_M');
      const r = await inviter(alice, { username: 'carole_m', role: 'admin', message: 'Bienvenue' });
      expect(r.statut).toBe(202);
      expect(r.corps).toEqual({ ok: true });
      expect(lignes()).toEqual([expect.objectContaining({ kind: 'existing_user', target_user_id: carole.userId, status: 'pending', role: 'admin', token_hash: null })]);
      expect(d.sql.prepare('SELECT count(*) FROM memberships WHERE user_id = ?').pluck().get(carole.userId)).toBe(0);
      // Pas d'e-mail pour cette voie : l'invitation s'accepte depuis l'application connectée.
      expect(d.mails(carole.email)).toHaveLength(1); // seulement l'e-mail de vérification d'adresse
    });

    it('aucune recherche partielle : ni préfixe, ni sous-chaîne, ni joker', async () => {
      await personne(d, 'carole_m');
      // Les noms hors de la forme d'un nom d'utilisateur sont refusés (400) ; les autres sont acceptés SANS rien créer (202).
      for (const nom of ['carol', 'arole_m', 'car', 'carole_', '_____m', 'carole%', '%', 'c*']) {
        const attendu = /^[A-Za-z0-9_.-]{3,32}$/.test(nom) ? 202 : 400;
        expect((await inviter(alice, { username: nom })).statut).toBe(attendu);
      }
      expect(lignes()).toEqual([]);
    });

    it('la réponse ne dit pas si le nom existe', async () => {
      await personne(d, 'carole_m');
      const connu = await inviter(alice, { username: 'carole_m' });
      const inconnu = await inviter(alice, { username: 'fantome_x' });
      expect({ statut: inconnu.statut, corps: inconnu.corps }).toEqual({ statut: connu.statut, corps: connu.corps });
      expect(lignes()).toHaveLength(1);
    });

    it('déjà membre, déjà invité, soi-même : sans effet', async () => {
      await personne(d, 'carole_m');
      await inviter(alice, { username: 'bob_m' });
      await inviter(alice, { username: 'alice_m' });
      await inviter(alice, { username: 'carole_m' });
      await inviter(alice, { username: 'carole_m' });
      expect(lignes()).toHaveLength(1);
    });

    it('cadence : un même nom ne se voit pas inonder depuis un groupe, mais reste invitable par un autre', async () => {
      await personne(d, 'carole_m');
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        d.temps.avancer(1000);
        codes.push((await inviter(alice, { username: 'carole_m' })).statut);
      }
      expect(codes).toEqual([202, 202, 202, 429]);
      const frank = await personne(d, 'frank_m');
      const autre = await groupe(d, 'Un autre groupe', [{ personne: frank, role: 'admin' }]);
      expect((await frank.client.post(`/api/groupes/${autre.groupId}/invitations`, { username: 'CAROLE_M' })).statut).toBe(202);
    });

    it('un compte désactivé n’est pas invitable', async () => {
      const carole = await personne(d, 'carole_m');
      d.sql.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run('2026-11-15T12:00:00Z', carole.userId);
      await inviter(alice, { username: 'carole_m' });
      expect(lignes()).toEqual([]);
    });
  });

  describe('liste et révocation', () => {
    it('réservées aux administrateurs (403 pour un membre) et sans jeton, même haché', async () => {
      await personne(d, 'carole_m');
      await inviter(alice, { email: 'victime@exemple.test' });
      await inviter(alice, { username: 'carole_m' });
      await d.remettre();
      expect((await bob.client.get(`/api/groupes/${g.groupId}/invitations`)).statut).toBe(403);
      expect((await inviter(bob, { email: 'x@exemple.test' })).statut).toBe(403);
      const r = await alice.client.get(`/api/groupes/${g.groupId}/invitations`);
      expect(r.statut).toBe(200);
      const liste = (r.corps['invitations'] as Array<Record<string, unknown>>).filter((i) => i['status'] === 'pending');
      expect(liste.map((i) => i['kind']).sort()).toEqual(['email', 'existing_user']);
      expect(liste.find((i) => i['kind'] === 'existing_user')).toMatchObject({ username: 'carole_m', status: 'pending', invited_by_name: 'alice_m' });
      expect(JSON.stringify(r.corps)).not.toContain('token');
      expect(JSON.stringify(r.corps)).not.toMatch(/[0-9a-f]{64}/);
    });

    it('révoque une invitation en attente, une seule fois', async () => {
      await inviter(alice, { email: 'victime@exemple.test' });
      const id = lignes()[0]?.id ?? '';
      expect((await bob.client.delete(`/api/groupes/${g.groupId}/invitations/${id}`)).statut).toBe(403);
      expect((await alice.client.delete(`/api/groupes/${g.groupId}/invitations/${id}`)).statut).toBe(200);
      expect(lignes()[0]?.status).toBe('revoked');
      const encore = await alice.client.delete(`/api/groupes/${g.groupId}/invitations/${id}`);
      expect(encore.statut).toBe(409);
      expect(encore.corps).toEqual({ error: 'invitation.non_en_attente' });
      expect((await alice.client.delete(`/api/groupes/${g.groupId}/invitations/inconnue`)).statut).toBe(404);
    });

    it('le gabarit d’e-mail existe dans fr.json', () => {
      expect(fr.emails.invitation_groupe.texte).toContain('{lien}');
    });
  });
});
