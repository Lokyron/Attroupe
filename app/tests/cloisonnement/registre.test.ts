import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { declarerIntergiciel, monter } from '../../server/http/montage.js';
import { decor, type Decor } from '../fixtures/comptes.js';
import { extraireRoutes } from '../fixtures/routes.js';
import { avecRequete, poserDansCorps } from './forge.js';
import { cle, PREFIXE_GROUPE, REGISTRE } from './registre.js';

// Test de COMPLÉTUDE du registre de cloisonnement (architecture §8). L'application réelle est montée, la liste de ses
// routes est extraite de la pile d'Express, et elle doit coïncider avec le registre : ajouter une route sans y penser
// casse l'intégration continue, donc la publication de l'image.
describe('registre de cloisonnement : complétude', () => {
  let d: Decor;
  beforeAll(() => {
    d = decor();
  });
  afterAll(() => d.nettoyer());

  it('l’extraction voit les routes imbriquées (elle n’est pas vide par accident)', () => {
    const { routes } = extraireRoutes(d.app);
    expect(routes).toContain('GET /api/sante');
    expect(routes).toContain('DELETE /api/groupes/:groupId/membres/:membreId');
    expect(routes).toContain('POST /api/auth/mot-de-passe/reinitialisation');
  });

  it('toute route montée par Express est au registre', () => {
    const { routes } = extraireRoutes(d.app);
    const declarees = new Set(REGISTRE.map(cle));
    const manquantes = routes.filter((r) => !declarees.has(r));
    expect(manquantes, `Routes absentes de tests/cloisonnement/registre.ts : ${manquantes.join(' ; ')}`).toEqual([]);
  });

  it('toute entrée du registre correspond à une route réelle (pas d’entrée périmée)', () => {
    const { routes } = extraireRoutes(d.app);
    const reelles = new Set(routes);
    const perimees = REGISTRE.map(cle).filter((r) => !reelles.has(r));
    expect(perimees, `Entrées du registre sans route : ${perimees.join(' ; ')}`).toEqual([]);
  });

  it('aucun routeur n’est monté en dehors de monter() (il cacherait ses routes)', () => {
    expect(extraireRoutes(d.app).anomalies).toEqual([]);
  });

  it('le registre n’a pas de doublon', () => {
    const cles = REGISTRE.map(cle);
    expect(new Set(cles).size).toBe(cles.length);
  });

  it('le registre est cohérent avec le chemin : une route de groupe exige l’appartenance, et seulement elle', () => {
    for (const e of REGISTRE) {
      const dansGroupe = e.chemin === PREFIXE_GROUPE || e.chemin.startsWith(`${PREFIXE_GROUPE}/`);
      const exigeAppartenance = e.exige === 'appartenance' || e.exige === 'admin';
      expect(exigeAppartenance, `${cle(e)} : exigence « ${e.exige} » incohérente avec son chemin`).toBe(dansGroupe);
    }
  });

  it('chaque paramètre d’URL du registre est déclaré (groupId, ou une ressource)', () => {
    for (const e of REGISTRE) {
      const parametres = [...e.chemin.matchAll(/:(\w+)/g)].map((m) => m[1] ?? '').filter((p) => p !== 'groupId');
      expect(Object.keys(e.ressources ?? {}).sort(), cle(e)).toEqual(parametres.sort());
    }
  });

  it('chaque ressource déclarée dans le corps existe dans le corps du registre (sinon rien ne serait forgé)', () => {
    for (const e of REGISTRE) {
      for (const chemin of Object.keys(e.ressourcesCorps ?? {})) expect(() => poserDansCorps(e.corps, chemin, 'x'), cle(e)).not.toThrow();
    }
  });
});

describe('forge : poser un identifiant dans le corps et dans la requête', () => {
  it('remplace une valeur imbriquée, dans une liste, sans toucher à l’original', () => {
    const corps = { payer_membership_id: 'a', shares: [{ membership_id: 'a1' }, { membership_id: 'a2' }] };
    expect(poserDansCorps(corps, 'shares.1.membership_id', 'B')).toEqual({ payer_membership_id: 'a', shares: [{ membership_id: 'a1' }, { membership_id: 'B' }] });
    expect(poserDansCorps(corps, 'payer_membership_id', 'B')).toMatchObject({ payer_membership_id: 'B' });
    expect(corps.shares[1]?.membership_id).toBe('a2');
  });

  it('refuse un chemin qui ne mène à rien (une attaque qui ne forge rien est une fausse assurance)', () => {
    expect(() => poserDansCorps({ a: 1 }, 'b', 'x')).toThrow(/n'existe pas/);
    expect(() => poserDansCorps({ a: [] }, 'a.0.id', 'x')).toThrow(/n'existe pas/);
    expect(() => poserDansCorps(undefined, 'a', 'x')).toThrow(/n'existe pas/);
  });

  it('encode la chaîne de requête', () => {
    expect(avecRequete('/api/x', {})).toBe('/api/x');
    expect(avecRequete('/api/x', { event_id: 'a&b=c', t: 'é' })).toBe('/api/x?event_id=a%26b%3Dc&t=%C3%A9');
  });
});

describe('complétude : les use() qui ne sont pas des routeurs', () => {
  const passe = (_req: Request, _res: Response, next: NextFunction): void => next();
  const mandataire = (_req: Request, res: Response): void => void res.status(200).end();

  it('un mandataire monté sous /api/groupes, non déclaré, est une anomalie', () => {
    const app = express();
    const groupe = Router({ mergeParams: true });
    groupe.use('/medias', mandataire);
    monter(app, '/api/groupes', groupe);
    const { anomalies } = extraireRoutes(app);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toContain('non déclaré');
  });

  it('un use() non routeur non déclaré sous /api, au niveau de l’application, est une anomalie', () => {
    const app = express();
    app.use('/api/medias', mandataire);
    expect(extraireRoutes(app).anomalies).toHaveLength(1);
  });

  it('un intergiciel transversal déclaré est admis hors /api/groupes, mais pas dessous', () => {
    const app = express();
    app.use('/api', declarerIntergiciel('transversal', passe));
    expect(extraireRoutes(app).anomalies).toEqual([]);
    const groupe = Router({ mergeParams: true });
    groupe.use(declarerIntergiciel('transversal', passe));
    monter(app, '/api/groupes', groupe);
    expect(extraireRoutes(app).anomalies).toHaveLength(1);
  });

  it('une garde déclarée est admise partout', () => {
    const app = express();
    const groupe = Router({ mergeParams: true });
    groupe.use(declarerIntergiciel('garde', passe));
    monter(app, '/api/groupes', groupe, passe);
    expect(extraireRoutes(app).anomalies).toEqual([]);
  });
});
