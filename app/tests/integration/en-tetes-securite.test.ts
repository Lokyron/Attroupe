// Une politique de sécurité trop serrée casse l'application sans rien dire.
//
// `default-src 'self'` sans `img-src` explicite bloquait les URL `blob:`. Or la préparation de la photo de
// profil décode le fichier choisi en passant par `URL.createObjectURL` (app/client/src/api/groupes.ts) :
// l'image ne se chargeait donc jamais, `onerror` partait, et l'ajout de photo échouait pour TOUT LE MONDE.
// Rien côté serveur ne le voyait — aucune requête n'était même émise — et seule la console du navigateur
// disait pourquoi. L'utilisateur, lui, lisait « Une erreur est survenue ».
//
// Ces tests figent donc la politique : ce qui doit être permis, et ce qui doit rester interdit.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { creerApp } from '../../server/http/app.js';
import { envValide } from '../fixtures/env.js';

const app = creerApp({ env: envValide(), version: '0.0.0-test' });

async function politique(): Promise<string> {
  const reponse = await request(app).get('/api/sante');
  const csp = reponse.headers['content-security-policy'];
  expect(csp, 'aucune Content-Security-Policy posée').toBeDefined();
  return csp ?? '';
}

/** Les directives de la politique, par nom. */
async function directives(): Promise<Map<string, string>> {
  const entrees = (await politique()).split(';').map((d) => d.trim()).filter((d) => d !== '');
  return new Map(entrees.map((d) => [d.split(/\s+/)[0] ?? '', d]));
}

describe('en-têtes de sécurité : la politique ne doit casser aucune fonctionnalité', () => {
  it('img-src est explicite : sans lui, default-src s’applique aux images et bloque blob:', async () => {
    const img = (await directives()).get('img-src');
    expect(img, "img-src absent : les URL blob: de la photo de profil seront bloquées").toBeDefined();
  });

  it('img-src autorise blob:, que le client fabrique pour décoder la photo choisie', async () => {
    expect((await directives()).get('img-src')).toContain('blob:');
  });

  it('img-src reste limité à la même origine pour le reste : aucune image distante', async () => {
    const img = (await directives()).get('img-src') ?? '';
    expect(img).toContain("'self'");
    expect(img).not.toContain('*');
    expect(img).not.toContain('http:');
    expect(img).not.toContain('https:');
  });

  it('blob: ne déborde pas sur les scripts : il n’est permis que pour les images', async () => {
    const toutes = await directives();
    for (const [nom, valeur] of toutes) {
      if (nom === 'img-src') continue;
      expect(valeur, `${nom} ne doit pas autoriser blob:`).not.toContain('blob:');
    }
  });

  it('les garde-fous qui ne doivent jamais bouger sont toujours là', async () => {
    const toutes = await directives();
    expect(toutes.get('default-src')).toBe("default-src 'self'");
    expect(toutes.get('object-src')).toBe("object-src 'none'");
    expect(toutes.get('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(toutes.get('base-uri')).toBe("base-uri 'self'");
    expect(toutes.get('form-action')).toBe("form-action 'self'");
  });

  it('les autres en-têtes de sécurité sont posés', async () => {
    const reponse = await request(app).get('/api/sante');
    expect(reponse.headers['x-content-type-options']).toBe('nosniff');
    expect(reponse.headers['referrer-policy']).toBe('same-origin');
  });
});
