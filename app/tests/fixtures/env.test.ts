import { describe, expect, it } from 'vitest';
import { envValide, secretFactice } from './env.js';

describe('fixtures : environnement de test', () => {
  it('produit un environnement que la validation accepte', () => {
    const env = envValide();
    expect(env.NODE_ENV).toBe('test');
    expect(env.PORT).toBe(3000);
  });

  it('produit des secrets différents à chaque appel', () => {
    expect(secretFactice()).not.toBe(secretFactice());
  });
});
