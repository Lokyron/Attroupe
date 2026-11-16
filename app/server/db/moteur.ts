import type { Base } from './base.js';
import { nouvelIdentifiant } from './identifiant.js';
import { executerEnTransaction, preparer } from './sql.js';

// Moteur commun du GroupScope et de la PorteeUtilisateur (architecture §4, verrou 2). Il fabrique
// TOUT le SQL à partir de structures (tables d'une liste fermée, colonnes vérifiées contre
// `pragma_table_info`, opérateurs d'un ensemble fermé) et ne concatène JAMAIS une valeur : il n'y a
// pas de fragment SQL libre à filtrer, donc rien à contourner par un identifiant entre crochets.

/** Valeur SQL acceptée. Les montants sont des entiers d'unités mineures (modèle §4) : `number` ou `bigint`. */
export type ValeurSql = string | number | bigint | Buffer | null;
export type Valeurs = Readonly<Record<string, ValeurSql>>;

/** Opérateurs à une valeur : ensemble fermé. */
export type OperateurSimple = '=' | '<>' | '<' | '<=' | '>' | '>=' | 'LIKE';

/** Une condition d'un filtre ; les conditions d'un filtre sont combinées par ET, jamais par OU. */
export type Condition =
  | { readonly colonne: string; readonly operateur: 'IS NULL' | 'IS NOT NULL' }
  | { readonly colonne: string; readonly operateur: 'IN'; readonly valeur: readonly ValeurSql[] }
  | { readonly colonne: string; readonly operateur: OperateurSimple; readonly valeur: ValeurSql };

/** Contrainte de type : un rappel de transaction qui rend une `Promise` ne compile pas (la suite d'un `await` sortirait de la transaction). */
export type SansPromesse<T> = T extends PromiseLike<unknown> ? never : unknown;

export interface Ordre {
  readonly colonne: string;
  readonly sens?: 'ASC' | 'DESC';
}

export interface OptionsLecture {
  readonly ordre?: readonly Ordre[];
  /** Nombre maximal de lignes (1 à 10 000). */
  readonly limite?: number;
}

/** Usage incorrect du scope (colonne interdite, condition hors liste…) : toujours un bogue du code appelant. */
export class ErreurScope extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurScope';
  }
}

export interface DescriptionTable {
  /** Clé primaire = colonne `id` (donc adressable par `un`, `modifier`, `supprimerDoux`). */
  readonly avecId: boolean;
  /** Porte `deleted_at` : suppression douce, et filtre `deleted_at IS NULL` sur toute lecture. */
  readonly supprimable: boolean;
  /** Suppression réelle admise (lignes d'association, modèle §4.4). */
  readonly suppressionReelle: boolean;
  readonly creeLe: boolean;
  readonly majLe: boolean;
  /** Colonne de l'auteur, remplie par `inserer` avec l'appartenance du scope. */
  readonly auteur: string | null;
  /** Colonne d'auteur NULLABLE : absente (NULL, ex. synchronisation Immich) ou égale à l'appartenance du scope. */
  readonly auteurFacultatif: string | null;
  /** Colonnes de la clé primaire, sans la colonne de portée. */
  readonly cle: readonly string[];
  /** La colonne de portée fait partie de la clé primaire (singleton par groupe, préférences par compte). */
  readonly pkContientPortee: boolean;
  /** Colonne qui doit valoir l'appartenance du scope pour modifier ou supprimer (lignes d'un membre). */
  readonly reserveAuMembre: string | null;
}

export interface ConfigMoteur {
  readonly base: Base;
  readonly colonnePortee: 'group_id' | 'user_id';
  readonly valeurPortee: string;
  readonly descriptions: Readonly<Record<string, DescriptionTable>>;
  /** Appartenance du scope (auteur des écritures), `null` pour une portée de compte. */
  readonly membreId: string | null;
  /** Contrôle propre à une table, avant une insertion (ex. propriété d'un créneau partagé). */
  readonly avantInsertion?: (table: string, valeurs: Valeurs) => void;
  /** Contrôle propre à une table, avant une mise à jour (ex. une colonne qu'on ne change plus après la création). */
  readonly avantModification?: (table: string, valeurs: Valeurs) => void;
}

export interface Moteur {
  readonly tous: <T>(table: string, filtres?: readonly Condition[], options?: OptionsLecture) => T[];
  readonly un: <T>(table: string, id: string) => T | undefined;
  readonly inserer: (table: string, valeurs: Valeurs) => string | undefined;
  readonly modifierPar: (table: string, cle: Valeurs, valeurs: Valeurs, conditions?: readonly Condition[]) => boolean;
  readonly supprimerDoux: (table: string, id: string) => boolean;
  readonly supprimer: (table: string, cle: Valeurs) => boolean;
  readonly upsert: (table: string, valeurs: Valeurs) => boolean;
  readonly transaction: <T>(fn: () => T & SansPromesse<T>) => T;
}

const NOM_COLONNE = /^[a-z][a-z0-9_]*$/;
const OPERATEURS_SIMPLES: ReadonlySet<string> = new Set<OperateurSimple>(['=', '<>', '<', '<=', '>', '>=', 'LIKE']);
const MAX_VALEURS_IN = 500;
const MAX_LIMITE = 10_000;

/** Instant courant au format du modèle : ISO 8601 UTC, secondes, suffixe Z. */
export function instantUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function estObjet(valeur: unknown): valeur is Record<string, unknown> {
  return typeof valeur === 'object' && valeur !== null && !Array.isArray(valeur);
}

function verifierValeur(valeur: unknown, contexte: string): ValeurSql {
  if (valeur === null || typeof valeur === 'string' || typeof valeur === 'bigint' || Buffer.isBuffer(valeur)) return valeur;
  if (typeof valeur === 'number' && Number.isFinite(valeur)) return valeur;
  throw new ErreurScope(`Valeur refusée pour ${contexte} : texte, nombre fini, entier 64 bits, Buffer ou null attendu.`);
}

export function creerMoteur(config: ConfigMoteur): Moteur {
  const { base, colonnePortee, valeurPortee, descriptions, membreId } = config;
  const colonnesConnues = new Map<string, ReadonlySet<string>>();

  const description = (table: string): DescriptionTable => {
    const d = typeof table === 'string' && Object.hasOwn(descriptions, table) ? descriptions[table] : undefined;
    if (d === undefined) throw new ErreurScope('Table refusée : elle ne fait pas partie de cette portée.');
    return d;
  };

  /** Colonnes réelles de la table, lues dans le schéma : la liste blanche n'est écrite nulle part à la main. */
  const colonnes = (table: string): ReadonlySet<string> => {
    const connues = colonnesConnues.get(table);
    if (connues !== undefined) return connues;
    const lues = preparer(base, 'SELECT name FROM pragma_table_info(?)').pluck().all(table) as string[];
    if (lues.length === 0) throw new ErreurScope(`Table « ${table} » introuvable dans le schéma.`);
    const ensemble = new Set(lues);
    colonnesConnues.set(table, ensemble);
    return ensemble;
  };

  const nomColonne = (table: string, nom: unknown): string => {
    if (typeof nom !== 'string' || !NOM_COLONNE.test(nom) || !colonnes(table).has(nom)) {
      throw new ErreurScope(`Colonne refusée pour « ${table} » : elle n'existe pas dans le schéma.`);
    }
    return nom;
  };

  /** Colonnes que le scope pose lui-même : un filtre ou une écriture ne les touche jamais. */
  const reservees = (): readonly string[] => [colonnePortee, 'deleted_at'];

  const compiler = (table: string, condition: unknown): { texte: string; valeurs: ValeurSql[] } => {
    if (!estObjet(condition)) throw new ErreurScope('Condition refusée : { colonne, operateur, valeur } attendu.');
    const colonne = nomColonne(table, condition['colonne']);
    if (reservees().includes(colonne)) throw new ErreurScope(`Colonne « ${colonne} » posée par le scope : elle ne se filtre pas.`);
    const operateur = condition['operateur'];
    if (operateur === 'IS NULL' || operateur === 'IS NOT NULL') return { texte: `${colonne} ${operateur}`, valeurs: [] };
    if (operateur === 'IN') {
      const liste = condition['valeur'];
      if (!Array.isArray(liste) || liste.length === 0 || liste.length > MAX_VALEURS_IN) {
        throw new ErreurScope(`IN sur « ${colonne} » : de 1 à ${String(MAX_VALEURS_IN)} valeurs attendues.`);
      }
      return {
        texte: `${colonne} IN (${liste.map(() => '?').join(', ')})`,
        valeurs: liste.map((v) => verifierValeur(v, `« ${colonne} »`)),
      };
    }
    if (typeof operateur !== 'string' || !OPERATEURS_SIMPLES.has(operateur)) {
      throw new ErreurScope('Opérateur refusé : = <> < <= > >= IN LIKE, IS NULL, IS NOT NULL seulement.');
    }
    return { texte: `${colonne} ${operateur} ?`, valeurs: [verifierValeur(condition['valeur'], `« ${colonne} »`)] };
  };

  /** Colonnes de la clé primaire exigées, ni plus ni moins. */
  const verifierCle = (table: string, d: DescriptionTable, cle: unknown): string[] => {
    if (!estObjet(cle)) throw new ErreurScope(`Clé de « ${table} » : objet attendu.`);
    const noms = Object.keys(cle);
    if (noms.length !== d.cle.length || !d.cle.every((c) => noms.includes(c))) {
      throw new ErreurScope(`Clé de « ${table} » : ${d.cle.length === 0 ? 'aucune colonne' : d.cle.join(' + ')} attendue.`);
    }
    for (const nom of noms) verifierValeur(cle[nom], `la clé « ${nom} »`);
    return [...d.cle];
  };

  const verifierEcriture = (table: string, d: DescriptionTable, valeurs: unknown, interdites: readonly string[]): string[] => {
    if (!estObjet(valeurs)) throw new ErreurScope(`Valeurs de « ${table} » : objet attendu.`);
    const noms = Object.keys(valeurs);
    for (const nom of noms) {
      nomColonne(table, nom);
      if (interdites.includes(nom)) throw new ErreurScope(`Colonne « ${nom} » de « ${table} » posée par le scope : ne la fournissez pas.`);
      verifierValeur(valeurs[nom], `« ${nom} »`);
    }
    // Colonne « du membre » (présence, vote, partage) : c'est SON appartenance, jamais celle d'un autre membre du groupe.
    const colonneMembre = d.reserveAuMembre;
    if (colonneMembre !== null && noms.includes(colonneMembre) && valeurs[colonneMembre] !== membreId) {
      throw new ErreurScope(`« ${colonneMembre} » de « ${table} » : c'est l'appartenance du scope, ou rien (on n'écrit pas au nom d'un autre membre).`);
    }
    const facultatif = d.auteurFacultatif;
    if (facultatif !== null && noms.includes(facultatif) && valeurs[facultatif] !== null && valeurs[facultatif] !== membreId) {
      throw new ErreurScope(`« ${facultatif} » de « ${table} » : absent (NULL) ou égal à l'appartenance du scope.`);
    }
    return noms;
  };

  /** Colonnes et valeurs d'une insertion complète : portée, auteur, identifiant et horodatages posés ici. */
  const preparerInsertion = (table: string, d: DescriptionTable, valeurs: Valeurs): Map<string, ValeurSql> => {
    const interdites = [...reservees(), ...(d.avecId ? ['id'] : []), ...(d.auteur === null ? [] : [d.auteur])];
    const noms = verifierEcriture(table, d, valeurs, interdites);
    config.avantInsertion?.(table, valeurs);
    const toutes = new Map<string, ValeurSql>();
    for (const nom of noms) toutes.set(nom, valeurs[nom] ?? null);
    toutes.set(colonnePortee, valeurPortee);
    if (d.avecId) toutes.set('id', nouvelIdentifiant());
    if (d.auteur !== null) toutes.set(d.auteur, membreId);
    if (d.reserveAuMembre !== null) toutes.set(d.reserveAuMembre, membreId);
    const maintenant = instantUtc();
    if (d.creeLe && !toutes.has('created_at')) toutes.set('created_at', maintenant);
    if (d.majLe && !toutes.has('updated_at')) toutes.set('updated_at', maintenant);
    return toutes;
  };

  /** « AND colonne = ? » pour la restriction à l'appartenance (lignes d'un membre). */
  const reserve = (d: DescriptionTable): { texte: string; valeurs: ValeurSql[] } =>
    d.reserveAuMembre === null ? { texte: '', valeurs: [] } : { texte: ` AND ${d.reserveAuMembre} = ?`, valeurs: [membreId] };

  const tous = <T>(table: string, filtres: readonly Condition[] = [], options: OptionsLecture = {}): T[] => {
    const d = description(table);
    if (!Array.isArray(filtres)) throw new ErreurScope('Filtre refusé : une liste de conditions { colonne, operateur, valeur } est attendue.');
    const conditions = filtres.map((c) => compiler(table, c));
    // Texte plat (la garde du SQL brut refuse les sous-requêtes) : le filtre de portée vient en premier et les
    // conditions sont des conjoints ajoutés par ET, jamais par OU (les opérateurs viennent d'un ensemble fermé).
    let texte = `SELECT * FROM ${table} WHERE ${colonnePortee} = ?${d.supprimable ? ' AND deleted_at IS NULL' : ''}`;
    for (const c of conditions) texte += ` AND ${c.texte}`;
    if (options.ordre !== undefined) {
      if (!Array.isArray(options.ordre) || options.ordre.length === 0) throw new ErreurScope('Ordre refusé : liste non vide attendue.');
      const termes = options.ordre.map((o) => {
        const colonne = nomColonne(table, estObjet(o) ? o['colonne'] : undefined);
        const sens = estObjet(o) ? o['sens'] : undefined;
        if (sens !== undefined && sens !== 'ASC' && sens !== 'DESC') throw new ErreurScope('Ordre refusé : ASC ou DESC.');
        return `${colonne} ${sens ?? 'ASC'}`;
      });
      texte += ` ORDER BY ${termes.join(', ')}`;
    }
    const params: ValeurSql[] = [valeurPortee, ...conditions.flatMap((c) => c.valeurs)];
    if (options.limite !== undefined) {
      if (!Number.isInteger(options.limite) || options.limite < 1 || options.limite > MAX_LIMITE) {
        throw new ErreurScope(`Limite refusée : entier de 1 à ${String(MAX_LIMITE)}.`);
      }
      texte += ' LIMIT ?';
      params.push(options.limite);
    }
    return preparer(base, texte).all(...params) as T[];
  };

  const un = <T>(table: string, id: string): T | undefined => {
    const d = description(table);
    if (!d.avecId) throw new ErreurScope(`« ${table} » n'a pas de colonne id : lisez-la avec tous() et la clé.`);
    const texte = `SELECT * FROM ${table} WHERE id = ? AND ${colonnePortee} = ?${d.supprimable ? ' AND deleted_at IS NULL' : ''}`;
    return preparer(base, texte).get(verifierValeur(id, 'id'), valeurPortee) as T | undefined;
  };

  const inserer = (table: string, valeurs: Valeurs): string | undefined => {
    const d = description(table);
    const toutes = preparerInsertion(table, d, valeurs);
    const noms = [...toutes.keys()];
    const texte = `INSERT INTO ${table} (${noms.join(', ')}) VALUES (${noms.map(() => '?').join(', ')})`;
    preparer(base, texte).run(...toutes.values());
    return d.avecId ? (toutes.get('id') as string) : undefined;
  };

  /**
   * `conditions` (facultatives, liées, combinées par ET) rendent la mise à jour CONDITIONNELLE : `UPDATE … WHERE clé AND groupe AND
   * conditions`. C'est ce qui ferme une course (deux « je le prends » simultanés) sans « lire puis écrire » : la base tranche, et
   * `false` veut dire « la condition ne tenait plus ».
   */
  const modifierPar = (table: string, cle: Valeurs, valeurs: Valeurs, conditions: readonly Condition[] = []): boolean => {
    const d = description(table);
    const colonnesCle = verifierCle(table, d, cle);
    const interdites = [
      ...reservees(), 'id', 'created_at', 'updated_at', ...colonnesCle,
      ...(d.auteur === null ? [] : [d.auteur]),
      ...(d.reserveAuMembre === null ? [] : [d.reserveAuMembre]),
    ];
    const noms = verifierEcriture(table, d, valeurs, interdites);
    config.avantModification?.(table, valeurs);
    if (noms.length === 0) throw new ErreurScope(`Mise à jour de « ${table} » sans aucune colonne.`);
    const affectations = noms.map((c) => `${c} = ?`);
    const params: ValeurSql[] = noms.map((c) => valeurs[c] ?? null);
    if (d.majLe) {
      affectations.push('updated_at = ?');
      params.push(instantUtc());
    }
    if (!Array.isArray(conditions)) throw new ErreurScope('Conditions refusées : une liste de conditions { colonne, operateur, valeur } est attendue.');
    const gardes = conditions.map((c) => compiler(table, c));
    const r = reserve(d);
    const criteres = [...colonnesCle.map((c) => `${c} = ?`), `${colonnePortee} = ?`];
    const supplements = gardes.map((g) => ` AND ${g.texte}`).join('');
    const texte = `UPDATE ${table} SET ${affectations.join(', ')} WHERE ${criteres.join(' AND ')}${d.supprimable ? ' AND deleted_at IS NULL' : ''}${r.texte}${supplements}`;
    return (
      preparer(base, texte).run(...params, ...colonnesCle.map((c) => cle[c] ?? null), valeurPortee, ...r.valeurs, ...gardes.flatMap((g) => g.valeurs)).changes > 0
    );
  };

  const supprimerDoux = (table: string, id: string): boolean => {
    const d = description(table);
    if (!d.supprimable) throw new ErreurScope(`« ${table} » n'a pas de suppression douce.`);
    const maintenant = instantUtc();
    const texte = `UPDATE ${table} SET deleted_at = ?${d.majLe ? ', updated_at = ?' : ''} WHERE id = ? AND ${colonnePortee} = ? AND deleted_at IS NULL`;
    const params = d.majLe ? [maintenant, maintenant] : [maintenant];
    return preparer(base, texte).run(...params, verifierValeur(id, 'id'), valeurPortee).changes > 0;
  };

  const supprimer = (table: string, cle: Valeurs): boolean => {
    const d = description(table);
    if (!d.suppressionReelle) throw new ErreurScope(`« ${table} » ne se supprime pas réellement (modèle §4.4).`);
    const colonnesCle = verifierCle(table, d, cle);
    const r = reserve(d);
    const criteres = [...colonnesCle.map((c) => `${c} = ?`), `${colonnePortee} = ?`];
    const texte = `DELETE FROM ${table} WHERE ${criteres.join(' AND ')}${r.texte}`;
    return preparer(base, texte).run(...colonnesCle.map((c) => cle[c] ?? null), valeurPortee, ...r.valeurs).changes > 0;
  };

  const upsert = (table: string, valeurs: Valeurs): boolean => {
    const d = description(table);
    if (d.avecId) throw new ErreurScope(`« ${table} » a un identifiant généré : upsert ne vaut que pour les clés composites.`);
    const toutes = preparerInsertion(table, d, valeurs);
    for (const c of d.cle) {
      if (!toutes.has(c)) throw new ErreurScope(`Upsert de « ${table} » : la colonne « ${c} » de la clé est obligatoire.`);
    }
    const noms = [...toutes.keys()];
    const cible = d.pkContientPortee ? [colonnePortee, ...d.cle] : [...d.cle];
    const aJour = noms.filter((c) => c !== colonnePortee && c !== 'created_at' && !d.cle.includes(c) && c !== d.auteur);
    // Sur conflit de clé, la ligne existante n'est modifiée que si elle est DANS la portée : une clé
    // forgée vers un autre groupe (ou compte) ne touche pas la ligne étrangère.
    const gardes = [`${table}.${colonnePortee} = excluded.${colonnePortee}`];
    if (d.reserveAuMembre !== null) gardes.push(`${table}.${d.reserveAuMembre} = excluded.${d.reserveAuMembre}`);
    const suite =
      aJour.length === 0
        ? 'DO NOTHING'
        : `DO UPDATE SET ${aJour.map((c) => `${c} = excluded.${c}`).join(', ')} WHERE ${gardes.join(' AND ')}`;
    const texte = `INSERT INTO ${table} (${noms.join(', ')}) VALUES (${noms.map(() => '?').join(', ')}) ON CONFLICT (${cible.join(', ')}) ${suite}`;
    return preparer(base, texte).run(...toutes.values()).changes > 0;
  };

  const transaction = <T>(fn: () => T & SansPromesse<T>): T => executerEnTransaction(base, fn);

  return { tous, un, inserer, modifierPar, supprimerDoux, supprimer, upsert, transaction };
}
