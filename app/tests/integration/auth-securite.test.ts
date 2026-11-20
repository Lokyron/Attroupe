import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MINUTE_MS } from '../../server/domain/instant.js';
import { creerJournal } from '../../server/http/middleware/journal.js';
import { LimiteurCadence, REGLES_PAR_DEFAUT, type ReglesCadence } from '../../server/services/cadence.js';
import { decor, inscrireEtConnecter, MOT_DE_PASSE, type Client, type Decor, type Reponse } from '../fixtures/comptes.js';

const FENETRE = 15 * MINUTE_MS;
const sansBruit = (r: Reponse): unknown => ({ statut: r.statut, corps: r.corps, cookies: r.cookies, retryAfter: r.entetes['retry-after'] });

describe('CSRF : en-tête Origin vérifié sur toute requête qui modifie', () => {
  let d: Decor;
  beforeEach(() => {
    d = decor();
  });
  afterEach(() => d.nettoyer());

  it('refuse un POST sans Origin, avec une origine étrangère ou « null » : rien n’est écrit', async () => {
    const c = d.client();
    const corps = { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE };
    expect((await c.post('/api/auth/inscription', corps, { origine: null })).corps).toEqual({ error: 'csrf.origine_absente' });
    expect((await c.post('/api/auth/inscription', corps, { origine: 'https://pirate.test' })).corps).toEqual({ error: 'csrf.origine_refusee' });
    expect((await c.post('/api/auth/inscription', corps, { origine: 'null' })).statut).toBe(403);
    expect((await c.post('/api/auth/inscription', corps, { origine: 'http://attroupe.test' })).statut).toBe(403); // même hôte, autre schéma
    expect((await c.post('/api/auth/inscription', corps, { origine: 'https://attroupe.test.pirate.test' })).statut).toBe(403);
    expect(d.sql.prepare('SELECT count(*) FROM users').pluck().get()).toBe(0);
    expect((await c.post('/api/auth/inscription', corps)).statut).toBe(202); // avec la bonne origine : accepté
    expect(d.sql.prepare('SELECT count(*) FROM users').pluck().get()).toBe(1);
  });

  it('protège aussi les routes de session : une révocation sans Origin n’a aucun effet', async () => {
    const alice = await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m');
    const telephone = d.client('198.51.100.9');
    await telephone.post('/api/auth/connexion', { email: 'alice@exemple.test', password: MOT_DE_PASSE });
    expect((await alice.delete('/api/moi/sessions', { origine: 'https://pirate.test' })).statut).toBe(403);
    expect((await alice.patch('/api/moi', { display_name: 'Pirate' }, { origine: null })).statut).toBe(403);
    expect((await alice.post('/api/auth/deconnexion', {}, { origine: 'https://pirate.test' })).statut).toBe(403);
    expect((await telephone.get('/api/moi')).statut).toBe(200);
    expect((await alice.get('/api/moi')).corps['display_name']).toBe('alice_m');
  });

  it('laisse passer les lectures sans Origin', async () => {
    const alice = await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m');
    expect((await alice.get('/api/moi', { origine: null })).statut).toBe(200);
  });

  it('un corps mal formé donne 400 sans répéter le corps (qui contient un mot de passe)', async () => {
    const r = await d.client().envoyer('post', '/api/auth/connexion', '{"email":"a@b.test","password":"SECRET-à-ne-pas-répéter"');
    expect(r.statut).toBe(400);
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
});

describe('pas d’énumération de comptes', () => {
  let d: Decor;
  beforeEach(() => {
    d = decor();
  });
  afterEach(() => d.nettoyer());

  it('inscription : adresse nouvelle ou déjà inscrite, même réponse ; le propriétaire est prévenu par e-mail', async () => {
    const nouvelle = await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    const existante = await d.client().post('/api/auth/inscription', { email: 'ALICE@exemple.test', username: 'pirate', password: MOT_DE_PASSE });
    expect(sansBruit(existante)).toEqual(sansBruit(nouvelle));
    expect(d.sql.prepare('SELECT count(*) FROM users').pluck().get()).toBe(1); // aucun second compte
    expect(d.mails('alice@exemple.test').map((m) => m.template_key)).toEqual(['verification_email', 'compte_existant']);
  });

  it('connexion : adresse inconnue, mauvais mot de passe, compte suspendu — même statut, même corps', async () => {
    await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m');
    await inscrireEtConnecter(d, 'bob@exemple.test', 'bob_m');
    d.sql.prepare("UPDATE users SET disabled_at = '2026-11-15T12:00:00Z' WHERE username = 'bob_m'").run();
    const c = d.client();
    const inconnue = await c.post('/api/auth/connexion', { email: 'personne@exemple.test', password: MOT_DE_PASSE });
    const mauvais = await c.post('/api/auth/connexion', { email: 'alice@exemple.test', password: 'mauvais-mot-de-passe-1' });
    const suspendu = await c.post('/api/auth/connexion', { email: 'bob@exemple.test', password: MOT_DE_PASSE });
    expect(inconnue.statut).toBe(401);
    expect(sansBruit(mauvais)).toEqual(sansBruit(inconnue));
    expect(sansBruit(suspendu)).toEqual(sansBruit(inconnue));
  });

  it('mot de passe oublié : adresse connue ou inconnue, même réponse ; seule la connue reçoit un e-mail', async () => {
    await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m');
    const c = d.client();
    const connue = await c.post('/api/auth/mot-de-passe/oubli', { email: 'alice@exemple.test' });
    const inconnue = await c.post('/api/auth/mot-de-passe/oubli', { email: 'personne@exemple.test' });
    expect(connue.statut).toBe(202);
    expect(sansBruit(inconnue)).toEqual(sansBruit(connue));
    expect(d.mails('alice@exemple.test').map((m) => m.template_key)).toContain('reinitialisation_mot_de_passe');
    expect(d.mails('personne@exemple.test')).toEqual([]);
  });

  it('jeton de réinitialisation inconnu, expiré ou déjà utilisé : même réponse', async () => {
    const c = d.client();
    const r = await c.post('/api/auth/mot-de-passe/reinitialisation', { token: 'A'.repeat(43), password: MOT_DE_PASSE });
    expect(r.statut).toBe(400);
    expect(r.corps).toEqual({ error: 'jeton.invalide' });
  });

  /**
   * Médianes de `n` mesures (ms) de deux actions MESURÉES EN ALTERNANCE : une dérive de la machine (autres tests
   * en parallèle, ramasse-miettes, montée en fréquence) touche les deux séries de la même façon.
   */
  async function medianesAlternees(n: number, a: () => Promise<unknown>, b: () => Promise<unknown>): Promise<[number, number]> {
    const duree = async (action: () => Promise<unknown>): Promise<number> => {
      const debut = performance.now();
      await action();
      return performance.now() - debut;
    };
    const [da, db]: [number[], number[]] = [[], []];
    for (let i = 0; i < n; i++) {
      da.push(await duree(a));
      db.push(await duree(b));
    }
    const mediane = (v: number[]): number => v.sort((x, y) => x - y)[Math.floor(v.length / 2)] ?? 0;
    return [mediane(da), mediane(db)];
  }

  // Ces deux tests font chacun 30 requêtes scrypt à N=2^14. Avec 27 workers vitest en parallèle, la
  // contention CPU les fait dépasser le délai par défaut de 5 s AVANT même qu'ils assertent : ils
  // n'échouaient donc pas sur un écart de durée mesuré, mais sur le délai. Allonger le délai ne
  // relâche rien de ce qu'ils vérifient — l'assertion porte sur l'écart ENTRE les deux cas, pas sur
  // une durée absolue — et évite de les classer à tort comme instables.
  it('connexion : la durée ne trahit pas l’existence de l’adresse (mot de passe vérifié contre un leurre)', { timeout: 60_000 }, async () => {
    d.nettoyer();
    // Coût de hachage sensible (~50 ms) pour que l'écart « vérifié / non vérifié » dépasse largement le bruit.
    d = decor({ parametresScrypt: { N: 2 ** 14, r: 8, p: 1 }, regles: grandesLimites() });
    await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m');
    const c = d.client();
    const [connue, inconnue] = await medianesAlternees(
      15,
      () => c.post('/api/auth/connexion', { email: 'alice@exemple.test', password: 'mauvais-mot-de-passe-1' }),
      () => c.post('/api/auth/connexion', { email: 'personne@exemple.test', password: 'mauvais-mot-de-passe-1' }),
    );
    expect(connue).toBeGreaterThan(15); // le hachage a bien lieu dans les deux cas
    expect(inconnue).toBeGreaterThan(15);
    expect(Math.abs(connue - inconnue)).toBeLessThan(Math.max(connue, inconnue) * 0.5);
  });

  // Ces deux tests font chacun 30 requêtes scrypt à N=2^14. Avec 27 workers vitest en parallèle, la
  // contention CPU les fait dépasser le délai par défaut de 5 s AVANT même qu'ils assertent : ils
  // n'échouaient donc pas sur un écart de durée mesuré, mais sur le délai. Allonger le délai ne
  // relâche rien de ce qu'ils vérifient — l'assertion porte sur l'écart ENTRE les deux cas, pas sur
  // une durée absolue — et évite de les classer à tort comme instables.
  it('inscription : la durée ne trahit pas l’existence de l’adresse (mot de passe haché dans les deux cas)', { timeout: 60_000 }, async () => {
    d.nettoyer();
    d = decor({ parametresScrypt: { N: 2 ** 14, r: 8, p: 1 }, regles: grandesLimites() });
    await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    const c = d.client();
    let i = 0;
    const [existante, nouvelle] = await medianesAlternees(
      15,
      () => c.post('/api/auth/inscription', { email: 'alice@exemple.test', username: `pirate${String(i++)}`, password: MOT_DE_PASSE }),
      () => c.post('/api/auth/inscription', { email: `n${String(i)}@exemple.test`, username: `nouveau${String(i++)}`, password: MOT_DE_PASSE }),
    );
    expect(existante).toBeGreaterThan(15);
    expect(Math.abs(existante - nouvelle)).toBeLessThan(Math.max(existante, nouvelle) * 0.5);
  });

  it('mot de passe oublié : durée minimale fixe, donc comparable pour une adresse connue et inconnue', async () => {
    d.nettoyer();
    d = decor({ delaiMinimalOubliMs: 150, regles: grandesLimites() });
    await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m');
    const c = d.client();
    const [connue, inconnue] = await medianesAlternees(
      9,
      () => c.post('/api/auth/mot-de-passe/oubli', { email: 'alice@exemple.test' }),
      () => c.post('/api/auth/mot-de-passe/oubli', { email: 'personne@exemple.test' }),
    );
    expect(connue).toBeGreaterThanOrEqual(145);
    expect(inconnue).toBeGreaterThanOrEqual(145);
    expect(Math.abs(connue - inconnue)).toBeLessThan(50);
  });
});

/** Règles très larges : pour les tests de durée, que la cadence n'entre pas en jeu. */
function grandesLimites(): ReglesCadence {
  const large = { max: 10_000, fenetreMs: FENETRE };
  const route = { couple: large, email: large, ip: large, reseau: large };
  return { ...REGLES_PAR_DEFAUT, connexion: route, inscription: route, oubli: route, jeton: { ip: large, reseau: large } };
}

const regle = (max: number): { max: number; fenetreMs: number } => ({ max, fenetreMs: FENETRE });

describe('cadence sur les routes', () => {
  let d: Decor;
  const REGLES: ReglesCadence = {
    ...REGLES_PAR_DEFAUT,
    // Couple (e-mail, IP) : 3 ; e-mail seul, toutes IP : 8 ; IP : 6 ; réseau /48 : 12.
    connexion: { couple: regle(3), email: regle(8), ip: regle(6), reseau: regle(12) },
    inscription: { couple: regle(2), email: regle(4), ip: regle(4), reseau: regle(8) },
    oubli: { couple: regle(2), email: regle(4), ip: regle(4), reseau: regle(8) },
  };
  beforeEach(() => {
    d = decor({ regles: REGLES });
  });
  afterEach(() => d.nettoyer());

  it('bloque la connexion après N échecs DEPUIS UNE MÊME IP sur une adresse (même avec le bon mot de passe), puis se relâche', async () => {
    await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m', '10.0.0.1');
    const pirate = d.client('10.0.0.2');
    for (let i = 0; i < 3; i++) expect((await pirate.post('/api/auth/connexion', { email: 'alice@exemple.test', password: `mauvais-essai-${String(i)}` })).statut).toBe(401);
    const bloque = await pirate.post('/api/auth/connexion', { email: 'alice@exemple.test', password: MOT_DE_PASSE });
    expect(bloque.statut).toBe(429);
    expect(bloque.corps).toEqual({ error: 'cadence.depassee' });
    expect(Number(bloque.entetes['retry-after'])).toBeGreaterThan(0);

    d.temps.avancer(FENETRE + MINUTE_MS);
    expect((await pirate.post('/api/auth/connexion', { email: 'alice@exemple.test', password: MOT_DE_PASSE })).statut).toBe(200);
  });

  it('un tiers qui martèle une adresse depuis SON IP ne bloque pas le propriétaire, qui se connecte d’ailleurs', async () => {
    // Cadence par défaut : c'est elle qui doit tenir la promesse, pas des seuils de test.
    d.nettoyer();
    d = decor();
    await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m', '10.0.0.1');
    const pirate = d.client('198.51.100.66');
    const statuts = new Set<number>();
    // Bien au-delà de 10 essais, et de quoi parcourir plusieurs paliers de report exponentiel.
    for (let tour = 0; tour < 4; tour++) {
      for (let i = 0; i < 15; i++) statuts.add((await pirate.post('/api/auth/connexion', { email: 'alice@exemple.test', password: `mauvais-essai-${String(i)}` })).statut);
      d.temps.avancer(40 * MINUTE_MS);
    }
    expect([...statuts].sort()).toEqual([401, 429]);

    const proprietaire = d.client('203.0.113.200');
    expect((await proprietaire.post('/api/auth/connexion', { email: 'alice@exemple.test', password: MOT_DE_PASSE })).statut).toBe(200);
    // Même sort pour la voie de secours : des demandes d'oubli répétées depuis l'IP du tiers ne la ferment pas au propriétaire.
    for (let i = 0; i < 12; i++) await pirate.post('/api/auth/mot-de-passe/oubli', { email: 'alice@exemple.test' });
    const avant = d.mails('alice@exemple.test').length;
    expect((await proprietaire.post('/api/auth/mot-de-passe/oubli', { email: 'alice@exemple.test' })).statut).toBe(202);
    expect(d.mails('alice@exemple.test')).toHaveLength(avant + 1);
  });

  it('une adresse inconnue est limitée exactement comme une adresse connue (le 429 ne trahit rien)', async () => {
    const c = d.client();
    for (let i = 0; i < 3; i++) await c.post('/api/auth/connexion', { email: 'personne@exemple.test', password: 'mauvais-essai-0' });
    expect((await c.post('/api/auth/connexion', { email: 'personne@exemple.test', password: 'mauvais-essai-0' })).statut).toBe(429);
  });

  it('une attaque répartie sur de nombreuses IP (X-Forwarded-For forgé) reste bornée par la clé e-mail, large', async () => {
    await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m', '10.0.0.1');
    const statuts: number[] = [];
    for (let i = 0; i < 9; i++) {
      const r = await d.client(`192.0.2.${String(i + 10)}`).post('/api/auth/connexion', { email: 'alice@exemple.test', password: `mauvais-essai-${String(i)}` });
      statuts.push(r.statut);
    }
    // La connexion de la fixture a déjà débité la clé e-mail (8) : 7 essais passent, le 8e ouvre le blocage.
    expect(statuts).toEqual([401, 401, 401, 401, 401, 401, 401, 429, 429]);
  });

  it('et inversement, une seule adresse IP qui balaie des comptes différents est bornée par l’IP', async () => {
    const c = d.client('192.0.2.50');
    const statuts: number[] = [];
    for (let i = 0; i < 8; i++) statuts.push((await c.post('/api/auth/connexion', { email: `cible${String(i)}@exemple.test`, password: 'mauvais-essai-0' })).statut);
    expect(statuts).toEqual([401, 401, 401, 401, 401, 401, 429, 429]);
  });

  it('IPv6 : changer de préfixe /64 dans le même /48 ne contourne pas la limite', async () => {
    const statuts: number[] = [];
    for (let i = 0; i < 14; i++) {
      // 14 préfixes /64 différents d'un même /48, une cible différente à chaque fois : seule la clé /48 (12) peut les retenir.
      statuts.push((await d.client(`2001:db8:abcd:${String(i + 1)}::1`).post('/api/auth/connexion', { email: `cible${String(i)}@exemple.test`, password: 'mauvais-essai-0' })).statut);
    }
    expect(statuts).toEqual([...Array<number>(12).fill(401), 429, 429]);
  });

  it('une connexion réussie remet à zéro le compteur du couple (e-mail, IP), mais ni celui de l’IP ni celui de l’e-mail seul', async () => {
    await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m', '10.0.0.1');
    const c = d.client('10.0.1.1');
    const statuts: number[] = [];
    // Sans remise à zéro du couple, le 4e essai (donc le 1er du 2e tour) dépasserait la borne de 3.
    for (let tour = 0; tour < 2; tour++) {
      statuts.push((await c.post('/api/auth/connexion', { email: 'alice@exemple.test', password: 'mauvais-essai-0' })).statut);
      statuts.push((await c.post('/api/auth/connexion', { email: 'alice@exemple.test', password: 'mauvais-essai-1' })).statut);
      statuts.push((await c.post('/api/auth/connexion', { email: 'alice@exemple.test', password: MOT_DE_PASSE })).statut);
    }
    expect(statuts).toEqual([401, 401, 200, 401, 401, 200]);
    // Le 7e essai dépasse l'IP (6) : ce compteur-là n'est jamais remis à zéro par un succès.
    expect((await c.post('/api/auth/connexion', { email: 'alice@exemple.test', password: MOT_DE_PASSE })).statut).toBe(429);
  });

  it('limite l’inscription et la demande de réinitialisation, par couple, par e-mail et par IP', async () => {
    const c = d.client('192.0.2.60');
    const cible = { email: 'alice@exemple.test' };
    expect([(await c.post('/api/auth/mot-de-passe/oubli', cible)).statut, (await c.post('/api/auth/mot-de-passe/oubli', cible)).statut]).toEqual([202, 202]);
    const bloque = await c.post('/api/auth/mot-de-passe/oubli', cible);
    expect(bloque.statut).toBe(429);
    expect(bloque.entetes['retry-after']).toBeDefined();
    // Une autre adresse e-mail, même IP : encore admise (borne IP = 4).
    expect((await c.post('/api/auth/mot-de-passe/oubli', { email: 'autre@exemple.test' })).statut).toBe(202);

    const inscrit = (i: number): Promise<Reponse> =>
      d.client('192.0.2.61').post('/api/auth/inscription', { email: `n${String(i)}@exemple.test`, username: `nouveau${String(i)}`, password: MOT_DE_PASSE });
    const apres = [];
    for (let i = 0; i < 6; i++) apres.push((await inscrit(i)).statut);
    expect(apres).toEqual([202, 202, 202, 202, 429, 429]);
  });

  it('le 429 ne passe pas par le hachage : un attaquant bloqué ne coûte plus de CPU', async () => {
    const c = d.client('192.0.2.70');
    for (let i = 0; i < 3; i++) await c.post('/api/auth/connexion', { email: 'alice@exemple.test', password: 'mauvais-essai-0' });
    const debut = performance.now();
    for (let i = 0; i < 20; i++) expect((await c.post('/api/auth/connexion', { email: 'alice@exemple.test', password: 'mauvais-essai-0' })).statut).toBe(429);
    expect(performance.now() - debut).toBeLessThan(2000);
  });

  it('une requête refusée en 429 ne crée aucune clé : l’attaquant ne peut pas saturer la table à ses frais', async () => {
    const limiteur = new LimiteurCadence(d.temps.horloge);
    d.nettoyer();
    d = decor({ regles: REGLES, limiteur });
    const c = d.client('192.0.2.80');
    // 6 essais passent, le 7e ouvre le blocage de l'IP : à partir de là, plus rien ne doit être créé.
    for (let i = 0; i < 7; i++) await c.post('/api/auth/connexion', { email: `cible${String(i)}@exemple.test`, password: 'mauvais-essai-0' });
    const taille = limiteur.taille;
    for (let i = 0; i < 50; i++) expect((await c.post('/api/auth/connexion', { email: `aleatoire${String(i)}@exemple.test`, password: 'x' })).statut).toBe(429);
    expect(limiteur.taille).toBe(taille);
  });

  it('une requête qui finit en 503 (file de hachage pleine) ne débite pas la cadence', async () => {
    d.nettoyer();
    // Hachage au coût de production : 80 requêtes simultanées dépassent largement 4 en cours + 32 en attente.
    d = decor({
      parametresScrypt: { N: 2 ** 15, r: 8, p: 1 },
      regles: { ...REGLES, connexion: { couple: regle(80), email: regle(1000), ip: regle(80), reseau: regle(1000) } },
    });
    const statuts = await Promise.all(
      Array.from({ length: 80 }, (_, i) =>
        d.client('192.0.2.90').post('/api/auth/connexion', { email: `cible${String(i)}@exemple.test`, password: 'mauvais-essai-0' }).then((r) => r.statut),
      ),
    );
    const refuses = statuts.filter((s) => s === 503).length;
    expect(refuses).toBeGreaterThan(0);
    // Si les 503 avaient été débités, l'IP aurait déjà consommé ses 80 essais : celui-ci serait en 429.
    expect((await d.client('192.0.2.90').post('/api/auth/connexion', { email: 'sonde@exemple.test', password: 'mauvais-essai-0' })).statut).toBe(401);
  }, 60_000);
});

describe('cloisonnement entre comptes', () => {
  let d: Decor;
  let alice: Client;
  let bob: Client;
  beforeEach(async () => {
    d = decor();
    alice = await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m', '10.0.0.1');
    bob = await inscrireEtConnecter(d, 'bob@exemple.test', 'bob_m', '10.0.0.2');
  });
  afterEach(() => d.nettoyer());

  it('Bob ne voit que ses sessions et ne peut pas révoquer celle d’Alice, même en forgeant son identifiant', async () => {
    const sessionsAlice = ((await alice.get('/api/moi/sessions')).corps['sessions'] as Array<{ id: string }>);
    const sessionsBob = ((await bob.get('/api/moi/sessions')).corps['sessions'] as Array<{ id: string }>);
    expect(sessionsAlice).toHaveLength(1);
    expect(sessionsBob).toHaveLength(1);
    expect(sessionsBob.map((s) => s.id)).not.toContain(sessionsAlice[0]?.id);

    const forge = await bob.delete(`/api/moi/sessions/${sessionsAlice[0]?.id ?? ''}`);
    expect(forge.statut).toBe(404);
    expect(forge.corps).toEqual({ error: 'session.introuvable' });
    expect((await alice.get('/api/moi')).statut).toBe(200);
    expect(d.sql.prepare('SELECT count(*) FROM sessions WHERE revoked_at IS NOT NULL').pluck().get()).toBe(0);
  });

  it('« révoquer tout le reste » ne touche que les sessions du compte appelant', async () => {
    const telephoneBob = d.client('10.0.0.3');
    await telephoneBob.post('/api/auth/connexion', { email: 'bob@exemple.test', password: MOT_DE_PASSE });
    expect((await bob.delete('/api/moi/sessions')).corps).toEqual({ revoquees: 1 });
    expect((await alice.get('/api/moi')).statut).toBe(200);
  });

  it('le profil modifié est celui de la session : aucun champ ne permet de viser un autre compte', async () => {
    await bob.patch('/api/moi', { display_name: 'Bob modifié' });
    expect((await alice.get('/api/moi')).corps['display_name']).toBe('alice_m');
    expect((await bob.patch('/api/moi', { id: 'autre', user_id: 'autre' })).statut).toBe(400);
  });

  it('un compte ne peut pas se connecter avec le cookie d’un autre compte supprimé de la base', async () => {
    d.sql.prepare("DELETE FROM users WHERE username = 'alice_m'").run();
    expect((await alice.get('/api/moi')).statut).toBe(401);
    expect((await bob.get('/api/moi')).statut).toBe(200);
  });
});

describe('journal', () => {
  it('ne contient ni mot de passe, ni jeton, ni cookie, ni adresse IP, ni adresse e-mail', async () => {
    const lignes: string[] = [];
    const d = decor({ journal: creerJournal('debug', (l) => lignes.push(l)) });
    try {
      const alice = await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m', '203.0.113.99');
      const cookie = (alice.cookie ?? '').replace('attroupe_session=', '');
      await alice.post('/api/auth/mot-de-passe/oubli', { email: 'alice@exemple.test' });
      const jeton = await d.jetonMail('alice@exemple.test', 'reinitialisation_mot_de_passe');
      await alice.post('/api/auth/mot-de-passe/reinitialisation', { token: jeton, password: 'un-tout-nouveau-mot-de-passe' });
      await alice.post('/api/auth/connexion', { email: 'alice@exemple.test', password: 'mauvais-essai-0' });
      const journal = lignes.join('\n');
      expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(lignes.length).toBeGreaterThan(2);
      for (const secret of [MOT_DE_PASSE, 'un-tout-nouveau-mot-de-passe', jeton, cookie, '203.0.113.99', 'alice@exemple.test', 'scrypt$']) {
        expect(journal, secret).not.toContain(secret);
      }
      expect(journal).toContain('"chemin":"/api/auth/connexion"');
    } finally {
      d.nettoyer();
    }
  });

  it('masque tout champ dont le nom ressemble à un secret, même passé par erreur', () => {
    const lignes: string[] = [];
    const j = creerJournal('info', (l) => lignes.push(l));
    j.info('test', { password: 'x', mot_de_passe: 'x', token: 'x', jeton: 'x', password_hash: 'x', cookie: 'x', authorization: 'x', apiKey: 'x', ok: 1 });
    expect(lignes[0]).not.toMatch(/"x"/);
    expect(lignes[0]).toContain('"ok":1');
  });
});
