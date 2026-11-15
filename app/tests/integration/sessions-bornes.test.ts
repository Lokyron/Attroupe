import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { purgerAuthentification, SESSIONS_MAX_PAR_COMPTE } from '../../server/db/queries/comptes.js';
import { JOUR_MS } from '../../server/domain/instant.js';
import { decor, inscrireEtConnecter, MOT_DE_PASSE, type Decor } from '../fixtures/comptes.js';

describe('sessions : bornes et entretien', () => {
  let d: Decor;
  beforeEach(() => {
    d = decor();
  });
  afterEach(() => d.nettoyer());

  it(`au-delà de ${String(SESSIONS_MAX_PAR_COMPTE)} sessions ouvertes, la plus ancienne est révoquée`, async () => {
    const premier = await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m', '10.0.0.1');
    for (let i = 0; i < SESSIONS_MAX_PAR_COMPTE; i++) {
      d.temps.avancer(1000);
      await d.client(`10.0.1.${String(i)}`).post('/api/auth/connexion', { email: 'alice@exemple.test', password: MOT_DE_PASSE });
    }
    expect(d.sql.prepare('SELECT count(*) FROM sessions WHERE revoked_at IS NULL').pluck().get()).toBe(SESSIONS_MAX_PAR_COMPTE);
    expect((await premier.get('/api/moi')).statut).toBe(401); // la plus ancienne a été évincée
  });

  it('la purge efface les sessions et jetons morts depuis plus d’une semaine, et rien d’autre', async () => {
    const alice = await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m');
    await d.client('10.0.0.9').post('/api/auth/mot-de-passe/oubli', { email: 'alice@exemple.test' });
    d.temps.avancer(40 * JOUR_MS);
    // La session d'Alice a expiré (30 jours), les jetons aussi.
    const avant = new Date(d.temps.maintenant().getTime() - 7 * JOUR_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
    expect(purgerAuthentification(d.base, avant)).toBeGreaterThanOrEqual(3);
    expect(d.sql.prepare('SELECT count(*) FROM sessions').pluck().get()).toBe(0);
    expect(d.sql.prepare('SELECT count(*) FROM password_reset_tokens').pluck().get()).toBe(0);
    expect(d.sql.prepare('SELECT count(*) FROM users').pluck().get()).toBe(1);
    expect((await alice.get('/api/moi')).statut).toBe(401);
  });

  it('un compte suspendu après la demande ne peut plus réinitialiser son mot de passe, et le jeton n’est pas consommé', async () => {
    await inscrireEtConnecter(d, 'alice@exemple.test', 'alice_m');
    const c = d.client();
    await c.post('/api/auth/mot-de-passe/oubli', { email: 'alice@exemple.test' });
    const jeton = await d.jetonMail('alice@exemple.test', 'reinitialisation_mot_de_passe');
    d.sql.prepare("UPDATE users SET disabled_at = '2026-11-15T12:00:00Z'").run();
    const r = await c.post('/api/auth/mot-de-passe/reinitialisation', { token: jeton, password: 'un-tout-nouveau-mot-de-passe' });
    expect(r.statut).toBe(400);
    expect(r.corps).toEqual({ error: 'jeton.invalide' });
    expect(d.sql.prepare('SELECT count(*) FROM password_reset_tokens WHERE used_at IS NULL').pluck().get()).toBe(1);
  });
});
