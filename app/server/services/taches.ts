import type { Base } from '../db/base.js';
import { purgerAuthentification } from '../db/queries/comptes.js';
import { envoyerResumesQuotidiens } from '../db/queries/notifications.js';
import { JOUR_MS, MINUTE_MS, SECONDE_MS, versInstant } from '../domain/instant.js';
import type { Journal } from '../http/middleware/journal.js';
import { remettreFile, type Transporteur } from './brevo.js';

// Tâches périodiques du processus (architecture §2, `taches.ts`) : remise de la file d'e-mails toutes les
// 30 s, et entretien des sessions et jetons morts (une fois par heure environ). Une tâche qui échoue est
// journalisée et recommence au tour suivant : elle ne fait jamais tomber le processus.

export const INTERVALLE_FILE_MS = 30 * SECONDE_MS;
const INTERVALLE_PURGE_MS = 60 * MINUTE_MS;
/** On garde une semaine de sessions mortes avant de les effacer (diagnostic d'un appareil perdu). */
const CONSERVATION_MS = 7 * JOUR_MS;

export interface OptionsTaches {
  readonly base: Base;
  /** `undefined` : Brevo n'est pas configuré, les e-mails restent en file. */
  readonly transporteur: Transporteur | undefined;
  readonly journal: Journal;
  /** Racine publique de l'instance : les liens à jeton des e-mails en partent. */
  readonly baseUrl: string;
  readonly horloge?: () => Date;
  readonly intervalleFileMs?: number;
}

export interface Taches {
  /** Exécute la remise maintenant (tests, démarrage). */
  readonly remettreMaintenant: () => Promise<void>;
  /** Arrête les minuteries et attend la fin de la remise en cours. */
  readonly arreter: () => Promise<void>;
}

export function demarrerTaches(options: OptionsTaches): Taches {
  const horloge = options.horloge ?? ((): Date => new Date());
  let enCours: Promise<void> | undefined;
  let derniereCharge = 0;

  const remettre = async (): Promise<void> => {
    if (options.transporteur === undefined) return;
    try {
      const bilan = await remettreFile(options.base, options.transporteur, horloge(), options.baseUrl);
      if (bilan.envoyes + bilan.reportes + bilan.abandonnes + bilan.definitifs > 0) options.journal.info('email.remise', { ...bilan });
    } catch (erreur) {
      options.journal.error('email.remise_echec', { erreur: erreur instanceof Error ? erreur.message : String(erreur) });
    }
  };

  const entretenir = (): void => {
    try {
      const maintenant = horloge();
      if (maintenant.getTime() - derniereCharge < INTERVALLE_PURGE_MS) return;
      derniereCharge = maintenant.getTime();
      const purgees = purgerAuthentification(options.base, versInstant(new Date(maintenant.getTime() - CONSERVATION_MS)));
      if (purgees > 0) options.journal.info('auth.purge', { lignes: purgees });
      const resumes = envoyerResumesQuotidiens(options.base, options.baseUrl, maintenant);
      if (resumes > 0) options.journal.info('notifications.resumes_quotidiens', { emails: resumes });
    } catch (erreur) {
      options.journal.error('auth.purge_echec', { erreur: erreur instanceof Error ? erreur.message : String(erreur) });
    }
  };

  const tour = (): void => {
    // Pas de chevauchement : si la remise précédente (Brevo lent) n'est pas finie, on saute ce tour.
    if (enCours !== undefined) return;
    enCours = remettre().finally(() => {
      enCours = undefined;
    });
    entretenir();
  };

  const minuterie = setInterval(tour, options.intervalleFileMs ?? INTERVALLE_FILE_MS);
  minuterie.unref(); // une minuterie ne doit pas retenir le processus à l'arrêt

  return {
    remettreMaintenant: async () => {
      await enCours;
      enCours = remettre().finally(() => {
        enCours = undefined;
      });
      await enCours;
    },
    arreter: async () => {
      clearInterval(minuterie);
      await enCours;
    },
  };
}
