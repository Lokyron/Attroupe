import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Faux serveur Brevo local (aucune clé d'API réelle n'existe pour les tests) : il enregistre les appels
// reçus et répond selon un mode qu'un test change à volonté — c'est ainsi qu'on simule une panne puis un rétablissement.

export type ModeBrevo = 'ok' | 'panne_500' | 'refus_400' | 'cle_refusee_401' | 'lent';

export interface AppelBrevo {
  readonly methode: string;
  readonly url: string;
  readonly entetes: IncomingHttpHeaders;
  readonly corps: {
    sender: { email: string; name: string };
    to: Array<{ email: string }>;
    subject: string;
    textContent: string;
    htmlContent: string;
  };
}

export interface FauxBrevo {
  readonly url: string;
  readonly appels: AppelBrevo[];
  mode: ModeBrevo;
  readonly arreter: () => Promise<void>;
}

export async function demarrerFauxBrevo(): Promise<FauxBrevo> {
  const appels: AppelBrevo[] = [];
  const faux: { mode: ModeBrevo } = { mode: 'ok' };
  const connexions = new Set<import('node:net').Socket>();
  const serveur: Server = createServer((req, res) => {
    const morceaux: Buffer[] = [];
    req.on('data', (m: Buffer) => morceaux.push(m));
    req.on('end', () => {
      appels.push({
        methode: req.method ?? '',
        url: req.url ?? '',
        entetes: req.headers,
        corps: JSON.parse(Buffer.concat(morceaux).toString('utf8')) as AppelBrevo['corps'],
      });
      const repondre = (statut: number, corps: object): void => {
        res.writeHead(statut, { 'content-type': 'application/json' }).end(JSON.stringify(corps));
      };
      if (faux.mode === 'ok') repondre(201, { messageId: `<faux-${String(appels.length)}@brevo.test>` });
      else if (faux.mode === 'panne_500') repondre(500, { code: 'internal_server_error' });
      else if (faux.mode === 'refus_400') repondre(400, { code: 'invalid_parameter' });
      else if (faux.mode === 'cle_refusee_401') repondre(401, { code: 'unauthorized' });
      // 'lent' : on ne répond jamais, le client doit abandonner au délai.
    });
  });
  serveur.on('connection', (s) => {
    connexions.add(s);
    s.on('close', () => connexions.delete(s));
  });
  await new Promise<void>((resolu) => serveur.listen(0, '127.0.0.1', resolu));
  const { port } = serveur.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/v3`,
    appels,
    get mode() {
      return faux.mode;
    },
    set mode(m: ModeBrevo) {
      faux.mode = m;
    },
    arreter: () =>
      new Promise<void>((resolu) => {
        for (const s of connexions) s.destroy();
        serveur.close(() => resolu());
      }),
  };
}
