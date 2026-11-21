import { Agent, createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
//
// Le décor n'écoute qu'une fois. Appelé avec une fonction Express, `supertest` monte un vrai serveur TCP
// *par requête* : la suite de cloisonnement en émettait 16 251, donc 16 251 sockets laissés 30 s en
// `TIME_WAIT` pour les 16 384 ports éphémères de macOS (49152-65535). Trois tests sont déjà tombés en
// `EADDRNOTAVAIL` parce que deux requêtes avaient été ajoutées à un décor. Ici le serveur est monté au
// premier appel, partagé par tous les clients du décor, fermé dans `nettoyer()`, et l'agent `keepAlive`
// réutilise la connexion au lieu d'en ouvrir une par requête.

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
  // Serveur d'écoute unique, monté paresseusement : un décor qui ne fait aucune requête HTTP n'ouvre rien.
  let serveur: Server | undefined;
  let origine: Promise<string> | undefined;
  let decorFerme = false;
  // `maxSockets` est plafonné, et la valeur n'est pas arbitraire — elle est encadrée des deux côtés :
  //  - EN HAUT par `kern.ipc.somaxconn`, qui vaut 128 sur macOS : une rafale de 384 connexions simultanées
  //    (`listes-concurrence`) déborde la file d'acceptation du serveur — que better-sqlite3, synchrone, n'a pas le
  //    temps de vider — et le noyau répond alors par un RST, soit un `ECONNRESET` côté test ;
  //  - EN BAS par les tests qui ont besoin d'une vraie simultanéité pour prouver quelque chose. Le plus exigeant est
  //    `auth-securite` (« la file de hachage pleine ne débite pas la cadence »), qui lance 80 connexions d'un coup.
  //    Le seuil qu'il doit franchir est de **37 requêtes en vol** (`MAX_PARALLELE` 4 + `MAX_EN_ATTENTE` 32, puis une
  //    de plus, cf. `app/server/services/mot-de-passe.ts`) : plafonner en dessous mettrait ces requêtes en file côté
  //    client, le 503 attendu ne se produirait jamais, et la preuve deviendrait verte sans rien prouver. 80 laisse
  //    donc une marge confortable — ce n'est pas le nombre de requêtes du test qu'il faut suivre, mais ce seuil-là.
  // Au-delà de 80, l'agent met en file côté client, ce qui est sans danger ailleurs : dans un seul processus les
  // écritures SQLite se font de toute façon à la queue leu leu, et aucune requête passée par ce client n'attend
  // qu'une autre soit en vol (les flux SSE, seuls à ne jamais se terminer, ont leur serveur dans `flux-sse.ts`).
  const agent = new Agent({ keepAlive: true, maxSockets: 80, maxFreeSockets: 16 });
  const origineLocale = (): Promise<string> => {
    origine ??= new Promise<string>((resolu, rejeter) => {
      const s = createServer(app);
      serveur = s;
      s.once('error', rejeter);
      s.listen(0, '127.0.0.1', () => {
        // Une erreur APRÈS l'écoute ne doit pas tomber dans une promesse déjà résolue, où elle disparaîtrait
        // sans bruit : un `EMFILE` à l'`accept` (descripteurs épuisés) ressortirait alors en `ECONNRESET` ou
        // en dépassement de délai, bien plus loin, sans indice sur sa cause. On la relance donc, sauf après
        // `nettoyer()` où une erreur de fermeture n'intéresse personne.
        s.off('error', rejeter);
        s.on('error', (erreur) => {
          if (!decorFerme) throw erreur;
        });
        // Sans `unref`, un décor dont `nettoyer()` n'est pas appelé retiendrait le processus de test.
        s.unref();
        resolu(`http://127.0.0.1:${(s.address() as AddressInfo).port}`);
      });
    });
    return origine;
  };

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
    client: (adresse) => new Client(app, origineLocale, agent, adresse),
    mails,
    envoyes,
    remettre,
    nettoyer: () => {
      decorFerme = true;
      agent.destroy();
      serveur?.closeAllConnections();
      serveur?.close();
      t.nettoyer();
    },
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
  /** Corps textuel brut (flux iCal : `text/calendar` n'est pas du JSON, `corps` est alors vide). */
  readonly texte: string;
}

/** Client HTTP minimal : cookie conservé, `Origin` de l'instance par défaut, adresse simulée par X-Forwarded-For. */
export class Client {
  cookie: string | undefined;

  constructor(
    readonly app: Express,
    private readonly origineLocale: () => Promise<string>,
    private readonly agent: Agent,
    private readonly adresse: string = '203.0.113.7',
  ) {}

  async envoyer(
    methode: 'get' | 'post' | 'put' | 'patch' | 'delete',
    chemin: string,
    corps?: unknown,
    options: { origine?: string | null; cookie?: string | null; entetes?: Readonly<Record<string, string>> } = {},
  ): Promise<Reponse> {
    // On vise le serveur déjà à l'écoute (une chaîne, pas la fonction Express) : c'est ce qui évite un serveur par requête.
    let r = request(await this.origineLocale())[methode](chemin)
      .agent(this.agent)
      .set('X-Forwarded-For', this.adresse)
      .set('User-Agent', 'Test/1.0 (Appareil A)');
    const origine = options.origine === undefined ? ORIGINE : options.origine;
    if (origine !== null) r = r.set('Origin', origine);
    const cookie = options.cookie === undefined ? this.cookie : (options.cookie ?? undefined);
    if (cookie !== undefined) r = r.set('Cookie', cookie);
    for (const [nom, valeur] of Object.entries(options.entetes ?? {})) r = r.set(nom, valeur);
    if (corps !== undefined) r = r.send(corps as object);
    const reponse = await r;
    const posts = (reponse.headers['set-cookie'] ?? []) as unknown as string[];
    for (const c of posts) {
      const [paire = ''] = c.split(';');
      if (paire.startsWith('attroupe_session=')) this.cookie = paire.endsWith('=') ? undefined : paire;
    }
    return { statut: reponse.status, corps: reponse.body as Record<string, unknown>, entetes: reponse.headers, cookies: posts, texte: reponse.text };
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
