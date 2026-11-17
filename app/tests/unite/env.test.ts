import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chargerEnv, ErreurConfiguration, ressembleAUnFactice } from '../../server/config/env.js';
import { secretFactice, sourceEnvValide } from '../fixtures/env.js';

const CLES_OBLIGATOIRES = [
  'ATTROUPE_BASE_URL',
  'ATTROUPE_SESSION_SECRET',
  'ATTROUPE_ENCRYPTION_KEY',
  'ATTROUPE_SIGNED_URL_SECRET',
] as const;

function problemesDe(source: NodeJS.ProcessEnv): readonly string[] {
  try {
    chargerEnv(source);
  } catch (erreur) {
    if (erreur instanceof ErreurConfiguration) return erreur.problemes;
    throw erreur;
  }
  throw new Error("chargerEnv aurait dû refuser cette configuration.");
}

describe('config/env : validation de l’environnement', () => {
  it('applique les valeurs par défaut documentées', () => {
    const env = chargerEnv(sourceEnvValide());
    expect(env).toMatchObject({
      ATTROUPE_DATA_DIR: '/data',
      ATTROUPE_REGISTRATION: 'open',
      ATTROUPE_IMMICH_ALLOW_PRIVATE: false,
      ATTROUPE_TRUST_PROXY: 1,
      ATTROUPE_LOG_LEVEL: 'info',
      TZ: 'Europe/Paris',
    });
  });

  it.each(CLES_OBLIGATOIRES)('refuse de démarrer sans %s', (cle) => {
    const source = sourceEnvValide();
    source[cle] = undefined;
    const problemes = problemesDe(source);
    expect(problemes.some((p) => p.startsWith(cle))).toBe(true);
  });

  it('traite une valeur vide comme une clé absente', () => {
    expect(problemesDe(sourceEnvValide({ ATTROUPE_SESSION_SECRET: '' }))).toHaveLength(1);
  });

  it('refuse un secret de moins de 32 octets', () => {
    const court = Buffer.from('trop-court').toString('base64');
    const problemes = problemesDe(sourceEnvValide({ ATTROUPE_ENCRYPTION_KEY: court }));
    expect(problemes[0]).toContain('32 octets');
  });

  it('signale tous les problèmes en une seule fois', () => {
    expect(problemesDe({ NODE_ENV: 'test' })).toHaveLength(CLES_OBLIGATOIRES.length);
  });

  it('exige un expéditeur dès que Brevo est configuré', () => {
    const problemes = problemesDe(sourceEnvValide({ BREVO_API_KEY: 'xkeysib-factice' }));
    expect(problemes[0]).toContain('BREVO_SENDER_EMAIL');
  });

  it('accepte Brevo complètement renseigné', () => {
    const env = chargerEnv(
      sourceEnvValide({ BREVO_API_KEY: 'xkeysib-factice', BREVO_SENDER_EMAIL: 'no-reply@attroupe.test' }),
    );
    expect(env.BREVO_SENDER_EMAIL).toBe('no-reply@attroupe.test');
  });

  it('accepte un secret de 32 octets exactement', () => {
    expect(() => chargerEnv(sourceEnvValide({ ATTROUPE_SESSION_SECRET: secretFactice() }))).not.toThrow();
  });

  describe('secrets factices', () => {
    const cle = 'ATTROUPE_SESSION_SECRET';
    const refus: ReadonlyArray<[string, string, string]> = [
      ['non canonique (43 « a »)', 'a'.repeat(43), 'base64 canonique'],
      ['répété (octets nuls)', Buffer.alloc(32).toString('base64'), 'aléatoire'],
      ['répété (motif de 2 octets)', Buffer.from('ab'.repeat(16)).toString('base64'), 'aléatoire'],
      ['avec tirets (modèle copié)', 'remplacez-moi-par-openssl-rand-base64-32-xxxx', 'valeur d\'exemple'],
      ['A_GENERER_AVEC_openssl_rand_base64_32', 'A_GENERER_AVEC_openssl_rand_base64_32', 'base64 canonique'],
      ['contenant « secret » (casse)', `sEcReT${secretFactice().slice(6)}`, 'valeur d\'exemple'],
    ];

    it.each(refus)('refuse un secret %s', (_nom, valeur, extrait) => {
      const problemes = problemesDe(sourceEnvValide({ [cle]: valeur }));
      expect(problemes).toHaveLength(1);
      expect(problemes[0]).toContain(extrait);
    });

    it.each(['remplacer', 'REMPLACEZ', 'changer', 'Change', 'exemple', 'Example', 'TODO', 'Secret', 'rémplacer'])(
      'reconnaît le marqueur « %s »',
      (mot) => {
        expect(ressembleAUnFactice(`xx${mot}yy`)).toBe(true);
      },
    );

    it('refuse deux secrets identiques', () => {
      const commun = secretFactice();
      const problemes = problemesDe(
        sourceEnvValide({ ATTROUPE_SESSION_SECRET: commun, ATTROUPE_ENCRYPTION_KEY: commun }),
      );
      expect(problemes).toHaveLength(1);
      expect(problemes[0]).toContain('ATTROUPE_ENCRYPTION_KEY : doit différer de ATTROUPE_SESSION_SECRET');
    });
  });

  describe('URL de base', () => {
    it.each(['localhost:3000', 'javascript:alert(1)', 'attroupe.fr', 'ftp://attroupe.fr'])(
      'refuse « %s » (schéma http ou https exigé)',
      (url) => {
        expect(problemesDe(sourceEnvValide({ ATTROUPE_BASE_URL: url }))[0]).toMatch(/^ATTROUPE_BASE_URL/);
      },
    );

    it.each(['https://attroupe.fr/app', 'https://attroupe.fr/?a=1', 'https://attroupe.fr/#x', 'https://attroupe.fr?'])(
      'refuse « %s » (chemin, requête ou fragment)',
      (url) => {
        expect(problemesDe(sourceEnvValide({ ATTROUPE_BASE_URL: url }))[0]).toContain('origine seule');
      },
    );

    it('accepte http hors production, avec port', () => {
      expect(chargerEnv(sourceEnvValide({ ATTROUPE_BASE_URL: 'http://localhost:3000' })).ATTROUPE_BASE_URL).toBe(
        'http://localhost:3000',
      );
    });

    it('refuse http en production', () => {
      const problemes = problemesDe(sourceEnvValide({ NODE_ENV: 'production', ATTROUPE_BASE_URL: 'http://attroupe.fr' }));
      expect(problemes).toEqual(['ATTROUPE_BASE_URL : doit être en https en production']);
    });

    it('accepte https en production', () => {
      expect(() => chargerEnv(sourceEnvValide({ NODE_ENV: 'production' }))).not.toThrow();
    });
  });

  it('formule les messages de Zod en français', () => {
    const problemes = problemesDe(sourceEnvValide({ PORT: 'abc' }));
    expect(problemes[0]).toMatch(/^PORT : Entrée invalide/);
    expect(problemes[0]).not.toMatch(/expected|received|Invalid/);
  });

  it('a toutes ses clés documentées dans .env.example', () => {
    const exemple = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    for (const cle of [
      ...CLES_OBLIGATOIRES,
      'ATTROUPE_TAG',
      'ATTROUPE_PORT',
      'ATTROUPE_DATA_DIR',
      'BREVO_API_KEY',
      'BREVO_SENDER_EMAIL',
      'BREVO_SENDER_NAME',
      'ATTROUPE_REGISTRATION',
      'ATTROUPE_IMMICH_ALLOW_PRIVATE',
      'ATTROUPE_TRUST_PROXY',
      'ATTROUPE_LOG_LEVEL',
      'ATTROUPE_SSE_MAX_CONNECTIONS',
      'TZ',
    ]) {
      expect(exemple, `clé ${cle} absente de .env.example`).toMatch(new RegExp(`^#? ?${cle}=`, 'm'));
    }
  });

  describe('VAPID (notifications push)', () => {
    it('refuse une moitié de paire : la clé ignorée serait remplacée en silence par une clé générée', () => {
      expect(problemesDe(sourceEnvValide({ ATTROUPE_VAPID_PUBLIC_KEY: 'abc' })).join('\n')).toMatch(/ATTROUPE_VAPID_PRIVATE_KEY/);
      expect(problemesDe(sourceEnvValide({ ATTROUPE_VAPID_PRIVATE_KEY: 'abc' })).join('\n')).toMatch(/ATTROUPE_VAPID_PUBLIC_KEY/);
    });

    it('accepte la paire complète ou aucune', () => {
      expect(() => chargerEnv(sourceEnvValide())).not.toThrow();
      expect(() => chargerEnv(sourceEnvValide({ ATTROUPE_VAPID_PUBLIC_KEY: 'a', ATTROUPE_VAPID_PRIVATE_KEY: 'b' }))).not.toThrow();
    });

    it('exige un sujet mailto: ou https: (RFC 8292)', () => {
      expect(problemesDe(sourceEnvValide({ ATTROUPE_VAPID_SUBJECT: 'contact@exemple.fr' })).join('\n')).toMatch(/ATTROUPE_VAPID_SUBJECT/);
      expect(problemesDe(sourceEnvValide({ ATTROUPE_VAPID_SUBJECT: 'http://exemple.fr' })).join('\n')).toMatch(/ATTROUPE_VAPID_SUBJECT/);
      expect(() => chargerEnv(sourceEnvValide({ ATTROUPE_VAPID_SUBJECT: 'mailto:contact@exemple.fr' }))).not.toThrow();
      expect(() => chargerEnv(sourceEnvValide({ ATTROUPE_VAPID_SUBJECT: 'https://exemple.fr/contact' }))).not.toThrow();
    });
  });
});
