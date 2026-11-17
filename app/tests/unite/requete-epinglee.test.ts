import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdressesVerifiees,
  envoyerEpingle,
  ErreurResolutionEpinglee,
  resoudreEtVerifier,
  type DnsLookupEpingle,
} from '../../server/services/requete-epinglee.js';

// Module commun de la requête épinglée (Immich + Web Push) : résolution vérifiée, connexion épinglée, redirection non suivie.

const dnsVers = (...adresses: string[]): DnsLookupEpingle =>
  vi.fn(() => Promise.resolve(adresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))));

describe('resoudreEtVerifier', () => {
  it('refuse une adresse privée quand autoriserPrive vaut false, l’accepte quand il vaut true', async () => {
    await expect(resoudreEtVerifier('nas.exemple.org', { autoriserPrive: false, dnsLookup: dnsVers('192.168.1.5') })).rejects.toMatchObject({
      code: 'adresse_interdite',
    });
    const acceptees = await resoudreEtVerifier('nas.exemple.org', { autoriserPrive: true, dnsLookup: dnsVers('192.168.1.5') });
    expect(acceptees.liste).toHaveLength(1);
    expect(acceptees.autoriserPrive).toBe(true);
  });

  it('refuse toujours les métadonnées cloud, même avec autoriserPrive', async () => {
    await expect(resoudreEtVerifier('x.exemple.org', { autoriserPrive: true, dnsLookup: dnsVers('169.254.169.254') })).rejects.toBeInstanceOf(
      ErreurResolutionEpinglee,
    );
  });

  it('refuse dès qu’UNE seule adresse résolue n’est pas autorisée', async () => {
    await expect(
      resoudreEtVerifier('x.exemple.org', { autoriserPrive: false, dnsLookup: dnsVers('93.184.216.34', '10.0.0.7') }),
    ).rejects.toMatchObject({ code: 'adresse_interdite' });
  });

  it('distingue échec DNS et absence d’adresse', async () => {
    const enEchec: DnsLookupEpingle = () => Promise.reject(new Error('ENOTFOUND'));
    await expect(resoudreEtVerifier('x.exemple.org', { autoriserPrive: false, dnsLookup: enEchec })).rejects.toMatchObject({ code: 'dns_echec' });
    await expect(resoudreEtVerifier('x.exemple.org', { autoriserPrive: false, dnsLookup: dnsVers() })).rejects.toMatchObject({ code: 'aucune_adresse' });
  });
});

describe('envoyerEpingle', () => {
  let serveur: http.Server | undefined;
  let touches = 0;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (serveur !== undefined) {
      const ferme = serveur;
      serveur = undefined;
      // Les connexions sont coupées AVANT close() : sinon close() attend indéfiniment une socket restée ouverte.
      ferme.closeAllConnections();
      await new Promise<void>((fin) => ferme.close(() => fin()));
    }
  });

  async function demarrer(gestionnaire: http.RequestListener): Promise<number> {
    touches = 0;
    const s = http.createServer((req, res) => {
      touches += 1;
      gestionnaire(req, res);
    });
    serveur = s;
    await new Promise<void>((ok, ko) => {
      s.once('error', ko);
      s.listen(0, '127.0.0.1', ok);
    });
    return (s.address() as AddressInfo).port;
  }

  /** Adresses vérifiées par la voie normale, sous la politique donnée (127.0.0.1 n'est admis que si `autoriserPrive`). */
  const verifiees = (autoriserPrive: boolean): Promise<AdressesVerifiees> =>
    resoudreEtVerifier('epingle.invalid', { autoriserPrive, dnsLookup: dnsVers('127.0.0.1') });

  it('se connecte à l’adresse épinglée et non à celle du nom ; une redirection est rendue telle quelle', async () => {
    const port = await demarrer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://169.254.169.254/');
      res.end();
    });

    const res = await envoyerEpingle({
      url: new URL(`http://epingle.invalid:${port}/x`), // ne se résout nulle part : seul l'épinglage peut aboutir
      method: 'GET',
      headers: {},
      body: null,
      adresses: await verifiees(true),
      autoriserPrive: true,
    });
    expect(res.statusCode).toBe(302);
    res.resume();
  });

  it('coupe un flux muet sur l’inactivité avec le message fourni', async () => {
    const port = await demarrer(() => undefined);
    await expect(
      envoyerEpingle({
        url: new URL(`http://epingle.invalid:${port}/x`),
        method: 'GET',
        headers: {},
        body: null,
        adresses: await verifiees(true),
        autoriserPrive: true,
        inactivite: { delaiMs: 50, message: 'muet' },
      }),
    ).rejects.toThrow('muet');
  });

  // Fermeture par le type : adresses non issues de resoudreEtVerifier. `npm run typecheck` échoue si une directive devient inutile
  // (la construction interdite se mettrait à compiler) ; à l'exécution, le contrôle `instanceof` refuse le contournement par cast.
  describe('adresses non vérifiées', () => {
    const base = { method: 'GET', headers: {}, body: null, autoriserPrive: false } as const;

    it('ne compile pas : tableau nu, littéral, constructeur', () => {
      const url = new URL('http://epingle.invalid/x');
      const construire = (): void => {
        // @ts-expect-error un tableau nu n'est pas un AdressesVerifiees
        void envoyerEpingle({ ...base, url, adresses: [{ address: '10.0.0.5', family: 4 }] });
        // @ts-expect-error un littéral ne peut pas imiter les champs privés `#`
        void envoyerEpingle({ ...base, url, adresses: { liste: [{ address: '10.0.0.5', family: 4 }], autoriserPrive: false } });
        // @ts-expect-error le constructeur est privé
        void new AdressesVerifiees([{ address: '10.0.0.5', family: 4 }], false);
      };
      expect(construire).toBeTypeOf('function'); // jamais appelée : seule la compilation est l'objet du test
    });

    it('est refusé à l’exécution même après un cast', async () => {
      const port = await demarrer((_req, res) => res.end());
      const forge = [{ address: '127.0.0.1', family: 4 }] as unknown as AdressesVerifiees;
      await expect(
        envoyerEpingle({ ...base, url: new URL(`http://epingle.invalid:${port}/x`), adresses: forge }),
      ).rejects.toThrow('non vérifiées');
      const imite = { liste: [{ address: '127.0.0.1', family: 4 }], autoriserPrive: false } as unknown as AdressesVerifiees;
      await expect(
        envoyerEpingle({ ...base, url: new URL(`http://epingle.invalid:${port}/x`), adresses: imite }),
      ).rejects.toThrow('non vérifiées');
      expect(touches).toBe(0);
    });
  });

  it('refuse des adresses vérifiées sous autoriserPrive: true pour un appel qui exige false', async () => {
    const port = await demarrer((_req, res) => res.end());
    await expect(
      envoyerEpingle({
        url: new URL(`http://epingle.invalid:${port}/x`),
        method: 'GET',
        headers: {},
        body: null,
        adresses: await verifiees(true),
        autoriserPrive: false,
      }),
    ).rejects.toThrow('autre politique');
    expect(touches).toBe(0);
  });

  it('n’utilise jamais d’agent partagé (pas de socket keep-alive réutilisée d’une politique à l’autre)', async () => {
    const port = await demarrer((_req, res) => res.end());
    const espion = vi.spyOn(http, 'request');
    const res = await envoyerEpingle({
      url: new URL(`http://epingle.invalid:${port}/x`),
      method: 'GET',
      headers: {},
      body: null,
      adresses: await verifiees(true),
      autoriserPrive: true,
    });
    res.resume();
    const options = espion.mock.calls[0]?.[1] as http.RequestOptions;
    expect(options.agent).toBe(false);
  });

  it('le lookup d’épinglage rend les adresses vérifiées avec all:true et lève une erreur sans all', async () => {
    const port = await demarrer((_req, res) => res.end());
    const espion = vi.spyOn(http, 'request');
    const res = await envoyerEpingle({
      url: new URL(`http://epingle.invalid:${port}/x`),
      method: 'GET',
      headers: {},
      body: null,
      adresses: await verifiees(true),
      autoriserPrive: true,
    });
    res.resume();
    const lookup = (espion.mock.calls[0]?.[1] as http.RequestOptions).lookup;
    if (lookup === undefined) throw new Error('lookup attendu');

    const avecAll = vi.fn();
    lookup('epingle.invalid', { all: true }, avecAll);
    expect(avecAll).toHaveBeenCalledWith(null, [{ address: '127.0.0.1', family: 4 }]);

    // Branche que Node 26 n'emprunte pas : elle ne doit JAMAIS rendre d'adresse.
    const sansAll = vi.fn();
    lookup('epingle.invalid', {}, sansAll);
    expect(sansAll).toHaveBeenCalledTimes(1);
    expect(sansAll.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(sansAll.mock.calls[0]?.[1]).toBe('');
  });
});
