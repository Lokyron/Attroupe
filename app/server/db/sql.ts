import { connexionBrute, type Requete } from './connection.js';
import type { Base } from './base.js';

// Verrou n° 5 (architecture §4) : garde sur le SQL brut. Toute requête de db/ passe par
// `preparer`, qui REFUSE (partout, production comprise : le texte est statique, donc la même
// requête échoue de la même façon en test) un texte qui touche une table métier sans filtre de
// portée LIÉ (`group_id = ?`, `user_id = ?`, `id = ?` pour `groups`). Une simple mention de la
// colonne ne suffit pas : c'est ainsi que `SELECT *, NULL AS group_id …` passait.
//
// La garde analyse des JETONS (pas une expression régulière sur le texte brut) et elle est FERMÉE :
// elle n'admet que les formes qu'elle sait prouver filtrées, et refuse le reste, y compris du SQL
// légitime (sous-requêtes, OR, BETWEEN, NOT EXISTS, WITH…). Un refus n'est pas un bogue de la garde :
// c'est le signal d'écrire autrement (architecture §4, verrou 5), jamais d'ajouter un texte transverse.
// Limite assumée : elle prouve qu'un filtre lié `colonne = ?` existe, pas QUELLE valeur on lie — c'est le
// GroupScope / la PorteeUtilisateur qui lient celle de l'appartenance. Les écritures réelles passent par eux.

/** Colonne qui porte la portée d'une table métier ; `null` : jamais accessible par `preparer`. */
export type ColonnePortee = 'group_id' | 'user_id' | 'id' | null;

/**
 * Toutes les tables métier et la colonne qui les cloisonne. Un test de schéma vérifie que cette
 * table est exactement celle de la base : ajouter une table sans la classer ici fait échouer le test.
 *  - `group_id` : le cloisonnement ordinaire (GroupScope) ;
 *  - `user_id`  : tables d'un COMPTE (PorteeUtilisateur), dont l'agenda personnel (modèle §3.6) ;
 *  - `id`       : `groups`, dont une ligne n'est lisible que par son identifiant lié ;
 *  - `null`     : `email_outbox`, file interne sans colonne de portée (accès futur par le seul
 *                 canal transverse).
 */
export const PORTEE_TABLES: Readonly<Record<string, ColonnePortee>> = {
  album_assets: 'group_id',
  albums: 'group_id',
  calendar_feed_tokens: 'user_id',
  date_poll_options: 'group_id',
  date_poll_votes: 'group_id',
  date_polls: 'group_id',
  email_outbox: null,
  event_attendances: 'group_id',
  event_organizers: 'group_id',
  event_tasks: 'group_id',
  events: 'group_id',
  expense_closures: 'group_id',
  expense_shares: 'group_id',
  expenses: 'group_id',
  group_immich_configs: 'group_id',
  groups: 'id',
  invitations: 'group_id',
  memberships: 'group_id',
  messages: 'group_id',
  notification_preferences: 'user_id',
  notifications: 'user_id',
  personal_event_shares: 'group_id',
  personal_events: 'user_id',
  push_subscriptions: 'user_id',
  settlements: 'group_id',
  shopping_items: 'group_id',
  shopping_lists: 'group_id',
  threads: 'group_id',
};

/**
 * EXCEPTIONS RAISONNÉES (architecture §4, verrou 5) — trois admissions nommées, et aucune règle large :
 *  1. `INSERT INTO groups (…) VALUES (…)` : `groups` est la table RACINE, il n'y a pas de `group_id` à filtrer et c'est
 *     l'unique point d'entrée de création d'un groupe. Seule la forme « colonnes + VALUES » est admise (ni `SELECT`, ni
 *     `ON CONFLICT`) ;
 *  2. `invitations` filtrée par `target_user_id = ?` : une invitation est par nature une ressource INTER-GROUPES (le
 *     destinataire n'est pas encore membre, il n'a donc pas de groupe à fournir) ; la preuve d'accès est le destinataire ;
 *  3. `invitations` filtrée par `token_hash = ?` : idem, la preuve d'accès est le secret du lien (empreinte SHA-256).
 * La valeur doit être LIÉE (`= ?`), jamais littérale, et le filtre suit les mêmes règles de conjoint que `group_id`.
 * `invitations` par `id = ?` sans l'un de ces filtres reste refusée.
 *
 * BORNES de ces exceptions (revue du lot 3) : une couverture par colonne alternative ne couvre QUE la table `invitations`
 * elle-même et ne se PROPAGE JAMAIS par `group_id = group_id` (sinon une simple jointure sur une invitation, même refusée ou
 * échue, ouvrirait en lecture et en écriture toutes les tables du groupe invitant). Une seule jointure en dérive, nommée :
 *  4. en LECTURE seule (`SELECT`), `memberships AS m` rattachée par `m.id = i.invited_by_membership_id AND m.group_id = i.group_id`
 *     (l'inviteur affiché au destinataire) ; la ligne ainsi couverte ne propage rien à son tour.
 * Et la colonne de preuve ne se modifie pas : `target_user_id` jamais en `SET` ; `token_hash` seulement sous un vrai
 * `group_id = ?` lié (l'armement du jeton à l'envoi, `armerInvitationEnvoi`), jamais sous un filtre par `token_hash` / `target_user_id`.
 *
 *  5. (lot 5) `calendar_feed_tokens` filtrée par `token_hash = ?` : le flux iCal n'a ni cookie ni groupe, la preuve d'accès est le
 *     jeton (empreinte SHA-256) et il sert à retrouver le compte. Exception PLUS ÉTROITE que celle des invitations :
 *     - `SELECT` uniquement, UNE seule table, AUCUNE jointure (pas même celle de l'inviteur) : la requête ne rend que les
 *       colonnes du jeton, les événements se lisent ensuite par `creerScope`, groupe par groupe ;
 *     - `token_hash` n'est JAMAIS en `SET` (ni `UPDATE`, ni `DELETE` sous ce filtre) ;
 *     - la couverture ne vaut que pour la table elle-même et ne se propage jamais ; l'écriture qui suit (`last_used_at`) passe par
 *       `WHERE id = ? AND user_id = ?` (garde ordinaire) : n'élargissez pas cette exception pour écrire.
 *     `calendar_feed_tokens` par `id = ?` seul reste refusée.
 */
const ACCES_ALTERNATIFS: Readonly<Record<string, readonly string[]>> = {
  invitations: ['target_user_id', 'token_hash'],
  calendar_feed_tokens: ['token_hash'],
};

/** Requête refusée par la garde. */
export class ErreurRequeteSansGroupe extends Error {
  constructor(public readonly raison: string, public readonly texte: string) {
    super(`Requête refusée (verrou n° 5) : ${raison}. Requête : ${texte.replace(/\s+/g, ' ').trim()}`);
    this.name = 'ErreurRequeteSansGroupe';
  }
}

// --- Analyse lexicale -------------------------------------------------------------------------

interface Jeton {
  readonly genre: 'mot' | 'chaine' | 'nombre' | 'param' | 'symbole';
  /** Mots en minuscules ; symboles et chaînes tels quels. */
  readonly texte: string;
}

const SYMBOLES_DOUBLES = ['<>', '<=', '>=', '!=', '==', '||', '<<', '>>'];
const SYMBOLES = '(),.=<>!*+-/%|&~';

/** Découpe le texte en jetons, ou renvoie la raison du refus lexical. */
function decouper(texte: string): Jeton[] | string {
  const jetons: Jeton[] = [];
  let i = 0;
  while (i < texte.length) {
    const c = texte.charAt(i);
    if (/\s/.test(c)) {
      i++;
    } else if (c === '-' && texte.charAt(i + 1) === '-') {
      return 'commentaire « -- » interdit';
    } else if (c === '/' && texte.charAt(i + 1) === '*') {
      return 'commentaire « /* */ » interdit';
    } else if (c === '"' || c === '`' || c === '[') {
      return 'identifiant entre guillemets, accents graves ou crochets interdit';
    } else if (c === ';') {
      return 'un seul ordre SQL par requête (« ; » interdit)';
    } else if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= texte.length) return 'chaîne non terminée';
        if (texte.charAt(j) === "'") {
          if (texte.charAt(j + 1) === "'") j += 2;
          else break;
        } else j++;
      }
      jetons.push({ genre: 'chaine', texte: texte.slice(i, j + 1) });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const mot = /^[A-Za-z_][A-Za-z0-9_]*/.exec(texte.slice(i))?.[0] ?? c;
      jetons.push({ genre: 'mot', texte: mot.toLowerCase() });
      i += mot.length;
    } else if (/[0-9]/.test(c)) {
      const nombre = /^[0-9]+(\.[0-9]+)?/.exec(texte.slice(i))?.[0] ?? c;
      jetons.push({ genre: 'nombre', texte: nombre });
      i += nombre.length;
    } else if (c === '?') {
      jetons.push({ genre: 'param', texte: '?' });
      i++;
    } else if (SYMBOLES_DOUBLES.includes(texte.slice(i, i + 2))) {
      jetons.push({ genre: 'symbole', texte: texte.slice(i, i + 2) });
      i += 2;
    } else if (SYMBOLES.includes(c)) {
      jetons.push({ genre: 'symbole', texte: c });
      i++;
    } else {
      return `caractère interdit « ${c} » (identifiants ASCII non quotés, valeurs liées par « ? » seulement)`;
    }
  }
  return jetons;
}

// --- Règles -----------------------------------------------------------------------------------

const DEBUTS_AUTORISES = ['select', 'insert', 'update', 'delete', 'vacuum'];
/**
 * Mots qui peuvent élargir un filtre (disjonction, ensembles, bornes, CTE, jointures qui gardent des
 * lignes hors filtre) : absents du SQL qu'on sait prouver sûr. `not`, `left`/`outer` et `case` ont
 * des règles à part (voir plus bas) ; `between` est refusé parce que son `AND` fait un faux conjoint
 * (`x BETWEEN 1 AND group_id = ?` se lit `(x BETWEEN 1 AND group_id) = ?`) : écrire `x >= ? AND x <= ?`.
 */
const MOTS_INTERDITS = [
  'or', 'union', 'intersect', 'except', 'with', 'recursive', 'between',
  'right', 'full', 'cross', 'natural', 'attach', 'detach', 'pragma',
];
/** Mots qui, après un nom de table, ne sont pas un alias. */
const PAS_UN_ALIAS = new Set([
  'where', 'join', 'inner', 'left', 'outer', 'right', 'full', 'cross', 'natural', 'on', 'set', 'values', 'group', 'order',
  'limit', 'offset', 'having', 'using', 'default', 'select', 'returning', 'indexed', 'not', 'as', 'from', 'and', 'is', 'in',
  'like', 'do',
]);
/** Juste avant une colonne de portée : contextes où elle est la vraie colonne. */
const AVANT_COLONNE = new Set(['select', 'distinct', 'where', 'and', 'on', 'by', '(', ',', '.']);
/** Juste avant un filtre lié : contextes conjonctifs. */
const AVANT_FILTRE = new Set(['where', 'and', 'on']);
/** Juste après un filtre : il n'est pas absorbé dans une expression plus grande. */
const APRES_FILTRE = new Set(['and', ')', 'where', 'order', 'limit', 'group', 'having', 'returning', 'join', 'inner', 'left', 'on', 'offset']);
/** Mots qui ouvrent une clause : sert à savoir DANS QUELLE clause se trouve un jeton. */
const CLAUSES = new Set(['select', 'from', 'where', 'group', 'having', 'order', 'limit', 'offset', 'set', 'values', 'returning', 'using', 'into', 'insert', 'update', 'delete']);
/** Mots qui suivent légitimement `not` (hors `IS NOT`). */
const APRES_NOT = new Set(['in', 'like', 'glob', 'null']);

interface Jointure {
  readonly gauche: boolean;
  /** Qualifiant (alias ou nom) de la table jointe. */
  readonly qualifiant: string;
}

interface Reference {
  readonly table: string;
  readonly colonne: ColonnePortee;
  /** Alias, ou nom de la table. */
  readonly qualifiant: string;
  readonly insertion: boolean;
  /** Indice du jeton (pour lire la liste de colonnes d'un INSERT). */
  readonly indice: number;
}

interface Filtre {
  readonly qualifiant: string | undefined;
  readonly colonne: string;
}

interface GardeConflit {
  readonly qualifiant: string;
  readonly colonne: string;
  readonly indice: number;
}

/**
 * Raison du refus, ou `undefined` si la requête est admise. La garde est FERMÉE : elle admet ce
 * qu'elle sait prouver filtré, rien d'autre. Elle refuse notamment toute sous-requête, tout alias
 * réutilisé, tout `ON CONFLICT … DO UPDATE` sans garde de portée, tout filtre qui n'est pas un
 * conjoint direct d'un `WHERE` ou d'un `ON`.
 */
export function diagnostiquer(texte: string): string | undefined {
  const jetons = decouper(texte);
  if (typeof jetons === 'string') return jetons;

  const mot = (i: number): string | undefined => {
    const j = jetons[i];
    return j?.genre === 'mot' ? j.texte : undefined;
  };
  const symbole = (i: number): string | undefined => {
    const j = jetons[i];
    return j?.genre === 'symbole' ? j.texte : undefined;
  };
  /** Texte d'un jeton, tous genres confondus (les chaînes ne valent jamais un mot-clé). */
  const brut = (i: number): string | undefined => {
    const j = jetons[i];
    return j === undefined || j.genre === 'chaine' ? undefined : j.texte;
  };

  const debut = mot(0);
  if (debut === undefined || !DEBUTS_AUTORISES.includes(debut)) {
    return `ordre « ${debut ?? '?'} » non autorisé (select, insert, update, delete seulement)`;
  }

  // Mots interdits, `not`, `left`/`outer`, `case`, et refus de toute sous-requête.
  let selects = 0;
  for (let i = 0; i < jetons.length; i++) {
    const m = mot(i);
    if (m === undefined) continue;
    if (MOTS_INTERDITS.includes(m)) return `mot « ${m} » interdit (il peut élargir le filtre de portée)`;
    if (m === 'select' && ++selects > 1) {
      return 'sous-requête interdite (un seul select) : utilisez une jointure interne, ou deux requêtes';
    }
    if (m === 'not' && mot(i - 1) !== 'is' && !APRES_NOT.has(mot(i + 1) ?? '')) {
      return 'mot « not » interdit hors de IS NOT NULL, NOT IN, NOT LIKE';
    }
    if (m === 'left' && mot(i + 1) !== 'join' && !(mot(i + 1) === 'outer' && mot(i + 2) === 'join')) {
      return 'mot « left » interdit hors de LEFT [OUTER] JOIN';
    }
    if (m === 'outer' && !(mot(i - 1) === 'left' && mot(i + 1) === 'join')) return 'mot « outer » interdit hors de LEFT OUTER JOIN';
  }

  // Parenthèses : appariées, avec le parent de chaque jeton.
  const pere: number[] = [];
  const fermeture = new Map<number, number>();
  const pile: number[] = [];
  for (let i = 0; i < jetons.length; i++) {
    pere.push(pile.at(-1) ?? -1);
    if (symbole(i) === '(') pile.push(i);
    else if (symbole(i) === ')') {
      const ouvrante = pile.pop();
      if (ouvrante === undefined) return 'parenthèses déséquilibrées';
      fermeture.set(ouvrante, i);
      pere[i] = pile.at(-1) ?? -1;
    }
  }
  if (pile.length > 0) return 'parenthèses déséquilibrées';

  /** Une parenthèse « de groupement » : posée devant un conjoint, et refermée sur un contexte de fin. */
  const groupement = (ouvrante: number): boolean => {
    const avant = brut(ouvrante - 1);
    const fin = (fermeture.get(ouvrante) ?? -1) + 1;
    const apres = fin >= jetons.length ? undefined : (brut(fin) ?? '');
    return avant !== undefined && (AVANT_FILTRE.has(avant) || avant === '(') && (apres === undefined || APRES_FILTRE.has(apres));
  };
  const enveloppeSaine = (i: number): boolean => {
    for (let o = pere[i] ?? -1; o >= 0; o = pere[o] ?? -1) if (!groupement(o)) return false;
    return true;
  };

  // Alias et jointure d'une table nommée au jeton `k`.
  const declarer = (k: number): { readonly table: string; readonly qualifiant: string } | undefined => {
    const table = mot(k);
    if (table === undefined) return undefined;
    if (mot(k + 1) === 'as' && mot(k + 2) !== undefined) return { table, qualifiant: mot(k + 2) ?? table };
    const suivant = mot(k + 1);
    return { table, qualifiant: suivant !== undefined && !PAS_UN_ALIAS.has(suivant) ? suivant : table };
  };

  // Clause de chaque jeton (mots-clés de niveau 0), et jointure courante pour les `ON`.
  const clauseAu: string[] = [];
  const jointureAu: Array<Jointure | undefined> = [];
  {
    let courante = '';
    let jointure: Jointure | undefined;
    let profondeur = 0;
    for (let i = 0; i < jetons.length; i++) {
      const m = mot(i);
      if (profondeur === 0 && m !== undefined) {
        if (m === 'join') {
          courante = 'from';
          jointure = {
            gauche: mot(i - 1) === 'left' || (mot(i - 1) === 'outer' && mot(i - 2) === 'left'),
            qualifiant: declarer(i + 1)?.qualifiant ?? '',
          };
        } else if (m === 'on') {
          courante = mot(i + 1) === 'conflict' ? 'conflict' : 'on';
        } else if (m === 'case') {
          if (courante !== 'select' && courante !== 'order') return 'CASE admis seulement dans la liste de sélection ou ORDER BY';
        } else if (CLAUSES.has(m)) {
          courante = m;
          if (m === 'from' || m === 'where') jointure = undefined;
        }
      }
      clauseAu.push(courante);
      jointureAu.push(jointure);
      if (symbole(i) === '(') profondeur++;
      else if (symbole(i) === ')') profondeur--;
    }
  }

  // Références de tables métier : un nom connu qui n'est pas le qualifiant d'une colonne (`t.col`).
  const references: Reference[] = [];
  for (let i = 0; i < jetons.length; i++) {
    const nom = mot(i);
    if (nom === undefined || !Object.hasOwn(PORTEE_TABLES, nom) || symbole(i + 1) === '.') continue;
    references.push({
      table: nom,
      colonne: PORTEE_TABLES[nom] ?? null,
      qualifiant: declarer(i)?.qualifiant ?? nom,
      insertion: mot(i - 1) === 'into',
      indice: i,
    });
  }

  // Un alias réutilisé fait pointer un filtre sur la mauvaise table : tout nom de table du FROM / JOIN
  // (métier ou non) doit avoir un qualifiant unique.
  const declarations = new Map<number, string>(references.map((r) => [r.indice, r.qualifiant]));
  for (let i = 0; i < jetons.length; i++) {
    if ((mot(i) === 'from' || mot(i) === 'join') && symbole(i + 2) !== '(' && !declarations.has(i + 1)) {
      const d = declarer(i + 1);
      if (d !== undefined) declarations.set(i + 1, d.qualifiant);
    }
  }
  const vus = new Set<string>();
  for (const qualifiant of declarations.values()) {
    if (vus.has(qualifiant)) return `alias « ${qualifiant} » réutilisé : un nom de table ou d'alias ne désigne qu'une référence`;
    vus.add(qualifiant);
  }

  /** `[debut, fin[` est un conjoint direct d'un WHERE / ON, dans des parenthèses de simple groupement. */
  const conjoint = (debutConjoint: number, fin: number): boolean => {
    const clause = clauseAu[debutConjoint];
    if (clause !== 'where' && clause !== 'on') return false;
    const avant = brut(debutConjoint - 1);
    if (avant === undefined || !(AVANT_FILTRE.has(avant) || avant === '(')) return false;
    if (!enveloppeSaine(debutConjoint)) return false;
    return fin >= jetons.length || APRES_FILTRE.has(brut(fin) ?? '');
  };

  // Colonnes de portée : chaque occurrence doit être la vraie colonne, jamais un alias ou un opérande.
  const filtres: Filtre[] = [];
  const liens: Array<readonly [string, string]> = []; // [couvert, hérite] : group_id = group_id
  const liensPartage: Array<readonly [string, string]> = []; // [qualifiant du partage, qualifiant de personal_events]
  const gardesConflit: GardeConflit[] = [];
  const misesPreuve: Array<{ readonly colonne: string; readonly indice: number }> = []; // colonnes de preuve vues en SET
  const liensInviteur: Array<readonly [string, string]> = []; // [membre, invitation] : m.id = i.invited_by_membership_id
  /** Dans le ON d'une jointure externe, seule la table jointe peut recevoir un filtre ou un lien. */
  const proprietaireGauche = (i: number): string | undefined =>
    clauseAu[i] === 'on' && jointureAu[i]?.gauche === true ? jointureAu[i]?.qualifiant : undefined;

  for (let i = 0; i < jetons.length; i++) {
    const m = mot(i);
    if (m === 'personal_event_id' || m === 'id') {
      // q1.personal_event_id = q2.id (ou l'inverse) : la jointure qui rattache un créneau à son partage.
      const q1 = symbole(i - 1) === '.' ? mot(i - 2) : undefined;
      const egal = symbole(i + 1) === '=' && symbole(i + 3) === '.';
      const q2 = egal ? mot(i + 2) : undefined;
      const autre = egal ? mot(i + 4) : undefined;
      if (q1 !== undefined && q2 !== undefined && conjoint(i - 2, i + 5)) {
        const [partage, creneau] =
          m === 'personal_event_id' && autre === 'id' ? [q1, q2] : m === 'id' && autre === 'personal_event_id' ? [q2, q1] : [];
        const gauche = proprietaireGauche(i);
        if (partage !== undefined && creneau !== undefined && (gauche === undefined || gauche === creneau)) {
          liensPartage.push([partage, creneau]);
        }
      }
      // m.id = i.invited_by_membership_id : l'inviteur d'une invitation (seule jointure dérivée d'une couverture alternative).
      if (m === 'id' && q1 !== undefined && symbole(i + 1) === '=' && symbole(i + 3) === '.' && mot(i + 4) === 'invited_by_membership_id') {
        const q2i = mot(i + 2);
        const gaucheI = proprietaireGauche(i);
        if (q2i !== undefined && conjoint(i - 2, i + 5) && (gaucheI === undefined || gaucheI === q1)) liensInviteur.push([q1, q2i]);
      }
      // « g.id = ? » : l'identifiant lié d'un groupe, qualifié par SA référence (jamais « id = ? » nu).
      if (m === 'id' && q1 !== undefined && symbole(i + 1) === '=' && jetons[i + 2]?.genre === 'param' && conjoint(i - 2, i + 3)) {
        const gauche = proprietaireGauche(i);
        if (gauche === undefined || gauche === q1) filtres.push({ qualifiant: q1, colonne: 'id' });
      }
    }
    if (m === 'target_user_id' || m === 'token_hash') {
      if (clauseAu[i] === 'set') misesPreuve.push({ colonne: m, indice: i });
      // Accès alternatif de `invitations` (voir ACCES_ALTERNATIFS) : même exigence qu'un filtre de portée — conjoint direct d'un
      // WHERE / ON, valeur liée. Toute autre forme (littéral, SET, comparaison détournée) n'est simplement pas un filtre :
      // la table reste non couverte et la requête est refusée plus bas.
      const avantAlt = brut(i - 1);
      if (avantAlt !== undefined && AVANT_COLONNE.has(avantAlt) && mot(i - 1) !== 'as' && symbole(i + 1) === '=' && jetons[i + 2]?.genre === 'param') {
        const qualifieAlt = symbole(i - 1) === '.';
        const qualifiantAlt = qualifieAlt ? mot(i - 2) : undefined;
        const gaucheAlt = proprietaireGauche(i);
        if (conjoint(qualifieAlt ? i - 2 : i, i + 3) && (gaucheAlt === undefined || (qualifiantAlt !== undefined && gaucheAlt === qualifiantAlt))) {
          filtres.push({ qualifiant: qualifiantAlt, colonne: m });
        }
      }
      continue;
    }
    if (m !== 'group_id' && m !== 'user_id') continue;
    if (clauseAu[i] === 'set') return `« ${m} » ne se modifie pas : la portée d'une ligne est posée à l'insertion`;
    const avant = brut(i - 1);
    if (avant === undefined || !AVANT_COLONNE.has(avant) || mot(i - 1) === 'as') {
      return `« ${m} » n'est pas la vraie colonne ici (alias, opérande ou comparaison détournée)`;
    }
    const qualifie = symbole(i - 1) === '.';
    const qualifiant = qualifie ? mot(i - 2) : undefined;
    const premier = qualifie ? i - 2 : i;
    const gauche = proprietaireGauche(i);
    if (symbole(i + 1) === '=' && jetons[i + 2]?.genre === 'param') {
      // Conjoint direct d'un WHERE / ON : jamais dans un appel de fonction, une parenthèse comparée ou une expression.
      if (conjoint(premier, i + 3) && (gauche === undefined || (qualifiant !== undefined && gauche === qualifiant))) {
        filtres.push({ qualifiant, colonne: m });
      }
    } else if (
      symbole(i + 1) === '=' && qualifiant !== undefined && symbole(i + 3) === '.' && mot(i + 4) === m && mot(i + 2) !== undefined &&
      (m === 'group_id' || mot(i + 2) === 'excluded')
    ) {
      const droite = mot(i + 2) ?? '';
      if (conjoint(premier, i + 5)) {
        if (droite === 'excluded') gardesConflit.push({ qualifiant, colonne: m, indice: i });
        else if (gauche === undefined) liens.push([qualifiant, droite], [droite, qualifiant]);
        else if (gauche === droite) liens.push([qualifiant, droite]);
        else if (gauche === qualifiant) liens.push([droite, qualifiant]);
      }
    } else if (symbole(i + 1) === '=') {
      return `« ${m} = … » : la valeur doit être liée par « ? » (ou une colonne qualifiée)`;
    }
  }

  // Couverture : chaque référence doit être filtrée par SA colonne de portée.
  const couvertes = new Set<number>();
  for (const [n, ref] of references.entries()) {
    if (ref.colonne === null) {
      return `table « ${ref.table} » : aucune colonne de portée, accès réservé au canal transverse`;
    }
    if (ref.insertion) {
      if (ref.colonne === 'id') {
        // Exception n° 1 (ACCES_ALTERNATIFS) : la création d'un groupe, et seulement sous la forme INSERT INTO groups (colonnes) VALUES (…).
        const fermante = symbole(ref.indice + 1) === '(' ? fermeture.get(ref.indice + 1) : undefined;
        if (ref.table !== 'groups' || fermante === undefined || mot(fermante + 1) !== 'values') {
          return `insertion dans « ${ref.table} » : seule la forme INSERT INTO groups (colonnes) VALUES (…) est admise`;
        }
        couvertes.add(n);
        continue;
      }
      let j = ref.indice + 1;
      let profondeur = 0;
      let trouvee = false;
      if (symbole(j) === '(') {
        for (; j < jetons.length; j++) {
          if (symbole(j) === '(') profondeur++;
          else if (symbole(j) === ')' && --profondeur === 0) break;
          else if (profondeur === 1 && mot(j) === ref.colonne) trouvee = true;
        }
      }
      if (!trouvee) return `insertion dans « ${ref.table} » sans la colonne ${ref.colonne}`;
      couvertes.add(n);
    }
  }
  // ON CONFLICT … DO UPDATE : la ligne existante n'est modifiée que si elle est dans la portée de l'insertion.
  const mises = jetons.flatMap((_j, i) => (mot(i) === 'do' && mot(i + 1) === 'update' ? [i] : []));
  const insertion = references.find((r) => r.insertion);
  for (const [k, debutMise] of mises.entries()) {
    const finMise = mises[k + 1] ?? jetons.length;
    const gardee =
      insertion !== undefined &&
      gardesConflit.some((g) => g.indice > debutMise && g.indice < finMise && g.qualifiant === insertion.qualifiant && g.colonne === insertion.colonne);
    if (!gardee) {
      return `ON CONFLICT … DO UPDATE sans « WHERE ${insertion?.qualifiant ?? '<table>'}.${insertion?.colonne ?? 'group_id'} = excluded.${insertion?.colonne ?? 'group_id'} » : une clé forgée écraserait la ligne d'une autre portée`;
    }
  }
  // `propageables` : références couvertes par un VRAI filtre de portée (ou dérivées d'une telle référence) ; seules elles
  // propagent leur couverture. `couvertes` ajoute les couvertures « de preuve » (ACCES_ALTERNATIFS), qui ne propagent rien.
  const propageables = new Set<number>([...couvertes]);
  // Filtres qualifiés : exacts, grâce à l'unicité des qualifiants.
  for (const [n, ref] of references.entries()) {
    if (ref.colonne === null) continue;
    for (const f of filtres) {
      if (f.qualifiant !== ref.qualifiant) continue;
      if (f.colonne === ref.colonne) {
        couvertes.add(n);
        propageables.add(n);
      } else if ((ACCES_ALTERNATIFS[ref.table] ?? []).includes(f.colonne)) couvertes.add(n);
    }
  }
  // Filtres sans qualifiant (« group_id = ? ») : ils ne désignent une référence que si elle est la SEULE de cette colonne
  // (sinon SQLite lui-même répond « ambiguous column » : la garde refuse de choisir).
  for (const colonne of ['group_id', 'user_id', 'target_user_id', 'token_hash']) {
    if (!filtres.some((f) => f.qualifiant === undefined && f.colonne === colonne)) continue;
    const candidates = [...references.entries()].filter(([, r]) => r.colonne === colonne || (ACCES_ALTERNATIFS[r.table] ?? []).includes(colonne));
    const unique = candidates.length === 1 ? candidates[0] : undefined;
    if (unique !== undefined) {
      couvertes.add(unique[0]);
      if (unique[1].colonne === colonne) propageables.add(unique[0]);
    }
  }
  // Propagation par jointure : group_id = group_id (dans le sens permis), et personal_events par ses partages.
  const indiceDe = (qualifiant: string): number => references.findIndex((r) => r.qualifiant === qualifiant);
  for (let change = true; change; ) {
    change = false;
    for (const [de, vers] of liens) {
      const nd = indiceDe(de);
      const nv = indiceDe(vers);
      if (nd < 0 || nv < 0 || references[nd]?.colonne !== 'group_id' || references[nv]?.colonne !== 'group_id') continue;
      if (propageables.has(nd) && !propageables.has(nv)) {
        propageables.add(nv);
        couvertes.add(nv);
        change = true;
      }
    }
    for (const [partage, creneau] of liensPartage) {
      const np = indiceDe(partage);
      const nc = indiceDe(creneau);
      if (np < 0 || nc < 0 || references[np]?.table !== 'personal_event_shares' || references[nc]?.table !== 'personal_events') continue;
      if (propageables.has(np) && !propageables.has(nc)) {
        propageables.add(nc);
        couvertes.add(nc);
        change = true;
      }
    }
  }
  // Exception n° 4 : l'inviteur d'une invitation couverte par preuve, en lecture seule, sans propagation.
  if (mot(0) === 'select') {
    for (const [membre, invitation] of liensInviteur) {
      const nm = indiceDe(membre);
      const ni = indiceDe(invitation);
      const lie = liens.some(([a, b]) => (a === invitation && b === membre) || (a === membre && b === invitation));
      if (nm < 0 || ni < 0 || !lie || references[nm]?.table !== 'memberships' || references[ni]?.table !== 'invitations') continue;
      if (couvertes.has(ni)) couvertes.add(nm);
    }
  }
  // La colonne de preuve ne se réécrit pas (une invitation ne se réattribue pas) ; le jeton ne s'arme que sous un vrai group_id.
  const niInvitations = references.findIndex((r) => r.table === 'invitations');
  for (const mp of misesPreuve) {
    // Jeton de flux : la colonne de preuve ne se modifie jamais, sous aucun filtre.
    if (mp.colonne === 'token_hash' && references.some((r) => r.table === 'calendar_feed_tokens')) return "« token_hash » d'un jeton de flux ne se modifie jamais";
    if (niInvitations < 0) continue;
    if (mp.colonne === 'target_user_id') return "« target_user_id » ne se modifie pas : une invitation ne se réattribue pas";
    if (!propageables.has(niInvitations)) return "« token_hash » ne se modifie que sous « group_id = ? » (armement du jeton), jamais sous un filtre de preuve";
  }
  // Jeton de flux couvert par sa seule preuve (token_hash, sans user_id) : SELECT, une seule table, aucune jointure.
  for (const [n, ref] of references.entries()) {
    if (ref.table !== 'calendar_feed_tokens' || propageables.has(n) || !couvertes.has(n)) continue;
    if (mot(0) !== 'select' || references.length !== 1 || jetons.some((_j, i) => mot(i) === 'join')) {
      return "« calendar_feed_tokens » filtrée par token_hash : SELECT d'une seule table, sans jointure";
    }
  }
  for (const [n, ref] of references.entries()) {
    if (!couvertes.has(n)) {
      return `la table « ${ref.table} » n'est pas filtrée par ${ref.colonne === 'id' ? 'sa-reference.id' : (ref.colonne ?? '?')} = ? (filtre lié obligatoire, la simple mention de la colonne ne suffit pas)`;
    }
  }
  return undefined;
}

/** Enveloppe de `prepare()` : le seul moyen de préparer une requête dans db/ (hors canal transverse). */
export function preparer(base: Base, texte: string): Requete {
  const raison = diagnostiquer(texte);
  if (raison !== undefined) throw new ErreurRequeteSansGroupe(raison, texte);
  return connexionBrute(base).prepare(texte);
}

// --- Canal transverse -------------------------------------------------------------------------

/**
 * Les SEULS textes SQL qui échappent à la garde : lectures qui, par nature, traversent les groupes
 * (« mes groupes » : memberships WHERE user_id = ?) et la file d'e-mails `email_outbox`, globale et sans
 * portée par nature. Liste figée EN DUR (`Object.freeze` : un `push`
 * lève une erreur à l'exécution) : un test la compare aux appels réels de `db/queries/transverse.ts`,
 * seul client de `preparerTransverse`, et l'ESLint interdit tout autre import. Il n'existe
 * volontairement AUCUNE option sur `preparer` pour y échapper. Une fonction transverse prend une
 * `PorteeUtilisateur`, jamais un identifiant nu.
 */
export const TEXTES_TRANSVERSES: readonly string[] = Object.freeze([
  `SELECT g.id AS group_id, g.name AS name, g.slug AS slug, m.id AS membership_id, m.role AS role
   FROM memberships AS m JOIN groups AS g ON g.id = m.group_id
   WHERE m.user_id = ? AND m.status = 'active' AND g.deleted_at IS NULL
   ORDER BY g.name, g.id`,
  // File d'e-mails (lot 2) : table interne sans portée, lue par le seul service d'envoi (db/queries/transverse.ts).
  `INSERT INTO email_outbox (id, to_email, template_key, payload_json, locale, status, attempts, next_attempt_at, created_at)
   VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
  `SELECT id, to_email, template_key, payload_json, locale, attempts
   FROM email_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?`,
  `UPDATE email_outbox SET next_attempt_at = ? WHERE id = ? AND status = 'pending'`,
  `UPDATE email_outbox SET status = 'sent', sent_at = ?, provider_message_id = ?, payload_json = '{}', last_error = NULL
   WHERE id = ? AND status = 'pending'`,
  `UPDATE email_outbox SET status = ?, attempts = attempts + ?, next_attempt_at = ?, last_error = ?,
   payload_json = CASE WHEN ? = 'pending' THEN payload_json ELSE '{}' END
   WHERE id = ? AND status = 'pending'`,
  // Résumé quotidien des notifications (lot 10) : tâche de fond qui regroupe les notifications non lues par compte et groupe.
  `SELECT n.id AS notification_id, n.user_id AS user_id, n.group_id AS group_id,
          g.name AS group_name, g.time_zone AS time_zone,
          u.email AS email, u.display_name AS display_name
   FROM notifications AS n
   JOIN groups AS g ON g.id = n.group_id
   JOIN memberships AS m ON m.user_id = n.user_id AND m.group_id = n.group_id
   JOIN users AS u ON u.id = n.user_id
   WHERE n.read_at IS NULL AND n.email_queued_at IS NULL AND n.email_sent_at IS NULL
     AND g.deleted_at IS NULL AND m.status = 'active'
     AND u.email_verified_at IS NOT NULL AND u.disabled_at IS NULL AND u.anonymized_at IS NULL
   ORDER BY n.user_id, n.group_id, n.created_at`,
]);

/** Prépare un texte de `TEXTES_TRANSVERSES`, et rien d'autre. */
export function preparerTransverse(base: Base, texte: string): Requete {
  if (!TEXTES_TRANSVERSES.includes(texte)) {
    throw new ErreurRequeteSansGroupe('texte absent de la liste figée des requêtes transverses', texte);
  }
  return connexionBrute(base).prepare(texte);
}

/** Rappel asynchrone passé à une transaction : la suite d'un `await` s'exécuterait HORS transaction. */
export class ErreurTransactionAsynchrone extends Error {
  constructor() {
    super(
      'Transaction asynchrone refusée : la transaction est validée ou annulée dès le premier await, ' +
        "et ce qui suit s'exécuterait HORS transaction (sans annulation possible). Passez une fonction synchrone.",
    );
    this.name = 'ErreurTransactionAsynchrone';
  }
}

function estThenable(valeur: unknown): boolean {
  return (typeof valeur === 'object' || typeof valeur === 'function') && valeur !== null && 'then' in valeur && typeof valeur.then === 'function';
}

/**
 * Groupe des écritures en une transaction (imbriquable : points de sauvegarde). Synchrone uniquement.
 * `BEGIN IMMEDIATE` : le verrou d'écriture est pris au DÉBUT, donc `busy_timeout` s'applique et la transaction attend son tour. Avec le
 * `BEGIN` différé par défaut, une transaction qui commence par lire puis écrit (« lis la fin de la liste, ajoute après ») échoue sur-le-champ
 * en SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT dès qu'un autre processus a écrit entre-temps, sans jamais attendre : constaté au lot 6 par des
 * processus qui écrivent ensemble sur la même liste (tests/integration/listes-concurrence.test.ts).
 */
export function executerEnTransaction<T>(base: Base, fn: () => T): T {
  return connexionBrute(base).transaction(() => {
    const resultat = fn();
    if (estThenable(resultat)) throw new ErreurTransactionAsynchrone();
    return resultat;
  }).immediate();
}
