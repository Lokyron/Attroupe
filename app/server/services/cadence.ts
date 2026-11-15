import { HEURE_MS, MINUTE_MS } from '../domain/instant.js';

// Limitation de débit (architecture §5) : compteurs EN MÉMOIRE, par clé (adresse IP, adresse e-mail…).
// Un seul processus, donc pas de partage à gérer ; un redémarrage remet les compteurs à zéro, ce qui est
// acceptable (le but est de ralentir une devinette, pas de tenir une comptabilité).
//
// Principe : au plus `max` tentatives par fenêtre. La tentative suivante est refusée ET ouvre un blocage
// dont la durée double à chaque récidive (fenêtre × 2^(récidives-1), plafonné) — le « report exponentiel ».
// Une fois le blocage levé et la fenêtre écoulée, le compteur repart de zéro ; les récidives ne
// s'oublient qu'après `OUBLI_RECIDIVES_MS` de calme, pour qu'un attaquant patient ne reparte pas à 15 min.

export interface RegleCadence {
  /** Tentatives admises par fenêtre. */
  readonly max: number;
  readonly fenetreMs: number;
}

export type Horloge = () => Date;

interface Compteur {
  debutFenetre: number;
  tentatives: number;
  bloqueJusqua: number;
  recidives: number;
  derniereActivite: number;
}

/**
 * `rembourser` annule le débit de CETTE tentative : à appeler quand la requête n'a rien coûté ni rien appris à
 * l'appelant (503 : file de hachage pleine, aucun mot de passe n'a été essayé). Sans effet au-delà du premier appel.
 */
export type VerdictCadence =
  | { readonly autorise: true; readonly rembourser: () => void }
  | { readonly autorise: false; readonly retryApresSecondes: number };

export type NomCadence = 'connexion' | 'inscription' | 'oubli' | 'jeton' | 'changement' | 'renvoi' | 'invitation' | 'groupe';

export interface CleCadence {
  readonly cle: string;
  readonly regle: RegleCadence;
}

const BLOCAGE_MAX_MS = 12 * HEURE_MS;
const OUBLI_RECIDIVES_MS = 24 * HEURE_MS;
/**
 * Plafond de clés suivies. Une clé est une adresse IP ou e-mail choisie par l'appelant : sans borne, un
 * client qui en invente à volonté ferait gonfler la mémoire. Deux garde-fous, dans cet ordre :
 *  - une requête refusée par un blocage en cours NE CRÉE AUCUNE clé (elle ne coûte rien à l'attaquant : si elle
 *    en créait, il saturerait la table gratuitement) ;
 *  - au plafond, on oublie d'abord les clés mortes, puis les plus anciennes clés NON bloquées. Une clé dont le
 *    blocage court n'est JAMAIS évincée : s'il n'y a plus de place sans en évincer une, la requête est refusée.
 * Limite assumée : évincer une clé non bloquée remet son compteur à zéro (au plus une fenêtre d'essais regagnée,
 * jamais un blocage levé) ; il faut des centaines d'adresses distinctes pour y arriver. Le plafond de hachages
 * simultanés (services/mot-de-passe.ts) ne dépend d'aucune clé.
 */
const CLES_MAX = 50_000;
/** Attente annoncée quand la table est pleine de blocages en cours. */
const SATURATION_RETRY_S = 60;

export class LimiteurCadence {
  private readonly compteurs = new Map<string, Compteur>();

  constructor(private readonly horloge: Horloge) {}

  /**
   * Enregistre une tentative sur ces clés et dit si elle passe.
   *  1. Si une clé DÉJÀ CONNUE bloque, la requête est refusée sans rien débiter ni créer.
   *  2. Sinon on réserve la place des clés nouvelles (sans jamais évincer un blocage en cours).
   *  3. Puis toutes les clés sont débitées ; le verdict est le plus long des blocages que ce débit ouvre.
   */
  tenter(regles: readonly CleCadence[]): VerdictCadence {
    const maintenant = this.horloge().getTime();
    let attenteMs = 0;
    for (const { cle } of regles) {
      const c = this.compteurs.get(cle);
      if (c !== undefined && maintenant < c.bloqueJusqua) attenteMs = Math.max(attenteMs, c.bloqueJusqua - maintenant);
    }
    if (attenteMs > 0) return refus(attenteMs);

    const nouvelles = new Set(regles.map((r) => r.cle).filter((cle) => !this.compteurs.has(cle)));
    if (!this.reserverPlaces(nouvelles.size, maintenant)) return { autorise: false, retryApresSecondes: SATURATION_RETRY_S };

    const debites: Compteur[] = [];
    for (const { cle, regle } of regles) {
      const { attente, compteur } = this.debiter(cle, regle, maintenant);
      attenteMs = Math.max(attenteMs, attente);
      debites.push(compteur);
    }
    if (attenteMs > 0) return refus(attenteMs);
    let rembourse = false;
    return {
      autorise: true,
      rembourser: () => {
        if (rembourse) return;
        rembourse = true;
        for (const c of debites) c.tentatives = Math.max(0, c.tentatives - 1);
      },
    };
  }

  /** Remet une clé à zéro (ex. : connexion réussie pour cette adresse e-mail). */
  oublier(cle: string): void {
    this.compteurs.delete(cle);
  }

  /** Nombre de clés suivies (tests, diagnostic). */
  get taille(): number {
    return this.compteurs.size;
  }

  private debiter(cle: string, regle: RegleCadence, maintenant: number): { attente: number; compteur: Compteur } {
    let c = this.compteurs.get(cle);
    if (c === undefined) {
      c = { debutFenetre: maintenant, tentatives: 0, bloqueJusqua: 0, recidives: 0, derniereActivite: maintenant };
    } else {
      // Réinsertion en fin de table : l'ordre d'insertion sert d'ordre d'ancienneté pour l'éviction.
      this.compteurs.delete(cle);
    }
    this.compteurs.set(cle, c);

    if (c.recidives > 0 && maintenant - c.derniereActivite > OUBLI_RECIDIVES_MS) c.recidives = 0;
    if (maintenant - c.debutFenetre >= regle.fenetreMs) {
      c.debutFenetre = maintenant;
      c.tentatives = 0;
    }
    c.derniereActivite = maintenant;
    c.tentatives++;
    if (c.tentatives <= regle.max) return { attente: 0, compteur: c };

    c.recidives++;
    const blocage = Math.min(regle.fenetreMs * 2 ** (c.recidives - 1), BLOCAGE_MAX_MS);
    c.bloqueJusqua = maintenant + blocage;
    c.tentatives = 0;
    c.debutFenetre = c.bloqueJusqua;
    return { attente: blocage, compteur: c };
  }

  /** Fait de la place pour `n` clés nouvelles. Faux (et rien d'évincé) si cela exigerait d'oublier un blocage en cours. */
  private reserverPlaces(n: number, maintenant: number): boolean {
    if (this.compteurs.size + n <= CLES_MAX) return true;
    // D'abord les clés mortes (aucun blocage en cours, inactives depuis plus d'une fenêtre généreuse)…
    for (const [cle, c] of this.compteurs) {
      if (c.bloqueJusqua <= maintenant && maintenant - c.derniereActivite > 15 * MINUTE_MS) this.compteurs.delete(cle);
    }
    const manque = this.compteurs.size + n - CLES_MAX;
    if (manque <= 0) return true;
    // … sinon les plus anciennes NON bloquées, par paquets (10 %) : l'éviction reste amortie au lieu de balayer la table à chaque ajout.
    const candidates: string[] = [];
    for (const [cle, c] of this.compteurs) {
      if (c.bloqueJusqua <= maintenant) candidates.push(cle);
      if (candidates.length >= manque + Math.ceil(CLES_MAX / 10)) break;
    }
    if (candidates.length < manque) return false;
    for (const cle of candidates) this.compteurs.delete(cle);
    return true;
  }
}

function refus(attenteMs: number): VerdictCadence {
  return { autorise: false, retryApresSecondes: Math.max(1, Math.ceil(attenteMs / 1000)) };
}

/**
 * Règles d'une route, en tentatives par fenêtre de 15 minutes (architecture §5 : 10 tentatives / 15 min).
 *  - `couple`  : (adresse e-mail visée, adresse IP) — la limite « de base » : un tiers qui martèle une adresse
 *    depuis SON adresse IP ne bloque que lui-même, jamais le propriétaire qui vient d'ailleurs ;
 *  - `email`   : l'adresse e-mail visée, toutes IP confondues — beaucoup plus large, elle ne retient qu'une
 *    attaque répartie sur de nombreuses adresses ;
 *  - `ip`      : l'adresse IP (IPv6 ramenée à son /64), toutes cibles confondues ;
 *  - `reseau`  : le préfixe /48 des IPv6 (un abonné y choisit 2^16 préfixes /64 : sans cette clé, la limite par /64 se contourne) ;
 *  - `compte`  : le compte de la session (routes authentifiées) ;
 *  - `cibleGroupe` : (adresse e-mail OU nom d'utilisateur visé, groupe de l'URL) — le « couple » d'une invitation : un administrateur
 *    qui martèle une cible depuis SON groupe n'épuise que cette clé, jamais celle d'un autre groupe ;
 *  - `cible`   : la cible seule, tous groupes confondus — beaucoup plus large, elle ne retient que l'inondation d'une boîte (ou d'un
 *    compte) par de nombreux groupes. Limite assumée : qui dispose de nombreux groupes peut l'épuiser, d'où son seuil large
 *    et le report exponentiel (jamais un blocage définitif).
 */
export interface ReglesRoute {
  readonly ip: RegleCadence;
  readonly reseau: RegleCadence;
  readonly couple?: RegleCadence;
  readonly email?: RegleCadence;
  readonly compte?: RegleCadence;
  readonly cibleGroupe?: RegleCadence;
  readonly cible?: RegleCadence;
}

export type ReglesCadence = Readonly<Record<NomCadence, ReglesRoute>>;

const FENETRE_MS = 15 * MINUTE_MS;
const parFenetre = (max: number): RegleCadence => ({ max, fenetreMs: FENETRE_MS });

export const REGLES_PAR_DEFAUT: ReglesCadence = Object.freeze({
  // Connexion : 10 mots de passe essayés par couple (e-mail, IP) ; ~100 toutes IP confondues sur un même compte.
  // Par IP : plus large, pour qu'un foyer ou une salle derrière une même adresse ne se bloque pas mutuellement.
  connexion: { couple: parFenetre(10), email: parFenetre(100), ip: parFenetre(30), reseau: parFenetre(90) },
  inscription: { couple: parFenetre(5), email: parFenetre(30), ip: parFenetre(10), reseau: parFenetre(30) },
  // Chaque demande acceptée envoie un e-mail à un tiers : on est plus strict qu'à la connexion.
  oubli: { couple: parFenetre(5), email: parFenetre(30), ip: parFenetre(20), reseau: parFenetre(60) },
  /** Consommation d'un jeton (vérification, réinitialisation) : le jeton ne se devine pas, l'IP suffit. */
  jeton: { ip: parFenetre(30), reseau: parFenetre(90) },
  /** Changement de mot de passe : chaque essai devine l'ancien mot de passe d'un compte dont la session est ouverte. */
  changement: { compte: parFenetre(5), ip: parFenetre(30), reseau: parFenetre(90) },
  /** Renvoi du mail de vérification : chaque demande envoie un e-mail. */
  renvoi: { compte: parFenetre(3), ip: parFenetre(10), reseau: parFenetre(30) },
  /**
   * Émission d'une invitation (lot 3) : c'est l'outil du harcèlement. Par compte (un administrateur n'inonde pas), par cible (adresse
   * OU nom d'utilisateur) ET groupe au seuil bas — la clé que martèle un tiers n'est que SON couple, elle ne rend pas la cible
   * « non invitable » ailleurs —, par cible seule à un seuil beaucoup plus large (inondation par de nombreux groupes), et par IP.
   */
  invitation: { compte: parFenetre(10), cibleGroupe: parFenetre(3), cible: parFenetre(20), ip: parFenetre(30), reseau: parFenetre(90) },
  /** Création de groupe : rien n'est envoyé à un tiers, mais chaque groupe est une ligne et un administrateur de plus qui peut inviter. */
  groupe: { compte: parFenetre(10), ip: parFenetre(30), reseau: parFenetre(90) },
});
