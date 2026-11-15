import { randomBytes } from 'node:crypto';
import { chargerEnv, ressembleAUnFactice, type Env } from '../../server/config/env.js';

/** Un secret valide de 32 octets, différent à chaque appel. */
export function secretFactice(): string {
  // Un tirage aléatoire contient très rarement un mot interdit (« todo »…) : on retire.
  for (;;) {
    const secret = randomBytes(32).toString('base64');
    if (!ressembleAUnFactice(secret)) return secret;
  }
}

/** Variables d'environnement minimales mais valides, modifiables par test. */
export function sourceEnvValide(surcharges: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    ATTROUPE_BASE_URL: 'https://attroupe.test',
    ATTROUPE_SESSION_SECRET: secretFactice(),
    ATTROUPE_ENCRYPTION_KEY: secretFactice(),
    ATTROUPE_SIGNED_URL_SECRET: secretFactice(),
    ...surcharges,
  };
}

export function envValide(surcharges: NodeJS.ProcessEnv = {}): Env {
  return chargerEnv(sourceEnvValide(surcharges));
}
