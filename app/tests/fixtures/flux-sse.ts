import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { EvenementTempsReel } from '../../server/services/temps-reel.js';
import { ORIGINE, type Client, type Reponse } from './comptes.js';

// Un vrai client SSE pour les tests du lot 6. Supertest ne sait pas lire un flux qui ne se termine jamais : ici l'application écoute sur un
// port éphémère (127.0.0.1) et chaque flux est une vraie requête HTTP dont on lit les blocs au fil de l'eau.

export interface FluxOuvert {
  readonly statut: number;
  readonly entetes: IncomingMessage['headers'];
  /** Messages `data:` reçus, dans l'ordre (le battement et les commentaires n'y figurent pas). */
  readonly evenements: EvenementTempsReel[];
  /** Tout ce que le serveur a écrit, tel quel. */
  readonly brut: () => string;
  /** Résolue quand le serveur (ou le client) a fermé le flux. */
  readonly ferme: Promise<void>;
  readonly estFerme: () => boolean;
  /** Attend qu'un événement vérifie `predicat` (ou échoue au délai, en disant ce qui a été reçu). */
  readonly attendre: (predicat: (e: EvenementTempsReel) => boolean, delaiMs?: number) => Promise<EvenementTempsReel>;
  /** Ferme côté client. */
  readonly fermer: () => void;
}

export interface ServeurFlux {
  readonly ouvrir: (client: Client, groupId: string) => Promise<FluxOuvert>;
  /** Ferme les flux encore ouverts et le serveur. */
  readonly arreter: () => Promise<void>;
}

const pause = (ms: number): Promise<void> => new Promise((resolu) => setTimeout(resolu, ms));

function analyser(brut: string): EvenementTempsReel[] {
  const evenements: EvenementTempsReel[] = [];
  for (const bloc of brut.split('\n\n')) {
    const data = bloc
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6))
      .join('\n');
    if (data !== '') evenements.push(JSON.parse(data) as EvenementTempsReel);
  }
  return evenements;
}

/** Ouvre le flux d'un client sur un serveur déjà à l'écoute ; résout dès les en-têtes (et le premier octet) reçus. */
function ouvrirSur(port: number, client: Client, chemin: string): Promise<FluxOuvert> {
  return new Promise((resolu, rejeter) => {
    const entetes: Record<string, string> = { Origin: ORIGINE, Accept: 'text/event-stream' };
    if (client.cookie !== undefined) entetes['Cookie'] = client.cookie;
    const requete = request({ host: '127.0.0.1', port, path: chemin, method: 'GET', headers: entetes }, (reponse) => {
      let brut = '';
      let termine = false;
      let evenements: EvenementTempsReel[] = [];
      const observateurs = new Set<() => void>();
      let signalerFermeture: () => void = () => undefined;
      const ferme = new Promise<void>((r) => (signalerFermeture = r));
      reponse.setEncoding('utf8');
      reponse.on('data', (morceau: string) => {
        brut += morceau;
        // Seuls les blocs COMPLETS (terminés par une ligne vide) comptent.
        evenements = analyser(brut.slice(0, brut.lastIndexOf('\n\n') + 2));
        for (const o of [...observateurs]) o();
      });
      const fin = (): void => {
        termine = true;
        signalerFermeture();
        for (const o of [...observateurs]) o();
      };
      reponse.on('end', fin);
      reponse.on('close', fin);
      reponse.on('error', fin);
      const flux: FluxOuvert = {
        statut: reponse.statusCode ?? 0,
        entetes: reponse.headers,
        get evenements() {
          return evenements;
        },
        brut: () => brut,
        ferme,
        estFerme: () => termine,
        attendre: (predicat, delaiMs = 3000) =>
          new Promise((ok, ko) => {
            const verifier = (): void => {
              const trouve = evenements.find(predicat);
              if (trouve !== undefined) {
                observateurs.delete(verifier);
                clearTimeout(minuterie);
                ok(trouve);
              }
            };
            const minuterie = setTimeout(() => {
              observateurs.delete(verifier);
              ko(new Error(`Aucun événement attendu en ${String(delaiMs)} ms. Reçu : ${JSON.stringify(evenements.map((e) => e.type))}`));
            }, delaiMs);
            observateurs.add(verifier);
            verifier();
          }),
        fermer: () => reponse.destroy(),
      };
      // Le serveur écrit `retry:` et un commentaire dès l'ouverture : on attend ce premier octet pour que « ouvert » soit vrai ensuite.
      if (reponse.statusCode !== 200) {
        reponse.on('end', () => resolu(flux));
        return;
      }
      const attente = setInterval(() => {
        if (brut !== '' || termine) {
          clearInterval(attente);
          resolu(flux);
        }
      }, 5);
    });
    requete.on('error', rejeter);
    requete.end();
  });
}

/** Un serveur HTTP réel autour de `app`, pour ouvrir de vrais flux. */
export async function serveurFlux(app: Express): Promise<ServeurFlux> {
  const serveur: Server = createServer(app);
  await new Promise<void>((ok) => serveur.listen(0, '127.0.0.1', ok));
  const port = (serveur.address() as AddressInfo).port;
  const ouverts: FluxOuvert[] = [];
  return {
    ouvrir: async (client, groupId) => {
      const flux = await ouvrirSur(port, client, `/api/groupes/${encodeURIComponent(groupId)}/temps-reel`);
      ouverts.push(flux);
      return flux;
    },
    arreter: async () => {
      for (const f of ouverts) f.fermer();
      serveur.closeAllConnections();
      await new Promise<void>((ok) => serveur.close(() => ok()));
    },
  };
}

/**
 * Une route à réponse ininterrompue vue par la suite générique : ouvre le flux, lit le statut et le premier message, COUPE. Les erreurs
 * (401, 404, 429) sont des réponses JSON ordinaires, lues en entier. Le statut est celui de la vraie réponse ; `texte` contient ce que le
 * serveur a écrit avant la coupure.
 */
export async function sonderFlux(app: Express, client: Client, chemin: string, attenteMs = 150): Promise<Reponse> {
  const serveur = createServer(app);
  await new Promise<void>((ok) => serveur.listen(0, '127.0.0.1', ok));
  const port = (serveur.address() as AddressInfo).port;
  try {
    const flux = await ouvrirSur(port, client, chemin);
    // Un flux ouvert (200) ne finit pas : on laisse passer d'éventuelles données puis on coupe. Une erreur est déjà finie.
    if (flux.statut === 200) await pause(attenteMs);
    const texte = flux.brut();
    flux.fermer();
    let corps: Record<string, unknown> = {};
    if (flux.statut !== 200) {
      try {
        corps = JSON.parse(texte) as Record<string, unknown>;
      } catch {
        corps = {};
      }
    }
    return { statut: flux.statut, corps, entetes: flux.entetes, cookies: [], texte };
  } finally {
    serveur.closeAllConnections();
    await new Promise<void>((ok) => serveur.close(() => ok()));
  }
}
