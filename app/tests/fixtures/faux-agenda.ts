import { createServer, request, IncomingMessage, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Socket } from 'node:net';
import type { DependancesAgenda } from '../../server/services/agenda-externe.js';

// Faux serveur d'agenda ICS local, et les doubles qui y branchent le service de synchronisation. La vérification d'adresse reste
// la VRAIE (`resoudreEtVerifier`, `autoriserPrive: false`) : seul le DNS est remplacé par une adresse publique, et seule la connexion
// finale est redirigée vers le serveur local. Ainsi le chemin de production est exercé, sauf le dernier saut réseau.

export interface AppelAgenda {
  readonly chemin: string;
  readonly entetes: IncomingHttpHeaders;
}

export interface ReponseAgenda {
  readonly statut: number;
  readonly corps: string | Buffer;
  readonly entetes: Record<string, string>;
}

export interface FauxAgenda {
  readonly appels: AppelAgenda[];
  /** URL (https, port 443) que le service CROIT appeler : à saisir dans les tests. */
  readonly url: string;
  /** Ce que le service a réellement demandé (`https://…`), côté code de production. */
  readonly urlsDemandees: string[];
  reponse: ReponseAgenda;
  /** Remplace la réponse : le gestionnaire écrit lui-même (flux lent, très gros, interrompu…). */
  gestionnaire: ((req: import('node:http').IncomingMessage, res: ServerResponse) => void) | undefined;
  readonly dependances: DependancesAgenda;
  readonly arreter: () => Promise<void>;
}

export const HOTE_PUBLIC_FICTIF = 'agenda.exemple.org';
export const ADRESSE_PUBLIQUE_FICTIVE = '93.184.216.34';

export const ICS_UN_EVENEMENT = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//FR',
  'BEGIN:VEVENT',
  'UID:u1@test',
  'DTSTART:20261120T100000Z',
  'DTEND:20261120T110000Z',
  'SUMMARY:Secret médical',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

export const ICS_VIDE = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//FR', 'END:VCALENDAR', ''].join('\r\n');

export async function demarrerFauxAgenda(): Promise<FauxAgenda> {
  const appels: AppelAgenda[] = [];
  const urlsDemandees: string[] = [];
  const etat: { reponse: ReponseAgenda; gestionnaire: FauxAgenda['gestionnaire'] } = {
    reponse: { statut: 200, corps: ICS_UN_EVENEMENT, entetes: { 'content-type': 'text/calendar', etag: '"v1"' } },
    gestionnaire: undefined,
  };
  const connexions = new Set<Socket>();
  const serveur: Server = createServer((req, res) => {
    appels.push({ chemin: req.url ?? '', entetes: req.headers });
    req.resume();
    if (etat.gestionnaire !== undefined) {
      etat.gestionnaire(req, res);
      return;
    }
    res.writeHead(etat.reponse.statut, etat.reponse.entetes).end(etat.reponse.corps);
  });
  serveur.on('connection', (s) => {
    connexions.add(s);
    s.on('close', () => connexions.delete(s));
  });
  await new Promise<void>((resolu) => serveur.listen(0, '127.0.0.1', resolu));
  const { port } = serveur.address() as AddressInfo;

  const dependances: DependancesAgenda = {
    dnsLookup: () => Promise.resolve([{ address: ADRESSE_PUBLIQUE_FICTIVE, family: 4 }]),
    envoyer: (requete) =>
      new Promise<IncomingMessage>((resolu, rejeter) => {
        urlsDemandees.push(requete.url.href);
        const req = request(
          { host: '127.0.0.1', port, path: `${requete.url.pathname}${requete.url.search}`, method: 'GET', headers: requete.headers, signal: requete.signal, agent: false },
          resolu,
        );
        const inactivite = requete.inactivite;
        if (inactivite !== undefined) req.setTimeout(inactivite.delaiMs, () => req.destroy(new Error(inactivite.message)));
        req.on('error', rejeter);
        req.end();
      }),
  };

  return {
    appels,
    urlsDemandees,
    url: `https://${HOTE_PUBLIC_FICTIF}/prive/calendrier.ics`,
    get reponse() {
      return etat.reponse;
    },
    set reponse(r: ReponseAgenda) {
      etat.reponse = r;
    },
    get gestionnaire() {
      return etat.gestionnaire;
    },
    set gestionnaire(g: FauxAgenda['gestionnaire']) {
      etat.gestionnaire = g;
    },
    dependances,
    arreter: () =>
      new Promise<void>((resolu) => {
        for (const s of connexions) s.destroy();
        serveur.close(() => resolu());
      }),
  };
}

/** Doubles sans aucun serveur : la réponse est fabriquée en mémoire (décor de la suite de cloisonnement, qui ne gère pas d'arrêt asynchrone). */
export function agendaEnMemoire(corps: string = ICS_UN_EVENEMENT): DependancesAgenda {
  return {
    dnsLookup: () => Promise.resolve([{ address: ADRESSE_PUBLIQUE_FICTIVE, family: 4 }]),
    envoyer: () => {
      const reponse = new IncomingMessage(new Socket());
      reponse.statusCode = 200;
      reponse.complete = true;
      reponse.headers = { 'content-type': 'text/calendar', etag: '"mem"' };
      reponse.push(Buffer.from(corps, 'utf8'));
      reponse.push(null);
      return Promise.resolve(reponse);
    },
  };
}
