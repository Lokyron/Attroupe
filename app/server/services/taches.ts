import type { Base } from '../db/base.js';
import { purgerAuthentification } from '../db/queries/comptes.js';
import { envoyerResumesQuotidiens } from '../db/queries/notifications.js';
import { porteeDeLaSource } from '../db/portee-tache.js';
import { sourcesAFaire } from '../db/queries/agenda-externe.js';
import { purgerAbonnementsRevoques } from '../db/queries/transverse.js';
import { JOUR_MS, MINUTE_MS, SECONDE_MS, versInstant } from '../domain/instant.js';
import type { Journal } from '../http/middleware/journal.js';
import { synchroniserSource, type DependancesAgenda } from './agenda-externe.js';
import { remettreFile, type Transporteur } from './brevo.js';

// Tâches périodiques du processus (architecture §2, `taches.ts`) : remise de la file d'e-mails toutes les
// 30 s, import des agendas externes toutes les 5 min (asynchrone, donc hors de `entretenir`), et entretien des sessions et jetons morts (une fois par heure environ). Une tâche qui échoue est
// journalisée et recommence au tour suivant : elle ne fait jamais tomber le processus.

export const INTERVALLE_FILE_MS = 30 * SECONDE_MS;
export const INTERVALLE_IMPORT_MS = 5 * MINUTE_MS;
/** Sources traitées par tour, l'une après l'autre : un tour borne ainsi les requêtes sortantes qu'il émet. */
const SOURCES_PAR_TOUR = 3;
const INTERVALLE_PURGE_MS = 60 * MINUTE_MS;
/** On garde une semaine de sessions mortes avant de les effacer (diagnostic d'un appareil perdu). */
const CONSERVATION_MS = 7 * JOUR_MS;
/** Un abonnement iCal révoqué reste visible un mois dans « Mon compte », puis sa ligne est effacée. */
const CONSERVATION_ABONNEMENTS_REVOQUES_MS = 30 * JOUR_MS;

export interface OptionsTaches {
  readonly base: Base;
  /** `undefined` : Brevo n'est pas configuré, les e-mails restent en file. */
  readonly transporteur: Transporteur | undefined;
  readonly journal: Journal;
  /** Racine publique de l'instance : les liens à jeton des e-mails en partent. */
  readonly baseUrl: string;
  readonly horloge?: () => Date;
  readonly intervalleFileMs?: number;
  /** `ATTROUPE_ENCRYPTION_KEY` : sans elle, l'import des agendas externes n'a pas lieu (les URL ne se déchiffrent pas). */
  readonly cleChiffrement?: string | undefined;
  readonly intervalleImportMs?: number;
  readonly agendaExterne?: DependancesAgenda;
}

export interface Taches {
  /** Exécute la remise maintenant (tests, démarrage). */
  readonly remettreMaintenant: () => Promise<void>;
  /** Exécute un tour d'import des agendas externes maintenant (tests). */
  readonly importerMaintenant: () => Promise<void>;
  /** Arrête les minuteries et attend la fin de la remise en cours. */
  readonly arreter: () => Promise<void>;
}

export function demarrerTaches(options: OptionsTaches): Taches {
  const horloge = options.horloge ?? ((): Date => new Date());
  let enCours: Promise<void> | undefined;
  let importEnCours: Promise<void> | undefined;
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

  const importer = async (): Promise<void> => {
    const cle = options.cleChiffrement;
    if (cle === undefined) return;
    try {
      const maintenant = horloge();
      const bilan = { sources: 0, importees: 0, inchangees: 0, echecs: 0, desactivees: 0, erreurs: 0 };
      // Séquentiel : une source après l'autre, jamais de rafale vers des tiers.
      for (const due of sourcesAFaire(options.base, versInstant(maintenant), SOURCES_PAR_TOUR)) {
        bilan.sources++;
        try {
          const resultat = await synchroniserSource(
            { cleChiffrement: cle, horloge, journal: options.journal, dependances: options.agendaExterne },
            porteeDeLaSource(options.base, due),
            due.id,
          );
          if (resultat === undefined) continue;
          if (resultat.desactivee) bilan.desactivees++;
          if (resultat.modifiee) bilan.importees++;
          else if (resultat.statut === 'ok' || resultat.statut === 'vide') bilan.inchangees++;
          else bilan.echecs++;
        } catch (erreur) {
          bilan.erreurs++;
          options.journal.error('agenda.import_erreur', { source: due.id, erreur: erreur instanceof Error ? erreur.message : String(erreur) });
        }
      }
      // Un tour fait uniquement de 304 ne dit rien : il se répète toutes les 2 h pour chaque source.
      if (bilan.importees + bilan.echecs + bilan.desactivees + bilan.erreurs > 0) options.journal.info('agenda.import', bilan);
    } catch (erreur) {
      options.journal.error('agenda.import_erreur', { erreur: erreur instanceof Error ? erreur.message : String(erreur) });
    }
  };

  const tourImport = (): void => {
    // Pas de chevauchement : un fournisseur lent (20 s par source au plus) ne doit pas empiler les tours.
    if (importEnCours !== undefined) return;
    importEnCours = importer().finally(() => {
      importEnCours = undefined;
    });
  };

  const entretenir = (): void => {
    try {
      const maintenant = horloge();
      if (maintenant.getTime() - derniereCharge < INTERVALLE_PURGE_MS) return;
      derniereCharge = maintenant.getTime();
      const purgees = purgerAuthentification(options.base, versInstant(new Date(maintenant.getTime() - CONSERVATION_MS)));
      if (purgees > 0) options.journal.info('auth.purge', { lignes: purgees });
      const abonnements = purgerAbonnementsRevoques(options.base, versInstant(new Date(maintenant.getTime() - CONSERVATION_ABONNEMENTS_REVOQUES_MS)));
      if (abonnements > 0) options.journal.info('flux.purge', { lignes: abonnements });
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
  const minuterieImport = setInterval(tourImport, options.intervalleImportMs ?? INTERVALLE_IMPORT_MS);
  minuterieImport.unref();

  return {
    remettreMaintenant: async () => {
      await enCours;
      enCours = remettre().finally(() => {
        enCours = undefined;
      });
      await enCours;
    },
    importerMaintenant: async () => {
      await importEnCours;
      importEnCours = importer().finally(() => {
        importEnCours = undefined;
      });
      await importEnCours;
    },
    arreter: async () => {
      clearInterval(minuterie);
      clearInterval(minuterieImport);
      await enCours;
      await importEnCours;
    },
  };
}
