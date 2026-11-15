import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEURE_MS, JOUR_MS, MINUTE_MS } from '../../server/domain/instant.js';
import { decor, inscrireEtConnecter, MOT_DE_PASSE, ORIGINE, type Decor } from '../fixtures/comptes.js';

// Le parcours complet d'un compte, de l'inscription à la reconnexion après mot de passe oublié.
describe('parcours d’un compte', () => {
  let d: Decor;
  beforeEach(() => {
    d = decor();
  });
  afterEach(() => d.nettoyer());

  it('inscription → vérification → connexion → /moi → sessions → déconnexion → oubli → reconnexion', async () => {
    const alice = d.client();
    const inscription = await alice.post('/api/auth/inscription', { email: 'Alice@Exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    expect(inscription.statut).toBe(202);
    expect(inscription.corps).toEqual({ ok: true });
    // Pas de session ouverte par l'inscription (sinon la réponse différerait de celle d'une adresse déjà inscrite).
    expect(inscription.cookies).toEqual([]);

    // Vérification d'e-mail : l'e-mail est en file (jamais envoyé dans la requête), le jeton est à usage unique.
    expect(d.mails('alice@exemple.test').map((m) => m.template_key)).toEqual(['verification_email']);
    const jetonVerif = await d.jetonMail('alice@exemple.test', 'verification_email');
    expect((await alice.post('/api/auth/email/verification', { token: jetonVerif })).statut).toBe(200);
    expect((await alice.post('/api/auth/email/verification', { token: jetonVerif })).statut).toBe(400);

    const connexion = await alice.post('/api/auth/connexion', { email: 'alice@exemple.test', password: MOT_DE_PASSE });
    expect(connexion.statut).toBe(200);
    const cookie = connexion.cookies.find((c) => c.startsWith('attroupe_session='));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=2592000/); // 30 jours

    const moi = await alice.get('/api/moi');
    expect(moi.statut).toBe(200);
    expect(moi.corps).toMatchObject({
      email: 'alice@exemple.test',
      username: 'alice_m',
      display_name: 'alice_m',
      time_zone: 'Europe/Paris',
      locale: 'fr',
      service_email: 'non_configure',
    });
    expect(moi.corps['email_verified_at']).toEqual(expect.any(String));
    expect(moi.corps).not.toHaveProperty('password_hash');

    // Un deuxième appareil, puis la liste, la révocation de l'un, puis de tout le reste.
    const telephone = d.client('198.51.100.9');
    await telephone.post('/api/auth/connexion', { email: 'alice@exemple.test', password: MOT_DE_PASSE });
    const liste = await alice.get('/api/moi/sessions');
    const sessions = liste.corps['sessions'] as Array<{ id: string; courante: boolean; user_agent: string }>;
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.courante)).toHaveLength(1);
    expect(sessions[0]).not.toHaveProperty('token_hash');
    expect(sessions[0]).not.toHaveProperty('ip_hash');
    expect(sessions[0]?.user_agent).toBe('Test/1.0 (Appareil A)');

    const autre = sessions.find((s) => !s.courante);
    expect((await alice.delete(`/api/moi/sessions/${autre?.id ?? ''}`)).statut).toBe(200);
    expect((await telephone.get('/api/moi')).statut).toBe(401); // révocation immédiate
    expect((await alice.get('/api/moi')).statut).toBe(200);
    expect((await alice.delete(`/api/moi/sessions/${autre?.id ?? ''}`)).statut).toBe(404); // déjà révoquée

    await telephone.post('/api/auth/connexion', { email: 'alice@exemple.test', password: MOT_DE_PASSE });
    expect((await alice.delete('/api/moi/sessions')).corps).toEqual({ revoquees: 1 });
    expect((await telephone.get('/api/moi')).statut).toBe(401);
    expect((await alice.get('/api/moi')).statut).toBe(200);

    // Déconnexion : le cookie est effacé, la session révoquée côté serveur.
    const cookieAvant = alice.cookie;
    const sortie = await alice.post('/api/auth/deconnexion');
    expect(sortie.statut).toBe(200);
    expect(alice.cookie).toBeUndefined();
    expect((await d.client().get('/api/moi', { cookie: cookieAvant ?? null })).statut).toBe(401);

    // Mot de passe oublié → réinitialisation → ancien mot de passe mort, nouveau valable.
    const nouveau = 'un-tout-nouveau-mot-de-passe';
    expect((await alice.post('/api/auth/mot-de-passe/oubli', { email: 'alice@exemple.test' })).statut).toBe(202);
    const jetonReset = await d.jetonMail('alice@exemple.test', 'reinitialisation_mot_de_passe');
    const reinit = await alice.post('/api/auth/mot-de-passe/reinitialisation', { token: jetonReset, password: nouveau });
    expect(reinit.statut).toBe(200);
    expect((await alice.post('/api/auth/mot-de-passe/reinitialisation', { token: jetonReset, password: nouveau })).statut).toBe(400); // usage unique
    expect((await alice.post('/api/auth/connexion', { email: 'alice@exemple.test', password: MOT_DE_PASSE })).statut).toBe(401);
    expect((await alice.post('/api/auth/connexion', { email: 'alice@exemple.test', password: nouveau })).statut).toBe(200);
    expect((await alice.get('/api/moi')).statut).toBe(200);
  });

  it('la réinitialisation révoque TOUTES les sessions ouvertes', async () => {
    const alice = await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m');
    const telephone = d.client('198.51.100.9');
    await telephone.post('/api/auth/connexion', { email: 'alice@exemple.test', password: MOT_DE_PASSE });
    await alice.post('/api/auth/mot-de-passe/oubli', { email: 'alice@exemple.test' });
    await alice.post('/api/auth/mot-de-passe/reinitialisation', {
      token: await d.jetonMail('alice@exemple.test', 'reinitialisation_mot_de_passe'),
      password: 'un-tout-nouveau-mot-de-passe',
    });
    expect((await alice.get('/api/moi')).statut).toBe(401);
    expect((await telephone.get('/api/moi')).statut).toBe(401);
  });

  it('le jeton de réinitialisation expire au bout d’une heure ; une nouvelle demande invalide la précédente', async () => {
    await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m');
    const c = d.client();
    await c.post('/api/auth/mot-de-passe/oubli', { email: 'alice@exemple.test' });
    const premier = await d.jetonMail('alice@exemple.test', 'reinitialisation_mot_de_passe');
    await c.post('/api/auth/mot-de-passe/oubli', { email: 'alice@exemple.test' });
    const second = await d.jetonMail('alice@exemple.test', 'reinitialisation_mot_de_passe');
    expect(second).not.toBe(premier);
    const corps = (token: string): { token: string; password: string } => ({ token, password: 'un-tout-nouveau-mot-de-passe' });
    expect((await c.post('/api/auth/mot-de-passe/reinitialisation', corps(premier))).statut).toBe(400);
    d.temps.avancer(HEURE_MS + MINUTE_MS);
    expect((await c.post('/api/auth/mot-de-passe/reinitialisation', corps(second))).statut).toBe(400);
  });

  it('un mot de passe faible est refusé à la réinitialisation sans consommer le jeton', async () => {
    await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m');
    const c = d.client();
    await c.post('/api/auth/mot-de-passe/oubli', { email: 'alice@exemple.test' });
    const jeton = await d.jetonMail('alice@exemple.test', 'reinitialisation_mot_de_passe');
    expect((await c.post('/api/auth/mot-de-passe/reinitialisation', { token: jeton, password: 'password123' })).corps['error']).toBe('mot_de_passe.trop_courant');
    expect((await c.post('/api/auth/mot-de-passe/reinitialisation', { token: jeton, password: 'un-tout-nouveau-mot-de-passe' })).statut).toBe(200);
  });

  it('le jeton de vérification expire au bout de 24 h', async () => {
    const c = d.client();
    await c.post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    const jeton = await d.jetonMail('alice@exemple.test', 'verification_email');
    d.temps.avancer(JOUR_MS + MINUTE_MS);
    expect((await c.post('/api/auth/email/verification', { token: jeton })).statut).toBe(400);
  });

  it('la session glisse sur 30 jours mais ne dépasse jamais 90 jours depuis l’ouverture', async () => {
    const alice = await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m');
    for (let i = 0; i < 2; i++) {
      d.temps.avancer(25 * JOUR_MS);
      expect((await alice.get('/api/moi')).statut).toBe(200); // prolongée à chaque passage (> 1 h depuis la dernière)
    }
    d.temps.avancer(25 * JOUR_MS); // 75 jours : encore vivante grâce à la prolongation
    const proche = await alice.get('/api/moi');
    expect(proche.statut).toBe(200);
    const cookie = proche.cookies.find((c) => c.startsWith('attroupe_session='));
    expect(Number(/Max-Age=(\d+)/.exec(cookie ?? '')?.[1])).toBeLessThanOrEqual(15 * 24 * 3600); // plafonnée à J+90
    d.temps.avancer(16 * JOUR_MS); // 91 jours après l'ouverture
    expect((await alice.get('/api/moi')).statut).toBe(401);
  });

  it('une session inactive plus de 30 jours est expirée', async () => {
    const alice = await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m');
    d.temps.avancer(31 * JOUR_MS);
    expect((await alice.get('/api/moi')).statut).toBe(401);
  });

  it('un compte suspendu perd sa session immédiatement', async () => {
    const alice = await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m');
    d.sql.prepare("UPDATE users SET disabled_at = '2026-11-15T12:00:00Z' WHERE username = 'alice_m'").run();
    expect((await alice.get('/api/moi')).statut).toBe(401);
    expect((await d.client().post('/api/auth/connexion', { email: 'alice@exemple.test', password: MOT_DE_PASSE })).statut).toBe(401);
  });

  it('le profil se modifie : nom affiché, fuseau, anniversaire ; le reste est refusé', async () => {
    const alice = await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m');
    const ok = await alice.patch('/api/moi', { display_name: 'Alice M.', time_zone: 'America/Montreal', birthday: '1990-02-28' });
    expect(ok.statut).toBe(200);
    expect(ok.corps).toMatchObject({ display_name: 'Alice M.', time_zone: 'America/Montreal', birthday: '1990-02-28' });
    expect((await alice.patch('/api/moi', { birthday: '--02-29' })).statut).toBe(200);
    expect((await alice.patch('/api/moi', { birthday: null })).corps['birthday']).toBeNull();
    for (const mauvais of [
      { time_zone: 'Mars/Olympus' },
      { birthday: '1990-02-30' },
      { birthday: '2999-01-01' },
      { display_name: '' },
      { display_name: 'x'.repeat(61) },
      { is_instance_admin: 1 }, // affectation de masse
      { email: 'pirate@exemple.test' },
      { password_hash: 'x' },
      {},
    ]) {
      expect((await alice.patch('/api/moi', mauvais)).statut, JSON.stringify(mauvais)).toBe(400);
    }
    expect(d.sql.prepare("SELECT is_instance_admin, email FROM users WHERE username = 'alice_m'").get()).toEqual({
      is_instance_admin: 0,
      email: 'alice@exemple.test',
    });
  });

  it('les routes protégées répondent 401 sans session', async () => {
    const c = d.client();
    for (const [methode, chemin] of [['get', '/api/moi'], ['patch', '/api/moi'], ['get', '/api/moi/sessions'], ['delete', '/api/moi/sessions'], ['delete', '/api/moi/sessions/abc']] as const) {
      const r = await c.envoyer(methode, chemin, methode === 'patch' ? { display_name: 'x' } : undefined);
      expect(r.statut, `${methode} ${chemin}`).toBe(401);
    }
  });

  it('un cookie forgé ou mal formé est ignoré (et effacé)', async () => {
    const c = d.client();
    expect((await c.get('/api/moi', { cookie: 'attroupe_session=n-importe-quoi' })).statut).toBe(401);
    const r = await c.get('/api/moi', { cookie: `attroupe_session=${'A'.repeat(43)}` });
    expect(r.statut).toBe(401);
    expect(r.cookies.some((x) => x.startsWith('attroupe_session=;'))).toBe(true);
  });
});

describe('inscription', () => {
  let d: Decor;
  beforeEach(() => {
    d = decor();
  });
  afterEach(() => d.nettoyer());

  it('refuse un nom d’utilisateur déjà pris (sans casse), jamais une adresse déjà inscrite', async () => {
    const c = d.client();
    await c.post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    const pris = await c.post('/api/auth/inscription', { email: 'autre@exemple.test', username: 'ALICE_M', password: MOT_DE_PASSE });
    expect(pris.statut).toBe(409);
    expect(pris.corps).toEqual({ error: 'nom_utilisateur.pris' });
    expect(d.sql.prepare('SELECT count(*) FROM users').pluck().get()).toBe(1);
  });

  it('refuse les entrées invalides en nommant les champs, jamais les valeurs', async () => {
    const c = d.client();
    const r = await c.post('/api/auth/inscription', { email: 'pas-un-mail', username: 'a', password: MOT_DE_PASSE, role: 'admin' });
    expect(r.statut).toBe(400);
    expect(r.corps['error']).toBe('requete.invalide');
    expect(JSON.stringify(r.corps)).not.toContain(MOT_DE_PASSE);
    expect((r.corps['champs'] as string[]).sort()).toEqual(['_', 'email', 'username'].sort());
  });

  it.each([
    ['trop court', 'Abc!9xyz', 'mot_de_passe.trop_court'],
    ['courant', 'Password1234', 'mot_de_passe.trop_courant'],
    ['trivial', '1234567890', 'mot_de_passe.trop_simple'],
    ['contient le nom d’utilisateur', 'xx-alice_m-vert!', 'mot_de_passe.contient_identifiant'],
  ])('refuse un mot de passe %s', async (_nom, motDePasse, erreur) => {
    const r = await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: motDePasse });
    expect(r.statut).toBe(400);
    expect(r.corps).toEqual({ error: erreur });
    expect(d.sql.prepare('SELECT count(*) FROM users').pluck().get()).toBe(0);
  });

  it('en mode « invite », l’inscription ouverte est fermée', async () => {
    d.nettoyer();
    d = decor({}, { ATTROUPE_REGISTRATION: 'invite' });
    const r = await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    expect(r.statut).toBe(403);
    expect(r.corps).toEqual({ error: 'inscription.fermee' });
  });

  it('les e-mails sont en français, avec un lien dont le jeton est dans le fragment', async () => {
    await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    await d.remettre();
    const message = d.envoyes.find((m) => m.to === 'alice@exemple.test');
    expect(message?.sujet).toBe('Confirmez votre adresse e-mail');
    const lien = /https?:\/\/\S+/.exec(message?.texte ?? '')?.[0] ?? '';
    const url = new URL(lien);
    expect(url.origin).toBe(ORIGINE);
    expect(url.search).toBe(''); // le jeton n'apparaît ni dans la requête, ni donc dans les journaux du proxy
    expect(url.hash).toMatch(/^#jeton=[A-Za-z0-9_-]{43}$/);
  });
});

describe('ce que la base garde', () => {
  let d: Decor;
  beforeEach(() => {
    d = decor();
  });
  afterEach(() => d.nettoyer());

  it('ni jeton, ni mot de passe en clair : sessions et jetons sont hachés, le mot de passe est en scrypt', async () => {
    const alice = await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m');
    await alice.post('/api/auth/mot-de-passe/oubli', { email: 'alice@exemple.test' });
    const cookie = (alice.cookie ?? '').replace('attroupe_session=', '');
    const jetonVerif = await d.jetonMail('alice@exemple.test', 'verification_email');
    const jetonReset = await d.jetonMail('alice@exemple.test', 'reinitialisation_mot_de_passe');

    const session = d.sql.prepare('SELECT token_hash, ip_hash FROM sessions').get() as { token_hash: string; ip_hash: string };
    expect(session.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(session.token_hash).not.toBe(cookie);
    expect(session.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(session)).not.toContain('203.0.113.7');

    const tout = JSON.stringify([
      d.sql.prepare('SELECT * FROM sessions').all(),
      d.sql.prepare('SELECT * FROM password_reset_tokens').all(),
      d.sql.prepare('SELECT * FROM email_verification_tokens').all(),
    ]);
    for (const secret of [cookie, jetonVerif, jetonReset]) expect(tout).not.toContain(secret);

    const mdp = d.sql.prepare("SELECT password_hash FROM users WHERE username = 'alice_m'").pluck().get() as string;
    expect(mdp).toMatch(/^scrypt\$1024\$8\$1\$/);
    expect(mdp).not.toContain(MOT_DE_PASSE);
  });
});
