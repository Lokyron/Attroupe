import request from 'supertest';
import type { Express } from 'express';
import fr from '../../server/i18n/fr.json' with { type: 'json' };
import { creerApp, type OptionsApp } from '../../server/http/app.js';
import { remettreFile, type BilanRemise, type MessageSortant, type Transporteur } from '../../server/services/brevo.js';
import type { Horloge } from '../../server/services/cadence.js';
import { baseTemporaire, type BaseTemporaire } from './base.js';
import { envValide } from './env.js';

// Décor des tests du lot 2 : une application montée sur une base de fichier temporaire, une horloge qu'on
// avance à la main, un hachage léger (le coût de production — 32 Mio, ~100 ms — ne sert à rien ici) et un
// client HTTP qui garde son cookie comme un navigateur.

export const ORIGINE = 'https://attroupe.test';
export const MOT_DE_PASSE = 'correct-cheval-pile-agrafe';
export const SCRYPT_LEGER = { N: 1024, r: 8, p: 1 } as const;

export interface HorlogeTest {
  readonly horloge: Horloge;
  readonly avancer: (ms: number) => void;
  readonly maintenant: () => Date;
}

export function horlogeTest(depart = '2026-11-15T12:00:00Z'): HorlogeTest {
  let instant = new Date(depart).getTime();
  return {
    horloge: () => new Date(instant),
    avancer: (ms) => {
      instant += ms;
    },
    maintenant: () => new Date(instant),
  };
}

export interface Decor extends BaseTemporaire {
  readonly app: Express;
  readonly temps: HorlogeTest;
  readonly client: (adresse?: string) => Client;
  /** Messages remis par `remettre` (un transporteur qui n'envoie rien : il les garde). */
  readonly envoyes: readonly MessageSortant[];
  /** Écoule la file d'e-mails vers ce transporteur-témoin. Le jeton n'existe qu'à partir de là : la file n'en contient pas. */
  readonly remettre: () => Promise<BilanRemise>;
  /** Jeton du dernier e-mail de ce gabarit remis à cette adresse (écoule d'abord la file). */
  readonly jetonMail: (to: string, gabarit: 'verification_email' | 'reinitialisation_mot_de_passe' | 'invitation_groupe') => Promise<string>;
  readonly mails: (to: string) => Array<{ template_key: string; status: string; payload_json: string }>;
}

export function decor(surcharges: Partial<OptionsApp> = {}, env: NodeJS.ProcessEnv = {}): Decor {
  const t = baseTemporaire();
  const temps = horlogeTest();
  const app = creerApp({
    env: envValide({ ATTROUPE_BASE_URL: ORIGINE, ...env }),
    version: '0.0.0-test',
    base: t.base,
    horloge: temps.horloge,
    parametresScrypt: SCRYPT_LEGER,
    delaiMinimalOubliMs: 0,
    ...surcharges,
  });
  const mails = (to: string): Array<{ template_key: string; status: string; payload_json: string }> =>
    t.sql.prepare('SELECT template_key, status, payload_json FROM email_outbox WHERE to_email = ? ORDER BY created_at, id').all(to) as Array<{
      template_key: string;
      status: string;
      payload_json: string;
    }>;
  const envoyes: MessageSortant[] = [];
  const temoin: Transporteur = {
    envoyer: (message) => {
      envoyes.push(message);
      return Promise.resolve({ messageId: null });
    },
  };
  const remettre = (): Promise<BilanRemise> => remettreFile(t.base, temoin, temps.maintenant(), ORIGINE);
  return {
    ...t,
    app,
    temps,
    client: (adresse) => new Client(app, adresse),
    mails,
    envoyes,
    remettre,
    jetonMail: async (to, gabarit) => {
      await remettre();
      // Le sujet d'une invitation porte le nom du groupe : on compare ce qui précède le premier `{variable}` du gabarit.
      const debutSujet = fr.emails[gabarit].sujet.split('{')[0] ?? '';
      const message = envoyes.filter((m) => m.to === to && m.sujet.startsWith(debutSujet)).at(-1);
      if (message === undefined) throw new Error(`Aucun e-mail « ${gabarit} » remis à ${to}`);
      const jeton = /#jeton=([A-Za-z0-9_-]{43})/.exec(message.texte)?.[1];
      if (jeton === undefined) throw new Error('Message sans jeton');
      return jeton;
    },
  };
}

export interface Reponse {
  readonly statut: number;
  readonly corps: Record<string, unknown>;
  readonly entetes: Record<string, string | string[] | undefined>;
  readonly cookies: string[];
}

/** Client HTTP minimal : cookie conservé, `Origin` de l'instance par défaut, adresse simulée par X-Forwarded-For. */
export class Client {
  cookie: string | undefined;

  constructor(
    private readonly app: Express,
    private readonly adresse: string = '203.0.113.7',
  ) {}

  async envoyer(
    methode: 'get' | 'post' | 'put' | 'patch' | 'delete',
    chemin: string,
    corps?: unknown,
    options: { origine?: string | null; cookie?: string | null } = {},
  ): Promise<Reponse> {
    let r = request(this.app)[methode](chemin).set('X-Forwarded-For', this.adresse).set('User-Agent', 'Test/1.0 (Appareil A)');
    const origine = options.origine === undefined ? ORIGINE : options.origine;
    if (origine !== null) r = r.set('Origin', origine);
    const cookie = options.cookie === undefined ? this.cookie : (options.cookie ?? undefined);
    if (cookie !== undefined) r = r.set('Cookie', cookie);
    if (corps !== undefined) r = r.send(corps as object);
    const reponse = await r;
    const posts = (reponse.headers['set-cookie'] ?? []) as unknown as string[];
    for (const c of posts) {
      const [paire = ''] = c.split(';');
      if (paire.startsWith('attroupe_session=')) this.cookie = paire.endsWith('=') ? undefined : paire;
    }
    return { statut: reponse.status, corps: reponse.body as Record<string, unknown>, entetes: reponse.headers, cookies: posts };
  }

  get = (chemin: string, options?: Parameters<Client['envoyer']>[3]): Promise<Reponse> => this.envoyer('get', chemin, undefined, options);
  post = (chemin: string, corps?: unknown, options?: Parameters<Client['envoyer']>[3]): Promise<Reponse> => this.envoyer('post', chemin, corps ?? {}, options);
  put = (chemin: string, corps?: unknown, options?: Parameters<Client['envoyer']>[3]): Promise<Reponse> => this.envoyer('put', chemin, corps ?? {}, options);
  patch = (chemin: string, corps: unknown, options?: Parameters<Client['envoyer']>[3]): Promise<Reponse> => this.envoyer('patch', chemin, corps, options);
  delete = (chemin: string, options?: Parameters<Client['envoyer']>[3]): Promise<Reponse> => this.envoyer('delete', chemin, undefined, options);
}

/** Inscrit (et, si demandé, connecte) un compte ; renvoie son client. */
export async function inscrireEtConnecter(d: Decor, email: string, username: string, adresse?: string): Promise<Client> {
  const c = d.client(adresse);
  const inscription = await c.post('/api/auth/inscription', { email, username, password: MOT_DE_PASSE });
  if (inscription.statut !== 202) throw new Error(`Inscription refusée : ${JSON.stringify(inscription.corps)}`);
  const connexion = await c.post('/api/auth/connexion', { email, password: MOT_DE_PASSE });
  if (connexion.statut !== 200) throw new Error(`Connexion refusée : ${JSON.stringify(connexion.corps)}`);
  return c;
}
