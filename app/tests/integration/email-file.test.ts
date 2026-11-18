import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HEURE_MS, MINUTE_MS } from '../../server/domain/instant.js';
import { enfilerEmail } from '../../server/db/queries/transverse.js';
import { JOURNAL_SILENCIEUX } from '../../server/http/middleware/journal.js';
import {
  creerTransporteurBrevo,
  ErreurTransport,
  ESSAIS_MAX,
  remettreFile,
  REPORT_CONFIGURATION_MS,
  REPORTS_MS,
  type Transporteur,
} from '../../server/services/brevo.js';
import { demarrerTaches } from '../../server/services/taches.js';
import { decor, MOT_DE_PASSE, ORIGINE, type Decor } from '../fixtures/comptes.js';
import { demarrerFauxBrevo, type FauxBrevo } from '../fixtures/faux-brevo.js';

// La file d'e-mails (architecture §7.3) prouvée contre un FAUX serveur Brevo : aucun envoi réel n'est possible
// sans clé d'API, mais tout ce qui est de notre côté (corps, en-têtes, réessais, plafond, rétablissement) l'est.

interface LigneFile {
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  provider_message_id: string | null;
  payload_json: string;
  sent_at: string | null;
}

describe('file d’e-mails et service Brevo', () => {
  let d: Decor;
  let brevo: FauxBrevo;
  let transporteur: Transporteur;
  const CLE = 'xkeysib-cle-de-test-ne-doit-jamais-fuiter';

  const file = (): LigneFile => d.sql.prepare('SELECT * FROM email_outbox ORDER BY created_at, id').get() as LigneFile;
  const remettre = (): ReturnType<typeof remettreFile> => remettreFile(d.base, transporteur, d.temps.maintenant(), ORIGINE);

  beforeEach(async () => {
    d = decor();
    brevo = await demarrerFauxBrevo();
    transporteur = creerTransporteurBrevo({
      apiKey: CLE,
      expediteurEmail: 'no-reply@attroupe.test',
      expediteurNom: 'Attroupe',
      urlApi: brevo.url,
      delaiMs: 300,
    });
  });
  afterEach(async () => {
    await brevo.arreter();
    d.nettoyer();
  });

  it('l’inscription met l’e-mail en file SANS l’envoyer dans la requête', async () => {
    const r = await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    expect(r.statut).toBe(202);
    expect(brevo.appels).toHaveLength(0);
    expect(file()).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('vide la file : corps, en-têtes et gabarit français corrects, puis ne renvoie pas deux fois', async () => {
    await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', display_name: 'Alice <b>', password: MOT_DE_PASSE });

    expect(await remettre()).toEqual({ envoyes: 1, reportes: 0, abandonnes: 0, definitifs: 0 });
    expect(brevo.appels).toHaveLength(1);
    const [appel] = brevo.appels;
    const jeton = /#jeton=([A-Za-z0-9_-]{43})/.exec(appel?.corps.textContent ?? '')?.[1] ?? '';
    expect(jeton).toHaveLength(43);
    expect(appel?.methode).toBe('POST');
    expect(appel?.url).toBe('/v3/smtp/email');
    expect(appel?.entetes['api-key']).toBe(CLE);
    expect(appel?.entetes['content-type']).toBe('application/json');
    expect(appel?.corps.sender).toEqual({ email: 'no-reply@attroupe.test', name: 'Attroupe' });
    expect(appel?.corps.to).toEqual([{ email: 'alice@exemple.test' }]);
    expect(appel?.corps.subject).toBe('Confirmez votre adresse e-mail');
    expect(appel?.corps.textContent).toContain('Bonjour Alice <b>,');
    expect(appel?.corps.textContent).toContain(`https://attroupe.test/verification-email#jeton=${jeton}`);
    expect(appel?.corps.textContent).not.toMatch(/\{\w+\}/); // aucune variable de gabarit restée telle quelle
    expect(appel?.corps.htmlContent).toContain('Bonjour Alice &lt;b&gt;,'); // le HTML est échappé
    // Le lien est désormais un bouton (styles en ligne : un e-mail n'a pas de feuille de style), et l'adresse
    // est rappelée en toutes lettres plus bas pour qui n'a pas le bouton.
    const lien = `https://attroupe.test/verification-email#jeton=${jeton}`;
    expect(appel?.corps.htmlContent).toContain(`<a href="${lien}" style="display:inline-block;`);
    expect(appel?.corps.htmlContent).toContain('Confirmer mon adresse</a>');
    expect(appel?.corps.htmlContent).toContain('Si le bouton ne fonctionne pas');
    expect(appel?.corps.htmlContent).toContain('src="https://attroupe.test/icons/logo.png"');

    const ligne = file();
    expect(ligne.status).toBe('sent');
    expect(ligne.provider_message_id).toBe('<faux-1@brevo.test>');
    expect(ligne.sent_at).toBe('2026-11-15T12:00:00Z');
    expect(ligne.payload_json).toBe('{}'); // le lien à jeton ne reste pas en base

    expect(await remettre()).toEqual({ envoyes: 0, reportes: 0, abandonnes: 0, definitifs: 0 });
    expect(brevo.appels).toHaveLength(1);

    // Le lien reçu est bien celui que la base reconnaît : le jeton tiré à l'envoi consomme la vérification.
    expect((await d.client().post('/api/auth/email/verification', { token: jeton })).statut).toBe(200);
    expect(d.sql.prepare("SELECT email_verified_at FROM users WHERE username = 'alice_m'").pluck().get()).not.toBeNull();
  });

  it('une panne (500) laisse l’e-mail en file avec report ; au rétablissement il part', async () => {
    await d.client().post('/api/auth/mot-de-passe/oubli', { email: 'x@exemple.test' }); // inconnue : rien en file
    await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    brevo.mode = 'panne_500';

    expect(await remettre()).toEqual({ envoyes: 0, reportes: 1, abandonnes: 0, definitifs: 0 });
    expect(file()).toMatchObject({ status: 'pending', attempts: 1, last_error: 'Brevo a répondu 500', next_attempt_at: '2026-11-15T12:01:00Z' });
    expect(file().payload_json).toContain('jeton_id'); // l'e-mail est intact, prêt à repartir (avec un jeton neuf)

    // Pas encore dû : aucun nouvel appel, même si Brevo est revenu.
    brevo.mode = 'ok';
    expect(await remettre()).toEqual({ envoyes: 0, reportes: 0, abandonnes: 0, definitifs: 0 });
    expect(brevo.appels).toHaveLength(1);

    d.temps.avancer(MINUTE_MS);
    expect(await remettre()).toEqual({ envoyes: 1, reportes: 0, abandonnes: 0, definitifs: 0 });
    expect(file()).toMatchObject({ status: 'sent', attempts: 1, last_error: null });
    expect(brevo.appels).toHaveLength(2);
  });

  it('un délai dépassé est réessayé ; la clé d’API n’apparaît jamais dans l’erreur conservée', async () => {
    await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    brevo.mode = 'lent';
    expect(await remettre()).toMatchObject({ reportes: 1 });
    expect(file()).toMatchObject({ status: 'pending', attempts: 1, last_error: 'délai dépassé' });
    brevo.mode = 'ok';
    d.temps.avancer(MINUTE_MS);
    expect(await remettre()).toMatchObject({ envoyes: 1 });
  });

  it('un serveur injoignable est réessayé comme une panne', async () => {
    await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    const morte = creerTransporteurBrevo({ apiKey: CLE, expediteurEmail: 'no-reply@attroupe.test', expediteurNom: 'Attroupe', urlApi: 'http://127.0.0.1:1/v3', delaiMs: 300 });
    expect(await remettreFile(d.base, morte, d.temps.maintenant(), ORIGINE)).toMatchObject({ reportes: 1 });
    expect(file()).toMatchObject({ status: 'pending', last_error: 'réseau indisponible' });
    expect(JSON.stringify(file())).not.toContain(CLE);
  });

  it('suit le report exponentiel 1 min, 5 min, 25 min, 2 h, 12 h puis abandonne au 6e échec', async () => {
    await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    brevo.mode = 'panne_500';
    expect(REPORTS_MS).toEqual([MINUTE_MS, 5 * MINUTE_MS, 25 * MINUTE_MS, 2 * HEURE_MS, 12 * HEURE_MS]);
    expect(ESSAIS_MAX).toBe(6);
    for (const [i, attendu] of REPORTS_MS.entries()) {
      const avant = d.temps.maintenant().getTime();
      expect(await remettre()).toMatchObject({ reportes: 1 });
      const ligne = file();
      expect(ligne.attempts).toBe(i + 1);
      expect(new Date(ligne.next_attempt_at).getTime() - avant).toBe(attendu);
      d.temps.avancer(attendu);
    }
    expect(await remettre()).toEqual({ envoyes: 0, reportes: 0, abandonnes: 1, definitifs: 0 });
    expect(file()).toMatchObject({ status: 'abandoned', attempts: 6, last_error: 'Brevo a répondu 500', payload_json: '{}' });
    d.temps.avancer(24 * HEURE_MS);
    brevo.mode = 'ok';
    expect(await remettre()).toMatchObject({ envoyes: 0 }); // abandonné : on n'y revient plus
    expect(brevo.appels).toHaveLength(6);
  });

  it('une clé refusée (401) ne consomme AUCUN essai : l’e-mail attend, même au-delà du plafond, et part au rétablissement', async () => {
    await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    brevo.mode = 'cle_refusee_401';
    for (let i = 0; i < ESSAIS_MAX + 4; i++) {
      expect(await remettre()).toEqual({ envoyes: 0, reportes: 1, abandonnes: 0, definitifs: 0 });
      expect(file()).toMatchObject({ status: 'pending', attempts: 0, last_error: 'Brevo a répondu 401' });
      d.temps.avancer(REPORT_CONFIGURATION_MS);
    }
    brevo.mode = 'ok';
    expect(await remettre()).toMatchObject({ envoyes: 1 });
    expect(file()).toMatchObject({ status: 'sent', attempts: 0 });
  });

  it('un 403 est traité comme un 401 ; un 429 ou un 500, eux, consomment un essai', async () => {
    const transporteur403: Transporteur = { envoyer: () => Promise.reject(new ErreurTransport('Brevo a répondu 403', false, true)) };
    await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    await remettreFile(d.base, transporteur403, d.temps.maintenant(), ORIGINE);
    expect(file()).toMatchObject({ status: 'pending', attempts: 0 });
    d.temps.avancer(REPORT_CONFIGURATION_MS);
    brevo.mode = 'panne_500';
    await remettre();
    expect(file()).toMatchObject({ status: 'pending', attempts: 1 });
  });

  it('une requête refusée (400) est un échec définitif, sans réessai', async () => {
    await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    brevo.mode = 'refus_400';
    d.temps.avancer(MINUTE_MS);
    expect(await remettre()).toEqual({ envoyes: 0, reportes: 0, abandonnes: 0, definitifs: 1 });
    expect(file()).toMatchObject({ status: 'failed', last_error: 'Brevo a répondu 400' });
    brevo.mode = 'ok';
    d.temps.avancer(24 * HEURE_MS);
    expect(await remettre()).toMatchObject({ envoyes: 0 });
  });

  describe('le jeton naît à l’envoi : la file n’en contient jamais en clair', () => {
    const jetonDe = (texte: string | undefined): string => /#jeton=([A-Za-z0-9_-]{43})/.exec(texte ?? '')?.[1] ?? '';
    const ligneJeton = (table: 'email_verification_tokens' | 'password_reset_tokens'): { token_hash: string; expires_at: string; created_at: string; used_at: string | null } =>
      d.sql.prepare(`SELECT token_hash, expires_at, created_at, used_at FROM ${table}`).get() as never;

    it('une ligne en attente ne porte qu’un identifiant ; la ligne de jeton est inerte jusqu’à l’envoi', async () => {
      await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
      const attente = file();
      expect(attente.status).toBe('pending');
      expect(JSON.parse(attente.payload_json)).toEqual({ nom: 'alice_m', jeton_id: expect.any(String) });
      expect(attente.payload_json).not.toMatch(/jeton=|https?:|[A-Za-z0-9_-]{43}/);
      // Inerte : rien ne peut la consommer, elle a « expiré » à sa création.
      expect(ligneJeton('email_verification_tokens').expires_at).toBe(ligneJeton('email_verification_tokens').created_at);
      expect((await d.client().post('/api/auth/email/verification', { token: 'A'.repeat(43) })).statut).toBe(400);
    });

    it('la validité part de l’ENVOI : un lien envoyé tard vit toute sa durée', async () => {
      await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
      brevo.mode = 'panne_500';
      await remettre();
      d.temps.avancer(2 * HEURE_MS); // l'e-mail dort, puis Brevo revient
      brevo.mode = 'ok';
      d.temps.avancer(10 * HEURE_MS);
      expect(await remettre()).toMatchObject({ envoyes: 1 });
      const jeton = jetonDe(brevo.appels.at(-1)?.corps.textContent);
      expect(ligneJeton('email_verification_tokens').expires_at).toBe('2026-11-17T00:00:00Z'); // envoi le 16 à 00 h 00 + 24 h
      d.temps.avancer(23 * HEURE_MS); // 23 h le 16 : au-delà des 24 h depuis la demande, en deçà des 24 h depuis l'envoi
      expect((await d.client().post('/api/auth/email/verification', { token: jeton })).statut).toBe(200);
    });

    it('une demande trop ancienne n’est pas envoyée (clé Brevo absente pendant des jours), et la file ne garde rien', async () => {
      await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
      d.temps.avancer(25 * HEURE_MS);
      expect(await remettre()).toEqual({ envoyes: 0, reportes: 0, abandonnes: 0, definitifs: 1 });
      expect(brevo.appels).toHaveLength(0);
      expect(file()).toMatchObject({ status: 'failed', payload_json: '{}' });
    });

    it('une demande de réinitialisation remplacée ou déjà utilisée n’est pas envoyée ; seule la dernière part', async () => {
      await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
      await remettre(); // vérification partie
      await d.client().post('/api/auth/mot-de-passe/oubli', { email: 'alice@exemple.test' });
      await d.client().post('/api/auth/mot-de-passe/oubli', { email: 'alice@exemple.test' });
      expect(await remettre()).toEqual({ envoyes: 1, reportes: 0, abandonnes: 0, definitifs: 1 });
      expect(d.mails('alice@exemple.test').map((m) => m.status)).toEqual(['sent', 'failed', 'sent']);
    });

    it('un lien de réinitialisation envoyé vaut 1 h à partir de l’envoi, pas de la demande', async () => {
      await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
      await remettre();
      await d.client().post('/api/auth/mot-de-passe/oubli', { email: 'alice@exemple.test' });
      brevo.mode = 'panne_500';
      await remettre();
      d.temps.avancer(MINUTE_MS);
      brevo.mode = 'ok';
      expect(await remettre()).toMatchObject({ envoyes: 1 });
      const jeton = jetonDe(brevo.appels.at(-1)?.corps.textContent);
      d.temps.avancer(59 * MINUTE_MS);
      expect((await d.client().post('/api/auth/mot-de-passe/reinitialisation', { token: jeton, password: 'un-tout-nouveau-mot-de-passe' })).statut).toBe(200);
    });

    it('une adresse déjà vérifiée entre-temps : le mail de vérification en attente ne part pas', async () => {
      await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
      d.sql.prepare("UPDATE users SET email_verified_at = '2026-11-15T12:00:00Z'").run();
      expect(await remettre()).toEqual({ envoyes: 0, reportes: 0, abandonnes: 0, definitifs: 1 });
      expect(brevo.appels).toHaveLength(0);
    });
  });

  it('un gabarit inconnu est un échec définitif, il ne bloque pas les autres e-mails', async () => {
    enfilerEmail(d.base, { to: 'x@exemple.test', templateKey: 'inexistant', payload: {} }, '2026-11-15T11:00:00Z');
    await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    expect(await remettre()).toEqual({ envoyes: 1, reportes: 0, abandonnes: 0, definitifs: 1 });
    expect(d.sql.prepare("SELECT status, last_error FROM email_outbox WHERE to_email = 'x@exemple.test'").get()).toEqual({
      status: 'failed',
      last_error: "Gabarit d'e-mail inconnu : « inexistant ».",
    });
  });

  it('deux remises simultanées n’envoient pas deux fois le même e-mail', async () => {
    await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    const [a, b] = await Promise.all([remettre(), remettre()]);
    expect(a.envoyes + b.envoyes).toBe(1);
    expect(brevo.appels).toHaveLength(1);
  });

  it('un e-mail pris en charge puis perdu (arrêt en pleine remise) est repris après le bail', async () => {
    await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    const lent: Transporteur = { envoyer: () => new Promise(() => undefined) }; // ne rend jamais la main : le processus « s'arrête » ici
    void remettreFile(d.base, lent, d.temps.maintenant(), ORIGINE);
    await new Promise((r) => setTimeout(r, 20));
    expect(file().attempts).toBe(0);
    expect(await remettre()).toMatchObject({ envoyes: 0 }); // encore sous bail
    d.temps.avancer(3 * MINUTE_MS);
    expect(await remettre()).toMatchObject({ envoyes: 1 });
  });

  it('la tâche périodique écoule la file toute seule : panne, puis rétablissement', async () => {
    await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    brevo.mode = 'panne_500';
    const taches = demarrerTaches({ base: d.base, transporteur, journal: JOURNAL_SILENCIEUX, baseUrl: ORIGINE, horloge: d.temps.horloge, intervalleFileMs: 20 });
    const attendre = async (condition: () => boolean): Promise<void> => {
      for (let i = 0; i < 100 && !condition(); i++) await new Promise((r) => setTimeout(r, 20));
      expect(condition()).toBe(true);
    };
    try {
      await attendre(() => file().attempts === 1);
      expect(file().status).toBe('pending');
      brevo.mode = 'ok';
      d.temps.avancer(MINUTE_MS);
      await attendre(() => file().status === 'sent');
    } finally {
      await taches.arreter();
    }
  });

  it('sans clé Brevo : l’application fonctionne, signale l’état, et les e-mails restent en file', async () => {
    const r = await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    expect(r.statut).toBe(202);
    const taches = demarrerTaches({ base: d.base, transporteur: undefined, journal: JOURNAL_SILENCIEUX, baseUrl: ORIGINE, horloge: d.temps.horloge, intervalleFileMs: 20 });
    await taches.remettreMaintenant();
    await taches.arreter();
    expect(file()).toMatchObject({ status: 'pending', attempts: 0 });
    const alice = d.client();
    await alice.post('/api/auth/connexion', { email: 'alice@exemple.test', password: MOT_DE_PASSE });
    expect((await alice.get('/api/moi')).corps['service_email']).toBe('non_configure');
  });

  it('avec une clé Brevo, /api/moi le dit', async () => {
    d.nettoyer();
    d = decor({}, { BREVO_API_KEY: 'xkeysib-test', BREVO_SENDER_EMAIL: 'no-reply@attroupe.test' });
    await d.client().post('/api/auth/inscription', { email: 'alice@exemple.test', username: 'alice_m', password: MOT_DE_PASSE });
    const alice = d.client();
    await alice.post('/api/auth/connexion', { email: 'alice@exemple.test', password: MOT_DE_PASSE });
    expect((await alice.get('/api/moi')).corps['service_email']).toBe('actif');
  });
});
