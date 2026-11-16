import type { GroupScope } from '../db/scope.js';
import { versInstant } from '../domain/instant.js';
import type { Journal } from '../http/middleware/journal.js';

// Le temps réel (architecture §3.2) : un flux SSE descendant PAR GROUPE. La diffusion est en mémoire, indexée par groupe.
//
// Ce que la spec dit peu et qui compte : une route ordinaire est courte, l'appartenance y est relue à chaque requête. Un flux, lui,
// reste ouvert des heures, et son appartenance n'a été prouvée qu'une fois, à l'ouverture. Sans précaution, quelqu'un retiré du groupe
// continuerait de recevoir tout ce qui s'y passe : une fuite entre groupes à retardement. Trois dispositions, indépendantes :
//  1. REVÉRIFICATION AVANT CHAQUE ENVOI (la garde qui ne peut pas être oubliée par une route future : elle est ici, pas dans les routes) —
//     `toujoursAutorise` relit l'appartenance (et la session) en base ; si elle a disparu, rien n'est écrit et le flux est fermé ;
//  2. le BATTEMENT de cœur passe par le même chemin : même sans aucune modification, un flux révoqué se ferme au battement suivant ;
//  3. FERMETURE ACTIVE quand l'appartenance change par l'API (retrait, départ) : `fermerMembre`, appelée là où `memberships` est modifiée.
// Le message est MINIMAL (type, identifiant, parent, auteur, instant) : jamais l'objet métier. Le client recharge ce qu'il a le droit de
// voir par les routes, qui passent par le scope. Ainsi rien de métier ne traverse le registre, même si l'indexation était fausse.

/** Ce qui est poussé. Forme stable : le lot 10 ajoute `message.*` (ressource `message`, parent = le fil) sans changer ce contrat. */
export interface EvenementTempsReel {
  /** `ressource.verbe` : `article.coche`, `liste.creee`, `tache.assignee`… */
  readonly type: string;
  /** Nature de ce que `id` désigne : `liste`, `article`, `tache` (puis `message`). */
  readonly ressource: string;
  readonly id: string;
  /** Conteneur de `id` quand il y en a un : la liste d'un article, l'événement d'une tâche, le fil d'un message. */
  readonly parent_id: string | null;
  /** Appartenance de l'auteur du changement (le client ignore ainsi l'écho de ses propres actions). */
  readonly par: string;
  /** Instant UTC du changement. */
  readonly at: string;
}

/** Ce que l'appelant fournit : `par` et `at` sont posés par le diffuseur, à partir du scope et de l'horloge. */
export type NouvelEvenement = Omit<EvenementTempsReel, 'par' | 'at'>;

/** Le canal d'un abonné, abstrait de HTTP. */
export interface SortieFlux {
  /** Écrit un bloc déjà formaté ; `false` : la sortie est fermée ou saturée (client trop lent), l'abonné est retiré. */
  readonly ecrire: (bloc: string) => boolean;
  /** Termine le flux côté serveur (idempotent). */
  readonly terminer: () => void;
}

export interface Connexion {
  /** Retire l'abonné du registre (fermeture, erreur de socket) ; idempotent. Ne termine PAS la sortie : le socket est déjà parti. */
  readonly retirer: () => void;
}

export interface OptionsDiffuseur {
  /** Période du battement de cœur (que le proxy ne coupe pas un flux silencieux : Nginx Proxy Manager ferme à 60 s sans octet). */
  readonly intervalleBattementMs?: number;
  /** Connexions simultanées maximales par compte, tous groupes confondus. */
  readonly plafondParCompte?: number;
  /** Connexions simultanées maximales, tous comptes confondus (`ATTROUPE_SSE_MAX_CONNECTIONS`). */
  readonly plafondGlobal?: number;
  readonly horloge?: () => Date;
  readonly journal?: Journal;
}

export const BATTEMENT_PAR_DEFAUT_MS = 25_000;
export const PLAFOND_PAR_COMPTE_PAR_DEFAUT = 8;
export const PLAFOND_GLOBAL_PAR_DEFAUT = 200;

interface Abonne {
  readonly userId: string;
  readonly groupId: string;
  readonly membershipId: string;
  readonly sortie: SortieFlux;
  readonly toujoursAutorise: () => boolean;
}

export class DiffuseurTempsReel {
  /** L'index qui compte : groupe → abonnés de CE groupe. Une diffusion ne lit que l'entrée du groupe du scope. */
  private readonly parGroupe = new Map<string, Set<Abonne>>();
  private readonly parCompte = new Map<string, Set<Abonne>>();
  private minuterie: NodeJS.Timeout | undefined;
  private readonly intervalle: number;
  private readonly plafond: number;
  private readonly plafondGlobal: number;
  /** Posé par `fermerTout` : plus aucune ouverture (sinon un flux ouvert pendant l'arrêt ferait attendre `server.close()`). */
  private arrete = false;
  private readonly horloge: () => Date;
  private readonly journal: Journal | undefined;

  constructor(options: OptionsDiffuseur = {}) {
    this.intervalle = options.intervalleBattementMs ?? BATTEMENT_PAR_DEFAUT_MS;
    this.plafond = options.plafondParCompte ?? PLAFOND_PAR_COMPTE_PAR_DEFAUT;
    this.plafondGlobal = options.plafondGlobal ?? PLAFOND_GLOBAL_PAR_DEFAUT;
    this.horloge = options.horloge ?? ((): Date => new Date());
    this.journal = options.journal;
  }

  /** Nombre de flux ouverts (tous groupes) ; pour les tests et l'exploitation. */
  get nombre(): number {
    let n = 0;
    for (const abonnes of this.parGroupe.values()) n += abonnes.size;
    return n;
  }

  /**
   * Inscrit un flux pour l'appartenance du scope. `undefined` : le compte (ou le processus) a atteint son plafond, ou le diffuseur est
   * arrêté (l'appelant répond 429 AVANT d'écrire les en-têtes). `toujoursAutorise` est la preuve rejouée avant chaque envoi : elle relit l'appartenance en base.
   */
  ouvrir(scope: GroupScope, sortie: SortieFlux, toujoursAutorise: () => boolean): Connexion | undefined {
    if (this.arrete || this.nombre >= this.plafondGlobal || (this.parCompte.get(scope.userId)?.size ?? 0) >= this.plafond) return undefined;
    const abonne: Abonne = { userId: scope.userId, groupId: scope.groupId, membershipId: scope.membershipId, sortie, toujoursAutorise };
    ajouter(this.parGroupe, abonne.groupId, abonne);
    ajouter(this.parCompte, abonne.userId, abonne);
    this.demarrerBattement();
    return { retirer: () => this.retirer(abonne) };
  }

  /** Pousse l'événement aux abonnés du groupe du scope, et à eux seuls ; chacun est revérifié juste avant l'écriture. Ne lève jamais. */
  diffuser(scope: GroupScope, evenement: NouvelEvenement): void {
    const abonnes = this.parGroupe.get(scope.groupId);
    if (abonnes === undefined) return;
    const complet: EvenementTempsReel = { ...evenement, par: scope.membershipId, at: versInstant(this.horloge()) };
    const bloc = `data: ${JSON.stringify(complet)}\n\n`;
    for (const abonne of [...abonnes]) this.envoyer(abonne, bloc);
  }

  /** Ferme les flux de CE membre dans CE groupe (retrait, départ). Les autres flux du même compte, dans d'autres groupes, ne bougent pas. */
  fermerMembre(scope: GroupScope, membreId: string): void {
    for (const abonne of [...(this.parGroupe.get(scope.groupId) ?? [])]) {
      if (abonne.membershipId === membreId) this.fermer(abonne);
    }
  }

  /** Battement de cœur : un commentaire SSE à chaque abonné, par le même chemin que les événements (donc revérifié). */
  battre(): void {
    for (const abonnes of [...this.parGroupe.values()]) for (const abonne of [...abonnes]) this.envoyer(abonne, ': battement\n\n');
  }

  /** Arrêt du processus : ferme tout, arrête la minuterie (sinon `server.close()` attendrait des flux qui ne finissent jamais). */
  fermerTout(): void {
    this.arrete = true;
    for (const abonnes of [...this.parGroupe.values()]) for (const abonne of [...abonnes]) this.fermer(abonne);
  }

  private envoyer(abonne: Abonne, bloc: string): void {
    let autorise = false;
    try {
      autorise = abonne.toujoursAutorise();
    } catch (erreur) {
      // En cas de doute, on ferme : un flux qu'on ne sait pas prouver n'est pas servi.
      this.journal?.error('temps_reel.verification_echec', { erreur: erreur instanceof Error ? erreur.message : String(erreur) });
    }
    if (!autorise) {
      this.fermer(abonne);
      return;
    }
    let ecrit = false;
    try {
      ecrit = abonne.sortie.ecrire(bloc);
    } catch (erreur) {
      this.journal?.warn('temps_reel.ecriture_echec', { erreur: erreur instanceof Error ? erreur.message : String(erreur) });
    }
    if (!ecrit) this.fermer(abonne);
  }

  private fermer(abonne: Abonne): void {
    this.retirer(abonne);
    try {
      abonne.sortie.terminer();
    } catch (erreur) {
      this.journal?.warn('temps_reel.fermeture_echec', { erreur: erreur instanceof Error ? erreur.message : String(erreur) });
    }
  }

  private retirer(abonne: Abonne): void {
    enlever(this.parGroupe, abonne.groupId, abonne);
    enlever(this.parCompte, abonne.userId, abonne);
    if (this.parGroupe.size === 0) this.arreterBattement();
  }

  private demarrerBattement(): void {
    if (this.minuterie !== undefined) return;
    this.minuterie = setInterval(() => this.battre(), this.intervalle);
    this.minuterie.unref();
  }

  private arreterBattement(): void {
    if (this.minuterie === undefined) return;
    clearInterval(this.minuterie);
    this.minuterie = undefined;
  }
}

function ajouter(index: Map<string, Set<Abonne>>, cle: string, abonne: Abonne): void {
  const ensemble = index.get(cle);
  if (ensemble === undefined) index.set(cle, new Set([abonne]));
  else ensemble.add(abonne);
}

function enlever(index: Map<string, Set<Abonne>>, cle: string, abonne: Abonne): void {
  const ensemble = index.get(cle);
  if (ensemble === undefined) return;
  ensemble.delete(abonne);
  if (ensemble.size === 0) index.delete(cle);
}
