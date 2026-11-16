import { z } from 'zod';

// Tous les messages de validation de Zod en français (règle du projet).
z.config(z.locales.fr());

/** Erreur de configuration : le démarrage doit s'arrêter, sans trace d'appel inutile. */
export class ErreurConfiguration extends Error {
  constructor(public readonly problemes: readonly string[]) {
    super(
      `Configuration invalide :\n${problemes.map((p) => `  - ${p}`).join('\n')}\n` +
        'Voir .env.example pour la liste des clés attendues.',
    );
    this.name = 'ErreurConfiguration';
  }
}

/** Mots qui trahissent une valeur recopiée depuis un exemple ou un modèle. */
const MARQUEURS_FACTICES = /remplacer|remplacez|changer|change|exemple|example|todo|secret/;

/** Minuscules et sans accents : « Échantillon » et « echantillon » comptent pour la même chose. */
function normaliser(valeur: string): string {
  return valeur.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Vrai si la valeur ressemble à un texte d'exemple plutôt qu'à un vrai secret. */
export function ressembleAUnFactice(valeur: string): boolean {
  return MARQUEURS_FACTICES.test(normaliser(valeur));
}

const OCTETS_MIN = 32;
/** Un tirage aléatoire de 32 octets en donne ~30 distincts ; une répétition, 1 à 5. */
const OCTETS_DISTINCTS_MIN = 16;

/**
 * Secret de 32 octets au minimum, en base64 canonique (ex. `openssl rand -base64 32`),
 * avec une entropie réelle et sans marqueur d'exemple.
 */
const secret = z
  .string({ error: 'clé obligatoire absente' })
  .refine((v) => !ressembleAUnFactice(v), {
    message: "ressemble à une valeur d'exemple : générez-la avec « openssl rand -base64 32 »",
    abort: true,
  })
  .refine((v) => Buffer.from(v, 'base64').toString('base64') === v, {
    message: 'doit être du base64 canonique (openssl rand -base64 32)',
    abort: true,
  })
  .refine((v) => Buffer.from(v, 'base64').length >= OCTETS_MIN, {
    message: 'doit faire au moins 32 octets une fois décodé (openssl rand -base64 32)',
    abort: true,
  })
  .refine((v) => new Set(Buffer.from(v, 'base64')).size >= OCTETS_DISTINCTS_MIN, {
    message: "n'est pas assez aléatoire (octets trop répétés) : utilisez « openssl rand -base64 32 »",
    abort: true,
  });

/** URL publique de l'instance : origine seule (ni chemin, ni requête, ni fragment). */
const urlPublique = z
  .url({
    protocol: /^https?$/,
    error: 'clé obligatoire : URL publique complète en http(s) (ex. https://attroupe.fr)',
  })
  .refine(
    (v) => {
      if (!URL.canParse(v)) return true; // déjà signalé par z.url
      const url = new URL(v);
      return url.pathname === '/' && !v.includes('?') && !v.includes('#') && url.username === '' && url.password === '';
    },
    { message: "doit être l'origine seule, sans chemin, requête, fragment ni identifiants (ex. https://attroupe.fr)" },
  );

const booleen = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Une valeur vide (`CLE=`) équivaut à une clé absente : le défaut s'applique. */
const videEnAbsent = (valeur: unknown): unknown => (valeur === '' ? undefined : valeur);

const schemaEnv = z
  .object({
    NODE_ENV: z.preprocess(videEnAbsent, z.enum(['development', 'production', 'test']).default('development')),
    PORT: z.preprocess(videEnAbsent, z.coerce.number().int().min(1).max(65535).default(3000)),
    ATTROUPE_BASE_URL: z.preprocess(
      videEnAbsent,
      urlPublique,
    ),
    ATTROUPE_DATA_DIR: z.preprocess(videEnAbsent, z.string().min(1).default('/data')),
    ATTROUPE_SESSION_SECRET: z.preprocess(videEnAbsent, secret),
    ATTROUPE_ENCRYPTION_KEY: z.preprocess(videEnAbsent, secret),
    ATTROUPE_SIGNED_URL_SECRET: z.preprocess(videEnAbsent, secret),
    BREVO_API_KEY: z.preprocess(videEnAbsent, z.string().min(1).optional()),
    BREVO_SENDER_EMAIL: z.preprocess(videEnAbsent, z.email().optional()),
    BREVO_SENDER_NAME: z.preprocess(videEnAbsent, z.string().min(1).optional()),
    // Adresse de l'API transactionnelle : ne se change que pour viser un faux serveur local (tests, développement).
    BREVO_API_URL: z.preprocess(
      videEnAbsent,
      z.url({ protocol: /^https?$/, error: 'doit être une URL http(s) complète (ex. https://api.brevo.com/v3)' }).default('https://api.brevo.com/v3'),
    ),
    ATTROUPE_REGISTRATION: z.preprocess(videEnAbsent, z.enum(['open', 'invite']).default('open')),
    ATTROUPE_IMMICH_ALLOW_PRIVATE: z.preprocess(videEnAbsent, booleen.default(false)),
    ATTROUPE_TRUST_PROXY: z.preprocess(videEnAbsent, z.coerce.number().int().min(0).default(1)),
    ATTROUPE_LOG_LEVEL: z.preprocess(videEnAbsent, z.enum(['debug', 'info', 'warn', 'error']).default('info')),
    ATTROUPE_SSE_MAX_CONNECTIONS: z.preprocess(videEnAbsent, z.coerce.number().int().min(1).max(100_000).default(200)),
    TZ: z.preprocess(videEnAbsent, z.string().min(1).default('Europe/Paris')),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.ATTROUPE_BASE_URL.startsWith('https:')) {
      ctx.addIssue({
        code: 'custom',
        path: ['ATTROUPE_BASE_URL'],
        message: 'doit être en https en production',
      });
    }

    // Un secret réutilisé annule l'isolation entre sessions, chiffrement et URL signées.
    const secrets = ['ATTROUPE_SESSION_SECRET', 'ATTROUPE_ENCRYPTION_KEY', 'ATTROUPE_SIGNED_URL_SECRET'] as const;
    secrets.forEach((cle, i) => {
      const doublon = secrets.slice(0, i).find((autre) => env[autre] === env[cle]);
      if (doublon !== undefined) {
        ctx.addIssue({ code: 'custom', path: [cle], message: `doit différer de ${doublon}` });
      }
    });

    // La clé d'API voyage dans chaque appel : en production, jamais en clair sur le réseau.
    if (env.NODE_ENV === 'production' && !env.BREVO_API_URL.startsWith('https:')) {
      ctx.addIssue({ code: 'custom', path: ['BREVO_API_URL'], message: 'doit être en https en production' });
    }

    // Brevo est optionnel, mais une clé d'API sans expéditeur ne peut rien envoyer.
    if (env.BREVO_API_KEY !== undefined && env.BREVO_SENDER_EMAIL === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['BREVO_SENDER_EMAIL'],
        message: 'obligatoire dès que BREVO_API_KEY est renseignée',
      });
    }
  });

export type Env = z.infer<typeof schemaEnv>;

/**
 * Lit et valide l'environnement. Lève une ErreurConfiguration qui liste TOUS les
 * problèmes d'un coup, pour qu'un administrateur n'ait pas à relancer dix fois.
 */
export function chargerEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const resultat = schemaEnv.safeParse(source);
  if (!resultat.success) {
    throw new ErreurConfiguration(
      resultat.error.issues.map((i) => `${i.path.join('.') || 'environnement'} : ${i.message}`),
    );
  }
  return resultat.data;
}
