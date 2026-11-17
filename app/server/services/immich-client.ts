import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { validerUrlImmich, type TailleMedia } from '../domain/immich.js';

// Client HTTP sortant vers Immich (architecture §7.2, docs/integration-immich.md).
// - Validation anti-SSRF sur l'URL ET sur chaque adresse IP résolue par DNS avant tout appel.
// - Jamais de redirection suivie (`redirect: 'manual'`), délai maximal 4 s, 2 tentatives sur erreur réseau / 5xx, jamais sur 4xx.

export const DELAI_APPEL_IMMICH_MS = 4_000;
export const TENTATIVES_MAX_IMMICH = 2;

export type FetchImmich = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface EntreeDns {
  readonly address: string;
  readonly family: number;
}

export type DnsLookupImmich = (hostname: string, options: { all: true }) => Promise<readonly EntreeDns[]>;

export interface OptionsClientImmich {
  readonly allowPrivate?: boolean;
  readonly fetchImpl?: FetchImmich;
  readonly dnsLookupImpl?: DnsLookupImmich;
  readonly delaiMs?: number;
}

export type ResultatTestConnexionImmich =
  | { readonly status: 'ok'; readonly immich_user_id: string | null }
  | { readonly status: 'unauthorized' | 'unreachable'; readonly error: string };

export interface AssetImmich {
  readonly id: string;
  readonly type: 'IMAGE' | 'VIDEO';
  readonly fileCreatedAt: string | null;
  readonly exifInfo: {
    readonly exifImageWidth?: number | null;
    readonly exifImageHeight?: number | null;
    readonly dateTimeOriginal?: string | null;
  } | null;
  readonly duration: string | null;
}

export interface EntreeTeleversementImmich {
  readonly buffer: Buffer;
  readonly filename: string;
  readonly mimeType: string;
  readonly fileCreatedAt: string;
  readonly sha1: string;
}

export interface MediaImmich {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: ReadableStream<Uint8Array> | ArrayBuffer | null;
}

export class ErreurClientImmich extends Error {
  constructor(
    public readonly code: 'url_invalide' | 'ssrf_refuse' | 'redirection_refusee' | 'non_autorise' | 'injoignable' | 'reponse_invalide',
    message: string,
    public readonly statutHttp?: number,
  ) {
    super(message);
    this.name = 'ErreurClientImmich';
  }
}

export class ClientImmich {
  private readonly allowPrivate: boolean;
  private readonly fetchPersonnalise: FetchImmich | undefined;
  private readonly dnsLookupImpl: DnsLookupImmich;
  private readonly delaiMs: number;

  constructor(options: OptionsClientImmich = {}) {
    this.allowPrivate = options.allowPrivate ?? false;
    this.fetchPersonnalise = options.fetchImpl;
    this.dnsLookupImpl =
      options.dnsLookupImpl ??
      ((hostname, opts) => lookup(hostname, opts) as Promise<readonly EntreeDns[]>);
    this.delaiMs = options.delaiMs ?? DELAI_APPEL_IMMICH_MS;
  }

  /** Valide l'URL et résout son nom d'hôte via DNS pour bloquer tout rebond vers une IP interdite. */
  private async verifierEtNormaliserUrl(
    baseUrl: string,
  ): Promise<{ readonly urlNormalisee: string; readonly adresses: readonly EntreeDns[] }> {
    const validation = validerUrlImmich(baseUrl, this.allowPrivate);
    if (!validation.valide) {
      throw new ErreurClientImmich('url_invalide', `URL Immich invalide (${validation.raison}).`);
    }

    const url = new URL(validation.urlNormalisee);
    const hoteSansCrochets = url.hostname.replace(/^\[|\]$/g, '');
    const typeIp = isIP(hoteSansCrochets);
    if (typeIp !== 0) {
      return {
        urlNormalisee: validation.urlNormalisee,
        adresses: [{ address: hoteSansCrochets, family: typeIp }],
      };
    }

    let adresses: readonly EntreeDns[];
    try {
      adresses = await this.dnsLookupImpl(hoteSansCrochets, { all: true });
    } catch (erreur) {
      throw new ErreurClientImmich(
        'injoignable',
        `Résolution DNS impossible pour ${hoteSansCrochets} : ${erreur instanceof Error ? erreur.message : String(erreur)}`,
      );
    }
    if (adresses.length === 0) {
      throw new ErreurClientImmich('injoignable', `Aucune adresse IP résolue pour ${hoteSansCrochets}.`);
    }
    for (const entree of adresses) {
      const ip = entree.address.trim();
      const urlIp = `http://${ip.includes(':') ? `[${ip}]` : ip}`;
      const verifIp = validerUrlImmich(urlIp, this.allowPrivate);
      if (!verifIp.valide) {
        throw new ErreurClientImmich('ssrf_refuse', `Adresse IP résolue interdite (${verifIp.raison}).`);
      }
    }

    return { urlNormalisee: validation.urlNormalisee, adresses };
  }

  /**
   * Exécute un appel HTTP/HTTPS en épinglant la résolution DNS sur les adresses déjà validées
   * (empêche toute attaque TOCTOU / DNS rebinding entre la vérification et la connexion TCP).
   */
  private async executerRequeteEpinglee(
    urlCible: string,
    init: RequestInit,
    adresses: readonly EntreeDns[],
  ): Promise<Response> {
    if (this.fetchPersonnalise !== undefined) {
      return this.fetchPersonnalise(urlCible, init);
    }
    const cible = new URL(urlCible);
    const requeteWeb = new Request(urlCible, init);
    const corps = requeteWeb.body !== null ? Buffer.from(await requeteWeb.arrayBuffer()) : null;
    const entetes: Record<string, string> = {};
    requeteWeb.headers.forEach((valeur, cle) => {
      entetes[cle] = valeur;
    });

    const premiere = adresses[0];
    if (premiere === undefined) {
      throw new ErreurClientImmich('injoignable', 'Aucune adresse IP disponible.');
    }

    const transport = cible.protocol === 'https:' ? https : http;
    return new Promise<Response>((resolve, reject) => {
      const req = transport.request(
        cible,
        {
          method: requeteWeb.method,
          headers: entetes,
          signal: init.signal ?? undefined,
          // Inactivité de la socket (et non durée totale) : un transfert lent mais vivant continue, un flux
          // qui ne délivre plus rien est coupé au lieu de rester pendu.
          timeout: this.delaiMs,
          lookup: (_hostname, options, callback) => {
            if (typeof options === 'object' && options !== null && 'all' in options && options.all === true) {
              (callback as (err: NodeJS.ErrnoException | null, addresses: readonly EntreeDns[]) => void)(null, adresses);
            } else {
              callback(null, premiere.address, premiere.family);
            }
          },
        },
        (res) => {
          const status = res.statusCode ?? 500;
          if (status >= 300 && status < 400) {
            res.resume();
            resolve(new Response(null, { status }));
            return;
          }
          const headersReponse = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) {
              for (const item of v) headersReponse.append(k, item);
            } else if (v !== undefined) {
              headersReponse.set(k, v);
            }
          }
          const corpsReponse =
            status === 204 || status === 304
              ? null
              : (Readable.toWeb(res) as unknown as NonNullable<ConstructorParameters<typeof Response>[0]>);
          resolve(new Response(corpsReponse, { status, headers: headersReponse }));
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Aucune activité d'Immich depuis ${this.delaiMs} ms.`)));
      req.on('error', reject);
      if (corps !== null && corps.length > 0) req.write(corps);
      req.end();
    });
  }

  /**
   * Exécute une requête HTTP sortante vers Immich avec timeout 4 s, sans redirection, et 2 tentatives sur 5xx/réseau.
   * Par défaut le délai borne l'appel entier, lecture du corps comprise (petites réponses JSON). Avec
   * `delaiEntetesSeulement`, il ne borne que l'obtention des en-têtes : le transfert d'un média volumineux
   * n'est plus coupé en cours de route (une coupure laisserait partir un 200 tronqué).
   */
  private async appeler(
    baseUrl: string,
    chemin: string,
    init: Omit<RequestInit, 'redirect' | 'signal'>,
    apiKey: string,
    delaiEntetesSeulement = false,
  ): Promise<Response> {
    const { urlNormalisee, adresses } = await this.verifierEtNormaliserUrl(baseUrl);
    const urlCible = `${urlNormalisee}${chemin}`;
    const entetes = new Headers(init.headers);
    entetes.set('x-api-key', apiKey);

    let derniereErreur: unknown;
    for (let tentative = 1; tentative <= TENTATIVES_MAX_IMMICH; tentative += 1) {
      // Contrôleur propre : son minuteur est levé dès les en-têtes reçus quand seul leur délai est borné.
      const controleur = new AbortController();
      const minuteur = setTimeout(
        () => controleur.abort(new Error(`Délai de ${this.delaiMs} ms dépassé en attendant Immich.`)),
        this.delaiMs,
      );
      try {
        let reponse: Response;
        try {
          reponse = await this.executerRequeteEpinglee(
            urlCible,
            {
              ...init,
              headers: entetes,
              redirect: 'manual',
              signal: controleur.signal,
            },
            adresses,
          );
        } catch (erreur) {
          clearTimeout(minuteur);
          throw erreur;
        }
        if (delaiEntetesSeulement) clearTimeout(minuteur);
        else minuteur.unref();

        // Jamais de redirection suivie.
        if (reponse.type === 'opaqueredirect' || (reponse.status >= 300 && reponse.status < 400)) {
          throw new ErreurClientImmich('redirection_refusee', `Redirection HTTP refusée (${reponse.status}).`, reponse.status);
        }

        // Aucune nouvelle tentative sur 4xx.
        if (reponse.status >= 400 && reponse.status < 500) {
          return reponse;
        }

        // Nouvelle tentative sur 5xx si possible.
        if (reponse.status >= 500) {
          derniereErreur = new ErreurClientImmich('injoignable', `Erreur serveur Immich (${reponse.status}).`, reponse.status);
          if (tentative < TENTATIVES_MAX_IMMICH) continue;
          return reponse;
        }

        return reponse;
      } catch (erreur) {
        if (erreur instanceof ErreurClientImmich && erreur.code === 'redirection_refusee') {
          throw erreur;
        }
        derniereErreur = erreur;
        if (tentative < TENTATIVES_MAX_IMMICH) continue;
      }
    }

    throw new ErreurClientImmich(
      'injoignable',
      derniereErreur instanceof Error ? derniereErreur.message : 'Instance Immich injoignable.',
    );
  }

  async testerConnexion(baseUrl: string, apiKey: string): Promise<ResultatTestConnexionImmich> {
    try {
      const reponse = await this.appeler(baseUrl, '/users/me', { method: 'GET' }, apiKey);
      if (reponse.status === 401 || reponse.status === 403) {
        return { status: 'unauthorized', error: `Authentification Immich refusée (${reponse.status}).` };
      }
      if (!reponse.ok) {
        return { status: 'unreachable', error: `Réponse Immich inattendue (${reponse.status}).` };
      }
      const corps = (await reponse.json().catch(() => null)) as Record<string, unknown> | null;
      const immichUserId = corps !== null && typeof corps['id'] === 'string' ? corps['id'] : null;
      return { status: 'ok', immich_user_id: immichUserId };
    } catch (erreur) {
      return {
        status: 'unreachable',
        error: erreur instanceof Error ? erreur.message : 'Instance Immich injoignable.',
      };
    }
  }

  async creerAlbumImmich(baseUrl: string, apiKey: string, albumName: string, description?: string): Promise<{ id: string }> {
    const reponse = await this.appeler(
      baseUrl,
      '/albums',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(description ? { albumName, description } : { albumName }),
      },
      apiKey,
    );
    if (reponse.status === 401 || reponse.status === 403) {
      throw new ErreurClientImmich('non_autorise', 'Clé Immich refusée.', reponse.status);
    }
    if (!reponse.ok) {
      throw new ErreurClientImmich('injoignable', `Création d'album Immich échouée (${reponse.status}).`, reponse.status);
    }
    const corps = (await reponse.json().catch(() => null)) as Record<string, unknown> | null;
    if (corps === null || typeof corps['id'] !== 'string' || corps['id'] === '') {
      throw new ErreurClientImmich('reponse_invalide', "Réponse Immich invalide lors de la création d'album.");
    }
    return { id: corps['id'] };
  }

  async listerAssetsAlbumImmich(baseUrl: string, apiKey: string, immichAlbumId: string): Promise<AssetImmich[]> {
    const reponse = await this.appeler(baseUrl, `/albums/${encodeURIComponent(immichAlbumId)}`, { method: 'GET' }, apiKey);
    if (reponse.status === 401 || reponse.status === 403) {
      throw new ErreurClientImmich('non_autorise', 'Clé Immich refusée.', reponse.status);
    }
    if (!reponse.ok) {
      throw new ErreurClientImmich('injoignable', `Lecture d'album Immich échouée (${reponse.status}).`, reponse.status);
    }
    const corps = (await reponse.json().catch(() => null)) as Record<string, unknown> | null;
    const bruts = corps !== null && Array.isArray(corps['assets']) ? corps['assets'] : [];
    const assets: AssetImmich[] = [];
    for (const item of bruts) {
      if (typeof item !== 'object' || item === null) continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj['id'] !== 'string') continue;
      const type = obj['type'] === 'VIDEO' ? 'VIDEO' : 'IMAGE';
      const exifBrut = typeof obj['exifInfo'] === 'object' && obj['exifInfo'] !== null ? (obj['exifInfo'] as Record<string, unknown>) : null;
      assets.push({
        id: obj['id'],
        type,
        fileCreatedAt: typeof obj['fileCreatedAt'] === 'string' ? obj['fileCreatedAt'] : null,
        exifInfo: exifBrut
          ? {
              exifImageWidth: typeof exifBrut['exifImageWidth'] === 'number' ? exifBrut['exifImageWidth'] : null,
              exifImageHeight: typeof exifBrut['exifImageHeight'] === 'number' ? exifBrut['exifImageHeight'] : null,
              dateTimeOriginal: typeof exifBrut['dateTimeOriginal'] === 'string' ? exifBrut['dateTimeOriginal'] : null,
            }
          : null,
        duration: typeof obj['duration'] === 'string' ? obj['duration'] : null,
      });
    }
    return assets;
  }

  async televerserAssetImmich(
    baseUrl: string,
    apiKey: string,
    immichAlbumId: string,
    fichier: EntreeTeleversementImmich,
  ): Promise<{ id: string }> {
    const formulaire = new FormData();
    const blob = new Blob([new Uint8Array(fichier.buffer)], { type: fichier.mimeType });
    formulaire.append('assetData', blob, fichier.filename);
    formulaire.append('fileCreatedAt', fichier.fileCreatedAt);
    formulaire.append('fileModifiedAt', fichier.fileCreatedAt);
    formulaire.append('filename', fichier.filename);

    const reponseUpload = await this.appeler(
      baseUrl,
      '/assets',
      {
        method: 'POST',
        headers: { 'x-immich-checksum': fichier.sha1 },
        body: formulaire,
      },
      apiKey,
    );
    if (reponseUpload.status === 401 || reponseUpload.status === 403) {
      throw new ErreurClientImmich('non_autorise', 'Clé Immich refusée.', reponseUpload.status);
    }
    if (reponseUpload.status !== 200 && reponseUpload.status !== 201) {
      throw new ErreurClientImmich('injoignable', `Téléversement Immich échoué (${reponseUpload.status}).`, reponseUpload.status);
    }
    const corpsUpload = (await reponseUpload.json().catch(() => null)) as Record<string, unknown> | null;
    if (corpsUpload === null || typeof corpsUpload['id'] !== 'string' || corpsUpload['id'] === '') {
      throw new ErreurClientImmich('reponse_invalide', "Réponse Immich invalide lors du téléversement.");
    }
    const assetId = corpsUpload['id'];

    const reponseAjout = await this.appeler(
      baseUrl,
      `/albums/${encodeURIComponent(immichAlbumId)}/assets`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [assetId] }),
      },
      apiKey,
    );
    if (reponseAjout.status === 401 || reponseAjout.status === 403) {
      throw new ErreurClientImmich('non_autorise', 'Clé Immich refusée.', reponseAjout.status);
    }
    if (!reponseAjout.ok) {
      throw new ErreurClientImmich('injoignable', `Association à l'album Immich échouée (${reponseAjout.status}).`, reponseAjout.status);
    }

    return { id: assetId };
  }

  async retirerAssetAlbumImmich(baseUrl: string, apiKey: string, immichAlbumId: string, immichAssetId: string): Promise<void> {
    const reponse = await this.appeler(
      baseUrl,
      `/albums/${encodeURIComponent(immichAlbumId)}/assets`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [immichAssetId] }),
      },
      apiKey,
    );
    if (reponse.status === 401 || reponse.status === 403) {
      throw new ErreurClientImmich('non_autorise', 'Clé Immich refusée.', reponse.status);
    }
    if (!reponse.ok && reponse.status !== 404) {
      throw new ErreurClientImmich('injoignable', `Retrait d'asset Immich échoué (${reponse.status}).`, reponse.status);
    }
  }

  async recupererMediaImmich(baseUrl: string, apiKey: string, immichAssetId: string, taille: TailleMedia): Promise<MediaImmich> {
    const chemin =
      taille === 'original'
        ? `/assets/${encodeURIComponent(immichAssetId)}/original`
        : `/assets/${encodeURIComponent(immichAssetId)}/thumbnail?size=${encodeURIComponent(taille)}`;
    const reponse = await this.appeler(baseUrl, chemin, { method: 'GET' }, apiKey, true);
    const contentType = reponse.headers.get('content-type');
    if (reponse.body !== null) {
      return { status: reponse.status, contentType, body: reponse.body };
    }
    const tampon = await reponse.arrayBuffer();
    return { status: reponse.status, contentType, body: tampon };
  }
}
