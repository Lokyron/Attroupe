import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { validerUrlImmich } from '../domain/immich.js';

// Appel HTTP(S) sortant vers un hôte dont l'URL vient de l'extérieur : l'unique implémentation de la protection anti-SSRF,
// partagée par le client Immich (services/immich-client.ts) et l'envoi Web Push (services/push.ts).
// - `resoudreEtVerifier` résout le nom UNE fois et refuse dès qu'UNE seule adresse n'est pas autorisée.
// - `envoyerEpingle` se connecte exactement à ces adresses (option `lookup`) : aucune seconde résolution entre la
//   vérification et la connexion (fermeture du rebinding DNS). Aucune redirection n'est suivie : le statut 3xx est rendu tel quel.
// - Le délai total d'un appel est porté par le `signal` de l'appelant (levé ou non après les en-têtes selon son besoin :
//   petit JSON, ou média volumineux dont seul l'obtention des en-têtes est bornée).
// `autoriserPrive` n'a volontairement AUCUNE valeur par défaut : chaque appelant décide, et le push passe toujours `false`.
// - `envoyerEpingle` n'accepte que des `AdressesVerifiees`, type nominal (constructeur privé, champs `#`) que seul
//   `resoudreEtVerifier` fabrique : envoyer vers une adresse non vérifiée exige de modifier ce module. Le type mémorise la politique
//   utilisée, et l'envoi exige la même (`autoriserPrive`) : des adresses vérifiées en mode permissif ne servent pas un appel strict.

export interface EntreeDns {
  readonly address: string;
  readonly family: number;
}

export type DnsLookupEpingle = (hostname: string, options: { all: true }) => Promise<readonly EntreeDns[]>;

/** Résolution par défaut : le DNS du système. */
export const dnsLookupSysteme: DnsLookupEpingle = (hostname, options) => lookup(hostname, options) as Promise<readonly EntreeDns[]>;

/** Échec de la résolution ou de la vérification des adresses. `raison` n'est renseignée que pour `adresse_interdite`. */
export class ErreurResolutionEpinglee extends Error {
  constructor(
    public readonly code: 'dns_echec' | 'aucune_adresse' | 'adresse_interdite',
    message: string,
    public readonly raison?: string,
  ) {
    super(message);
    this.name = 'ErreurResolutionEpinglee';
  }
}

/**
 * Adresses issues de `resoudreEtVerifier`, et uniquement de lui. Type nominal : le constructeur est privé et les champs sont des
 * `#` privés, donc ni `new AdressesVerifiees(...)`, ni un littéral `{ liste, autoriserPrive }`, ni un tableau nu ne compilent
 * (voir le test « type-only » de requete-epinglee.test.ts) ; `envoyerEpingle` re-vérifie aussi `instanceof` à l'exécution.
 */
let emettre: (liste: readonly EntreeDns[], autoriserPrive: boolean) => AdressesVerifiees;

export class AdressesVerifiees {
  readonly #liste: readonly EntreeDns[];
  readonly #autoriserPrive: boolean;

  private constructor(liste: readonly EntreeDns[], autoriserPrive: boolean) {
    this.#liste = liste;
    this.#autoriserPrive = autoriserPrive;
  }

  // La fabrique reste une variable du module, non exportée : aucune méthode publique ne permet d'émettre une instance.
  static {
    emettre = (liste, autoriserPrive) => new AdressesVerifiees(liste, autoriserPrive);
  }

  get liste(): readonly EntreeDns[] {
    return this.#liste;
  }

  /** Politique sous laquelle ces adresses ont été vérifiées. */
  get autoriserPrive(): boolean {
    return this.#autoriserPrive;
  }
}

export interface OptionsResolution {
  /** Accepte les adresses privées/locales (homelab). Les adresses toujours interdites (métadonnées cloud, link-local…) restent refusées. */
  readonly autoriserPrive: boolean;
  readonly dnsLookup: DnsLookupEpingle;
}

function verifierAdresse(adresse: string, autoriserPrive: boolean): void {
  const ip = adresse.trim();
  const verif = validerUrlImmich(`http://${ip.includes(':') ? `[${ip}]` : ip}`, autoriserPrive);
  if (!verif.valide) {
    throw new ErreurResolutionEpinglee('adresse_interdite', `Adresse IP résolue interdite (${verif.raison}).`, verif.raison);
  }
}

/**
 * Résout `hote` (une IP littérale n'est pas résolue) et vérifie TOUTES les adresses obtenues : une seule adresse non autorisée
 * suffit à refuser. Rend les adresses à épingler, marquées de la politique utilisée.
 * @throws ErreurResolutionEpinglee
 */
export async function resoudreEtVerifier(hote: string, options: OptionsResolution): Promise<AdressesVerifiees> {
  const hoteSansCrochets = hote.replace(/^\[|\]$/g, '');
  const famille = isIP(hoteSansCrochets);
  if (famille !== 0) {
    verifierAdresse(hoteSansCrochets, options.autoriserPrive);
    return emettre([{ address: hoteSansCrochets, family: famille }], options.autoriserPrive);
  }

  let adresses: readonly EntreeDns[];
  try {
    adresses = await options.dnsLookup(hoteSansCrochets, { all: true });
  } catch (erreur) {
    throw new ErreurResolutionEpinglee('dns_echec', erreur instanceof Error ? erreur.message : String(erreur));
  }
  if (adresses.length === 0) throw new ErreurResolutionEpinglee('aucune_adresse', `Aucune adresse IP résolue pour ${hoteSansCrochets}.`);
  for (const entree of adresses) verifierAdresse(entree.address, options.autoriserPrive);
  return emettre([...adresses], options.autoriserPrive);
}

export interface RequeteEpinglee {
  readonly url: URL;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer | null;
  readonly signal?: AbortSignal | undefined;
  /** Adresses DÉJÀ vérifiées par `resoudreEtVerifier` : la connexion n'ira nulle part ailleurs. */
  readonly adresses: AdressesVerifiees;
  /** Politique de l'appelant : doit être celle sous laquelle `adresses` a été vérifiée, sinon l'envoi est refusé. */
  readonly autoriserPrive: boolean;
  /** Inactivité de la socket (et non durée totale) : un transfert lent mais vivant continue, un flux muet est coupé. */
  readonly inactivite?: { readonly delaiMs: number; readonly message: string } | undefined;
}

/**
 * Envoie la requête sur une connexion épinglée sur `requete.adresses` et rend la réponse (en-têtes reçus, corps non consommé :
 * l'appelant le lit ou fait `resume()`). Le transport suit le protocole de l'URL.
 */
export function envoyerEpingle(requete: RequeteEpinglee): Promise<http.IncomingMessage> {
  // Le type interdit déjà tout autre cas ; le contrôle d'exécution couvre un contournement par cast.
  if (!(requete.adresses instanceof AdressesVerifiees)) return Promise.reject(new Error('Adresses non vérifiées : envoi refusé.'));
  if (requete.adresses.autoriserPrive !== requete.autoriserPrive) {
    return Promise.reject(new Error('Adresses vérifiées sous une autre politique que celle de l’appel : envoi refusé.'));
  }
  const adresses = requete.adresses.liste;
  if (adresses.length === 0) return Promise.reject(new Error('Aucune adresse IP disponible.'));
  const transport = requete.url.protocol === 'https:' ? https : http;
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = transport.request(
      requete.url,
      {
        method: requete.method,
        headers: requete.headers,
        signal: requete.signal,
        // Pas d'agent partagé : la clé de réutilisation des sockets de `globalAgent` ignore `lookup`, une socket ouverte sous une
        // politique (Immich privé) pourrait resservir sous une autre (push). Une connexion par appel, jamais réutilisée.
        agent: false,
        ...(requete.inactivite !== undefined ? { timeout: requete.inactivite.delaiMs } : {}),
        lookup: (_hote, options, callback) => {
          if (typeof options === 'object' && options !== null && 'all' in options && options.all === true) {
            (callback as (err: NodeJS.ErrnoException | null, resultats: readonly EntreeDns[]) => void)(null, adresses);
          } else {
            // Jamais d'adresse arbitraire : Node appelle `lookup` avec `all: true` ; toute autre forme est une erreur explicite.
            callback(new Error('Résolution épinglée : seule la forme { all: true } est prise en charge.'), '', 0);
          }
        },
      },
      resolve,
    );
    const inactivite = requete.inactivite;
    if (inactivite !== undefined) req.on('timeout', () => req.destroy(new Error(inactivite.message)));
    req.on('error', reject);
    if (requete.body !== null && requete.body.length > 0) req.write(requete.body);
    req.end();
  });
}
