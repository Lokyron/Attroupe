import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { courses, type Courses } from '../fixtures/courses.js';

// CONCURRENCE RÉELLE (architecture §10, point n° 6 : « cases cochées en rafale par huit personnes dans un magasin, à éprouver au lot 6 »).
//
// Deux niveaux, parce qu'un seul ne prouve pas tout :
//  1. des requêtes HTTP simultanées sur UNE application (le cas de production : un processus, des dizaines de requêtes en vol) ;
//  2. de VRAIS processus, chacun avec sa connexion SQLite au même fichier, qui écrivent ensemble sur la même liste. C'est le seul test qui
//     exerce le verrou d'écriture de SQLite (SQLITE_BUSY, `busy_timeout`) : dans un processus unique, better-sqlite3 est synchrone et les
//     écritures se font à la queue leu leu, quoi qu'on lance en parallèle côté Node.
// Dans les deux cas : aucune écriture perdue, aucune erreur, jamais deux preneurs, état final cohérent.

const RACINE = join(import.meta.dirname, '..', '..', '..');
const SCRIPT = join(import.meta.dirname, '..', 'fixtures', 'ecrire-courses.ts');

interface Sortie {
  readonly code: number | null;
  readonly sortie: string;
  readonly erreurLue: string;
}
interface Bilan {
  readonly gagnes: string[];
  readonly perdus: string[];
  readonly ajoutes: string[];
  readonly deplaces: number;
  readonly erreurs: string[];
}

/** Lance les processus, attend que TOUS aient annoncé « pret », puis les lâche ensemble (« go » sur leur entrée). */
async function lancerEnsemble(tous: ReadonlyArray<readonly string[]>): Promise<Sortie[]> {
  let prets = 0;
  let toutsPrets: () => void = () => undefined;
  const attente = new Promise<void>((ok) => (toutsPrets = ok));
  const enfants = tous.map((args) => {
    const enfant = spawn(process.execPath, ['--import', 'tsx', SCRIPT, ...args], { cwd: RACINE });
    let sortie = '';
    let erreurLue = '';
    let annonce = false;
    enfant.stdout.on('data', (morceau: Buffer) => {
      sortie += morceau.toString();
      if (!annonce && sortie.includes('pret\n')) {
        annonce = true;
        prets += 1;
        if (prets === tous.length) toutsPrets();
      }
    });
    enfant.stderr.on('data', (morceau: Buffer) => (erreurLue += morceau.toString()));
    const fin = new Promise<Sortie>((resolu) =>
      enfant.on('close', (code) => resolu({ code, sortie: sortie.replace('pret\n', '').trim(), erreurLue: erreurLue.trim() })),
    );
    return { enfant, fin };
  });
  // Un processus qui meurt avant d'être prêt ferait attendre pour toujours : on lâche alors tout le monde, et ses codes de sortie le diront.
  const mort = Promise.race(enfants.map(({ fin }) => fin)).then(() => undefined);
  await Promise.race([attente, mort]);
  for (const { enfant } of enfants) enfant.stdin.write('go\n');
  return Promise.all(enfants.map(({ fin }) => fin));
}

describe('listes : écritures concurrentes', () => {
  let c: Courses;
  beforeEach(async () => {
    c = await courses('co');
  });
  afterEach(() => c.d.nettoyer());

  const preneurs = (listeId: string): Map<string, string | null> =>
    new Map((c.d.sql.prepare('SELECT id, claimed_by_membership_id AS pris FROM shopping_items WHERE shopping_list_id = ?').all(listeId) as Array<{ id: string; pris: string | null }>).map((l) => [l.id, l.pris]));

  it('HTTP : huit comptes cochent et prennent en même temps — aucune perte, aucune erreur, un seul preneur par article', async () => {
    // Huit membres : les trois du décor, plus cinq inscrits au groupe.
    const { personne } = await import('../fixtures/groupes.js');
    const supplementaires = [];
    for (let i = 0; i < 5; i++) {
      const p = await personne(c.d, `renfort${String(i)}_co`);
      const invitation = await c.alice.client.post(c.chemin('/invitations'), { username: p.username, role: 'member' });
      expect(invitation.statut).toBe(202);
      const recue = ((await p.client.get('/api/moi/invitations')).corps['invitations'] as Array<{ id: string }>)[0];
      expect((await p.client.post(`/api/moi/invitations/${recue?.id ?? ''}/acceptation`)).statut).toBe(200);
      supplementaires.push(p);
    }
    const equipe = [c.alice, c.carole, c.erin, ...supplementaires];
    expect(equipe).toHaveLength(8);

    const liste = await c.creerListe(c.alice, 'Courses du magasin');
    const ids = await c.ajouter(c.alice, liste, ...Array.from({ length: 12 }, (_v, i) => `Article ${String(i)}`));

    // Chaque article est disputé par les huit (192 « je le prends ») ET coché par tous (192 cases), en une seule rafale.
    const rafale = ids.flatMap((id) =>
      equipe.flatMap((p) => [
        p.client.put(c.chemin(`/listes/${liste}/articles/${id}/preneur`), { prend: true }),
        p.client.put(c.chemin(`/listes/${liste}/articles/${id}/fait`), { fait: true }),
      ]),
    );
    const reponses = await Promise.all(rafale);

    const statuts = reponses.map((r) => r.statut);
    expect(statuts.filter((s) => s >= 500), 'aucune erreur serveur (SQLITE_BUSY comprise)').toEqual([]);
    expect(new Set(statuts.filter((s) => s !== 200 && s !== 409))).toEqual(new Set());
    // Prises : exactement une victoire par article, sept défaites qui NOMMENT le gagnant.
    const prises = reponses.filter((_r, i) => i % 2 === 0);
    expect(prises.filter((r) => r.statut === 200)).toHaveLength(ids.length);
    expect(prises.filter((r) => r.statut === 409)).toHaveLength(ids.length * 7);
    for (const r of prises.filter((x) => x.statut === 409)) expect(r.corps).toMatchObject({ error: 'article.deja_pris', pris_par: { membership_id: expect.any(String) as string } });
    // Cases : toutes passent (idempotent), aucune ne casse l'invariant.
    expect(reponses.filter((_r, i) => i % 2 === 1).map((r) => r.statut)).toEqual(Array(ids.length * 8).fill(200));

    // État final : chaque article a UN preneur, celui que la base désigne est celui à qui l'on a répondu 200, tout est coché, rien n'est perdu.
    const etat = (await c.alice.client.get(c.chemin(`/listes/${liste}`))).corps['articles'] as Array<Record<string, unknown>>;
    expect(etat).toHaveLength(12);
    for (const a of etat) {
      expect(a['claimed_by_membership_id'], `article ${String(a['label'])} sans preneur`).toEqual(expect.any(String));
      expect(a).toMatchObject({ is_done: true });
      expect(a['done_at']).toEqual(expect.any(String));
    }
    const gagnants = new Map(ids.map((id, i) => [id, equipe.filter((_p, k) => prises[i * 8 + k]?.statut === 200)]));
    for (const [id, gagnant] of gagnants) {
      expect(gagnant, `article ${id} : un seul gagnant`).toHaveLength(1);
      expect(preneurs(liste).get(id)).toBe(c.membreA(gagnant[0] ?? c.alice));
    }
  }, 60_000);

  it('HTTP : « je le prends » et « finalement non » en rafale ne laissent jamais deux preneurs ni un état incohérent', async () => {
    const liste = await c.creerListe(c.alice);
    const [pain] = await c.ajouter(c.alice, liste, 'Pain');
    const chemin = c.chemin(`/listes/${liste}/articles/${pain ?? ''}/preneur`);
    for (let tour = 0; tour < 10; tour++) {
      const reponses = await Promise.all(
        [c.alice, c.carole, c.erin].flatMap((p) => [p.client.put(chemin, { prend: true }), p.client.put(chemin, { prend: false })]),
      );
      expect(reponses.filter((r) => r.statut >= 500)).toEqual([]);
      const ligne = c.d.sql.prepare('SELECT claimed_by_membership_id AS pris, claimed_at AS quand FROM shopping_items WHERE id = ?').get(pain) as { pris: string | null; quand: string | null };
      expect(ligne.pris === null, `tour ${String(tour)} : preneur et date vont ensemble`).toBe(ligne.quand === null);
      c.d.sql.prepare('UPDATE shopping_items SET claimed_by_membership_id = NULL, claimed_at = NULL WHERE id = ?').run(pain);
    }
  });

  it('PROCESSUS : quatre processus écrivent ensemble sur le même fichier — jamais deux preneurs, aucune écriture perdue, aucun SQLITE_BUSY', async () => {
    const liste = await c.creerListe(c.alice);
    const ids = await c.ajouter(c.alice, liste, ...Array.from({ length: 16 }, (_v, i) => `Article ${String(i)}`));
    const equipe = [c.alice, c.carole, c.erin, c.alice]; // Alice joue deux processus : deux sessions du même compte
    const ajouts = 6;
    // Départ simultané garanti : tous les processus sont prêts (tsx chargé, base ouverte) avant que le premier ne reçoive « go ».
    const sorties = await lancerEnsemble(equipe.map((p) => [c.d.chemin, p.userId, c.a.groupId, liste, String(ajouts), ids.join(',')]));

    for (const s of sorties) expect({ code: s.code, erreur: s.erreurLue }, s.sortie).toEqual({ code: 0, erreur: '' });
    const bilans = sorties.map((s) => JSON.parse(s.sortie) as Bilan);
    expect(bilans.flatMap((b) => b.erreurs), 'aucune erreur (SQLITE_BUSY, SQLITE_BUSY_SNAPSHOT…) dans aucun processus').toEqual([]);

    // Un seul gagnant par article, parmi les processus ; tout article a été pris ; les perdants l'ont su (409).
    // (Alice, deux processus, est deux fois le même preneur : « déjà à moi » compte pour un succès sans changement, jamais une victoire de plus.)
    const gagnes = bilans.flatMap((b) => b.gagnes);
    expect(new Set(gagnes).size, 'un article gagné par deux processus').toBe(gagnes.length);
    expect([...gagnes].sort()).toEqual([...ids].sort());
    for (const id of ids) expect(preneurs(liste).get(id), `article ${id} sans preneur`).toEqual(expect.any(String));

    // Aucun ajout perdu : seize d'origine + 4 processus × 6 ajouts ; les articles ajoutés sont tous là, déplacés en tête.
    const attendus = ids.length + equipe.length * ajouts;
    const etat = c.d.sql.prepare('SELECT id, position, is_done, done_at FROM shopping_items WHERE shopping_list_id = ? AND deleted_at IS NULL').all(liste) as Array<{ id: string; position: number; is_done: number; done_at: string | null }>;
    expect(etat).toHaveLength(attendus);
    const ajoutes = bilans.flatMap((b) => b.ajoutes);
    expect(ajoutes).toHaveLength(equipe.length * ajouts);
    for (const id of ajoutes) expect(etat.some((l) => l.id === id), `ajout ${id} perdu`).toBe(true);
    expect(bilans.reduce((n, b) => n + b.deplaces, 0)).toBe(equipe.length * ajouts);
    // Les articles d'origine sont cochés (par leur gagnant) ; l'invariant `(is_done = 1) = (done_at IS NOT NULL)` tient partout.
    for (const l of etat) expect(l.is_done === 1, `article ${l.id}`).toBe(l.done_at !== null);
    expect(etat.filter((l) => ids.includes(l.id)).every((l) => l.is_done === 1)).toBe(true);

    // L'ordre est déterministe (position puis identifiant) et lisible par l'API : aucun article n'a disparu de la vue.
    const vue = (await c.alice.client.get(c.chemin(`/listes/${liste}`))).corps['articles'] as Array<{ id: string }>;
    expect(vue).toHaveLength(attendus);
    expect(new Set(vue.map((a) => a.id)).size).toBe(attendus);
  }, 90_000);
});
