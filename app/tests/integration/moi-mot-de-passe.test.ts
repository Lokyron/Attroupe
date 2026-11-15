import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chercherCompteActifParEmail, creerSession } from '../../server/db/queries/comptes.js';
import { MINUTE_MS } from '../../server/domain/instant.js';
import { decor, inscrireEtConnecter, MOT_DE_PASSE, type Client, type Decor } from '../fixtures/comptes.js';

const NOUVEAU = 'un-tout-nouveau-mot-de-passe';

describe('POST /api/moi/mot-de-passe', () => {
  let d: Decor;
  let alice: Client;
  let telephone: Client;
  beforeEach(async () => {
    d = decor();
    alice = await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m', '10.0.0.1');
    telephone = d.client('10.0.0.2');
    await telephone.post('/api/auth/connexion', { email: 'alice@exemple.test', password: MOT_DE_PASSE });
  });
  afterEach(() => d.nettoyer());

  const changer = (c: Client, ancien: string, nouveau: string): ReturnType<Client['post']> =>
    c.post('/api/moi/mot-de-passe', { current_password: ancien, new_password: nouveau });

  it('refuse un mauvais ancien mot de passe et ne change rien', async () => {
    const cookieAvant = alice.cookie;
    const r = await changer(alice, 'mauvais-ancien-mot-de-passe', NOUVEAU);
    expect(r.statut).toBe(400);
    expect(r.corps).toEqual({ error: 'mot_de_passe.actuel_invalide' });
    expect(r.cookies).toEqual([]);
    expect(alice.cookie).toBe(cookieAvant);
    expect((await telephone.get('/api/moi')).statut).toBe(200); // aucune session révoquée
    expect((await d.client().post('/api/auth/connexion', { email: 'alice@exemple.test', password: MOT_DE_PASSE })).statut).toBe(200);
  });

  it('pose le nouveau mot de passe, révoque les autres sessions, et renouvelle le jeton de la session courante', async () => {
    const ancienCookie = alice.cookie ?? '';
    const sessionsAvant = d.sql.prepare('SELECT id, created_at FROM sessions ORDER BY created_at, id').all() as Array<{ id: string; created_at: string }>;
    const idCourant = ((await alice.get('/api/moi/sessions')).corps['sessions'] as Array<{ id: string; courante: boolean }>).find((s) => s.courante)?.id;

    const r = await changer(alice, MOT_DE_PASSE, NOUVEAU);
    expect(r.statut).toBe(200);
    expect(r.corps).toEqual({ ok: true });

    // Nouveau jeton posé en cookie ; l'ancien cookie ne vaut plus rien.
    expect(alice.cookie).toMatch(/^attroupe_session=[A-Za-z0-9_-]{43}$/);
    expect(alice.cookie).not.toBe(ancienCookie);
    expect((await d.client('10.0.0.1').envoyer('get', '/api/moi', undefined, { cookie: ancienCookie })).statut).toBe(401);
    // La session courante reste valide avec le nouveau jeton, et c'est la MÊME session (identifiant et ouverture conservés).
    expect((await alice.get('/api/moi')).statut).toBe(200);
    const sessions = (await alice.get('/api/moi/sessions')).corps['sessions'] as Array<{ id: string; courante: boolean }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(idCourant);
    expect(d.sql.prepare('SELECT created_at FROM sessions WHERE id = ?').pluck().get(idCourant)).toBe(sessionsAvant.find((s) => s.id === idCourant)?.created_at);
    // Les autres sont révoquées.
    expect((await telephone.get('/api/moi')).statut).toBe(401);
    expect(d.sql.prepare('SELECT count(*) FROM sessions WHERE revoked_at IS NOT NULL').pluck().get()).toBe(1);

    // L'ancien mot de passe est refusé, le nouveau accepté.
    expect((await d.client().post('/api/auth/connexion', { email: 'alice@exemple.test', password: MOT_DE_PASSE })).statut).toBe(401);
    expect((await d.client().post('/api/auth/connexion', { email: 'alice@exemple.test', password: NOUVEAU })).statut).toBe(200);
  });

  it('invalide les réinitialisations en cours (un lien d’e-mail déjà reçu ne rouvre pas la porte)', async () => {
    await alice.post('/api/auth/mot-de-passe/oubli', { email: 'alice@exemple.test' });
    const jeton = await d.jetonMail('alice@exemple.test', 'reinitialisation_mot_de_passe');
    expect((await changer(alice, MOT_DE_PASSE, NOUVEAU)).statut).toBe(200);
    const r = await d.client().post('/api/auth/mot-de-passe/reinitialisation', { token: jeton, password: 'encore-un-autre-mot-de-passe' });
    expect(r.statut).toBe(400);
  });

  it('applique la même politique que l’inscription, et refuse de reposer le même mot de passe', async () => {
    expect((await changer(alice, MOT_DE_PASSE, 'court')).corps).toEqual({ error: 'mot_de_passe.trop_court' });
    expect((await changer(alice, MOT_DE_PASSE, 'alice_m-alice_m')).corps).toEqual({ error: 'mot_de_passe.contient_identifiant' });
    expect((await changer(alice, MOT_DE_PASSE, MOT_DE_PASSE)).corps).toEqual({ error: 'mot_de_passe.identique' });
    expect((await telephone.get('/api/moi')).statut).toBe(200); // rien n'a été révoqué
  });

  it('exige une session, l’en-tête Origin, et un corps strict', async () => {
    expect((await changer(d.client(), MOT_DE_PASSE, NOUVEAU)).statut).toBe(401);
    expect((await alice.post('/api/moi/mot-de-passe', { current_password: MOT_DE_PASSE, new_password: NOUVEAU }, { origine: 'https://pirate.test' })).statut).toBe(403);
    expect((await alice.post('/api/moi/mot-de-passe', { current_password: MOT_DE_PASSE, new_password: NOUVEAU, user_id: 'autre' })).statut).toBe(400);
    expect((await telephone.get('/api/moi')).statut).toBe(200);
  });

  it('le changement d’Alice n’atteint aucune session ni aucun mot de passe de Bob', async () => {
    const bob = await inscrireEtConnecter(d, 'bob@exemple.test', 'bob_m', '10.0.0.3');
    expect((await changer(alice, MOT_DE_PASSE, NOUVEAU)).statut).toBe(200);
    expect((await bob.get('/api/moi')).statut).toBe(200);
    expect((await d.client().post('/api/auth/connexion', { email: 'bob@exemple.test', password: MOT_DE_PASSE })).statut).toBe(200);
  });

  it('est limitée par compte : on ne devine pas l’ancien mot de passe à volonté avec une session volée', async () => {
    const statuts: number[] = [];
    for (let i = 0; i < 7; i++) statuts.push((await changer(alice, `mauvais-ancien-${String(i)}-x`, NOUVEAU)).statut);
    expect(statuts).toEqual([400, 400, 400, 400, 400, 429, 429]);
    d.temps.avancer(16 * MINUTE_MS);
    expect((await changer(alice, MOT_DE_PASSE, NOUVEAU)).statut).toBe(200);
  });
});

describe('POST /api/moi/email/verification (renvoi du mail de vérification)', () => {
  let d: Decor;
  let alice: Client;
  beforeEach(async () => {
    d = decor();
    alice = await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m', '10.0.0.1');
  });
  afterEach(() => d.nettoyer());

  it('un lien expiré se rattrape : nouveau mail, ancien lien mort, nouveau lien valide', async () => {
    const ancien = await d.jetonMail('alice@exemple.test', 'verification_email');
    d.temps.avancer(25 * 60 * MINUTE_MS); // le lien de 24 h a expiré
    expect((await d.client().post('/api/auth/email/verification', { token: ancien })).statut).toBe(400);

    const r = await alice.post('/api/moi/email/verification');
    expect(r.statut).toBe(202);
    const nouveau = await d.jetonMail('alice@exemple.test', 'verification_email');
    expect(nouveau).not.toBe(ancien);
    expect((await d.client().post('/api/auth/email/verification', { token: ancien })).statut).toBe(400);
    expect((await d.client().post('/api/auth/email/verification', { token: nouveau })).statut).toBe(200);
    expect((await alice.get('/api/moi')).corps['email_verified_at']).not.toBeNull();
  });

  it('refuse (409) quand l’adresse est déjà vérifiée, et sans session (401)', async () => {
    const jeton = await d.jetonMail('alice@exemple.test', 'verification_email');
    await d.client().post('/api/auth/email/verification', { token: jeton });
    expect(d.mails('alice@exemple.test')).toHaveLength(1);
    const r = await alice.post('/api/moi/email/verification');
    expect(r.statut).toBe(409);
    expect(r.corps).toEqual({ error: 'email.deja_verifie' });
    expect(d.mails('alice@exemple.test')).toHaveLength(1);
    expect((await d.client().post('/api/moi/email/verification')).statut).toBe(401);
  });

  it('est limitée : chaque demande envoie un e-mail', async () => {
    const statuts: number[] = [];
    for (let i = 0; i < 5; i++) statuts.push((await alice.post('/api/moi/email/verification')).statut);
    expect(statuts).toEqual([202, 202, 202, 429, 429]);
  });

  it('ne s’adresse qu’au compte de la session : le mail part vers SON adresse', async () => {
    const bob = await inscrireEtConnecter(d, 'bob@exemple.test', 'bob_m', '10.0.0.3');
    await bob.post('/api/moi/email/verification');
    expect(d.mails('bob@exemple.test')).toHaveLength(2);
    expect(d.mails('alice@exemple.test')).toHaveLength(1);
  });
});

describe('une session ne s’ouvre que sur une preuve', () => {
  let d: Decor;
  beforeEach(() => {
    d = decor();
  });
  afterEach(() => d.nettoyer());

  it('un compte trouvé par son adresse n’est pas une preuve : creerSession le refuse, au typage comme à l’exécution', async () => {
    await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m');
    const avant = d.sql.prepare('SELECT count(*) FROM sessions').pluck().get();
    const compte = chercherCompteActifParEmail(d.base, 'alice@exemple.test');
    if (compte === undefined) throw new Error('compte attendu');
    const session = { empreinte: 'x'.repeat(64), maintenant: '2026-11-15T12:00:00Z', expireLe: '2026-12-15T12:00:00Z', userAgent: null, ipHash: null };
    // @ts-expect-error — CompteAuthentifiable (adresse connue) n'est pas CompteProuve (mot de passe vérifié)
    expect(() => creerSession(d.base, compte, session)).toThrow(/non prouvé/);
    expect(d.sql.prepare('SELECT count(*) FROM sessions').pluck().get()).toBe(avant);
  });
});
