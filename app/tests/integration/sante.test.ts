import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { creerApp, gestionnaireErreurs } from '../../server/http/app.js';
import { envValide } from '../fixtures/env.js';

const app = creerApp({ env: envValide(), version: '0.0.0-test' });

describe('GET /api/sante', () => {
  it('répond 200 en JSON avec l’état et la version', async () => {
    const reponse = await request(app).get('/api/sante');
    expect(reponse.status).toBe(200);
    expect(reponse.headers['content-type']).toMatch(/application\/json/);
    expect(reponse.body).toEqual({ status: 'ok', version: '0.0.0-test' });
  });

  it('ne révèle pas la technologie du serveur', async () => {
    const reponse = await request(app).get('/api/sante');
    expect(reponse.headers['x-powered-by']).toBeUndefined();
  });

  it('répond 404 en JSON à une route d’API inconnue', async () => {
    const reponse = await request(app).get('/api/inexistante');
    expect(reponse.status).toBe(404);
    expect(reponse.body).toEqual({ error: 'route.introuvable' });
  });
});

describe('création de l’application en production', () => {
  it('refuse de démarrer si le client construit est introuvable', () => {
    expect(() =>
      creerApp({ env: envValide(), version: '0.0.0-test', dossierClient: '/nulle/part' }),
    ).toThrow(/Client construit introuvable/);
  });
});

describe('en-têtes de sécurité', () => {
  it('pose CSP (avec frame-ancestors), nosniff et Referrer-Policy', async () => {
    const reponse = await request(app).get('/api/sante');
    expect(reponse.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(reponse.headers['content-security-policy']).toContain("default-src 'self'");
    expect(reponse.headers['x-content-type-options']).toBe('nosniff');
    expect(reponse.headers['referrer-policy']).toBe('same-origin');
  });

  it('les pose aussi sur une réponse 404', async () => {
    const reponse = await request(app).get('/api/inexistante');
    expect(reponse.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('gestionnaire d’erreurs', () => {
  function faussesReponses(headersSent: boolean): { res: Response; statut: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
    const json = vi.fn();
    const statut = vi.fn(() => ({ json }));
    return { res: { headersSent, status: statut } as unknown as Response, statut, json };
  }
  const req = {} as Request;

  it('respecte un statut 4xx porté par l’erreur', () => {
    const { res, statut, json } = faussesReponses(false);
    gestionnaireErreurs(Object.assign(new Error('JSON mal formé'), { status: 400 }), req, res, vi.fn());
    expect(statut).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'requete.invalide' });
  });

  it('répond 500 pour une erreur inconnue ou un statut 5xx', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const erreur of [new Error('boum'), Object.assign(new Error('x'), { status: 503 }), 'chaîne']) {
      const { res, statut, json } = faussesReponses(false);
      gestionnaireErreurs(erreur, req, res, vi.fn());
      expect(statut).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: 'erreur.interne' });
    }
    vi.restoreAllMocks();
  });

  it('passe la main à Express si les en-têtes sont déjà partis', () => {
    const { res, statut } = faussesReponses(true);
    const suivant: NextFunction = vi.fn();
    const erreur = new Error('trop tard');
    gestionnaireErreurs(erreur, req, res, suivant);
    expect(suivant).toHaveBeenCalledWith(erreur);
    expect(statut).not.toHaveBeenCalled();
  });
});
