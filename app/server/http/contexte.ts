import type { Base } from '../db/base.js';
import type { Env } from '../config/env.js';
import type { Horloge, LimiteurCadence, ReglesCadence } from '../services/cadence.js';
import type { DiffuseurTempsReel } from '../services/temps-reel.js';
import type { ParametresScrypt } from '../services/mot-de-passe.js';
import type { DnsLookupImmich, FetchImmich } from '../services/immich-client.js';
import type { DependancesAgenda } from '../services/agenda-externe.js';
import type { Journal } from './middleware/journal.js';

/** Tout ce dont les routes et intergiciels ont besoin, assemblé une fois dans `creerApp` (rien n'est global : les tests injectent). */
export interface Contexte {
  readonly base: Base;
  readonly env: Env;
  readonly journal: Journal;
  readonly horloge: Horloge;
  readonly limiteur: LimiteurCadence;
  readonly regles: ReglesCadence;
  readonly parametresScrypt: ParametresScrypt;
  /** Durée minimale de la réponse à « mot de passe oublié » : masque l'écart entre adresse connue et inconnue. */
  readonly delaiMinimalOubliMs: number;
  /** Les cookies ne sont `Secure` que si l'instance est servie en https (toujours le cas en production, cf. env.ts). */
  readonly cookieSecurise: boolean;
  /** Diffusion en mémoire du flux temps réel, indexée par groupe (services/temps-reel.ts). */
  readonly diffuseur: DiffuseurTempsReel;
  /** Doubles injectables en test pour les appels sortants vers Immich. */
  readonly fetchImmich?: FetchImmich;
  readonly dnsLookupImmich?: DnsLookupImmich;
  /** Doubles injectables en test pour la récupération des agendas externes (ADR-0013). */
  readonly agendaExterne?: DependancesAgenda;
}
