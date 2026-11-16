import {
  articlesDe,
  creerArticle as creerArticleEnBase,
  creerListe as creerListeEnBase,
  definirFait as definirFaitEnBase,
  definirPreneur as definirPreneurEnBase,
  deplacerArticle as deplacerArticleEnBase,
  lireArticle,
  lireListe,
  listerListes as listerListesEnBase,
  modifierArticle as modifierArticleEnBase,
  renommerListe as renommerListeEnBase,
  supprimerArticle as supprimerArticleEnBase,
  supprimerListe as supprimerListeEnBase,
  tousLesArticles,
  type Article,
  type Liste,
  type ResultatArticle,
} from '../db/queries/listes.js';
import { listerMembres } from '../db/queries/membres.js';
import type { GroupScope } from '../db/scope.js';
import { versInstant } from '../domain/instant.js';
import type { Contexte } from '../http/contexte.js';
import { ErreurHttp } from '../http/erreurs.js';

// Cas d'usage des listes de courses (lot 6). Deux vérifications, jamais confondues (architecture §4) : le cloisonnement (une liste ou un
// article qui n'est pas de CE groupe, ou pas de CETTE liste, n'existe pas : 404) et, pour les conflits de données, 409. Aucun droit fin ici :
// une liste est un bien commun du groupe, tout membre actif la modifie.
//
// Chaque changement est diffusé APRÈS la transaction, en message minimal (services/temps-reel.ts) : jamais l'objet.

/** Qui, aux yeux du groupe : l'appartenance et le nom affiché de son compte. */
interface Personne {
  readonly membership_id: string;
  readonly display_name: string;
}

/** L'article tel que l'API le rend : booléen pour `is_done`, le preneur nommé, et aucune colonne réservée V2 (`category`). */
export interface ArticlePublic extends Omit<Article, 'is_done'> {
  readonly is_done: boolean;
  readonly claimed_by_name: string | null;
}

export interface ListePublique extends Liste {
  readonly articles_total: number;
  readonly articles_faits: number;
}

export interface DetailListe extends Liste {
  readonly articles: ArticlePublic[];
}

function noms(scope: GroupScope): Map<string, string> {
  return new Map(listerMembres(scope).map((m) => [m.id, m.display_name]));
}

function publier(article: Article, nomsMembres: ReadonlyMap<string, string>): ArticlePublic {
  return {
    ...article,
    is_done: article.is_done === 1,
    claimed_by_name: article.claimed_by_membership_id === null ? null : (nomsMembres.get(article.claimed_by_membership_id) ?? ''),
  };
}

function trouverListe(scope: GroupScope, listeId: string): Liste {
  const liste = lireListe(scope, listeId);
  if (liste === undefined) throw new ErreurHttp(404, 'liste.introuvable');
  return liste;
}

function trouverArticle(scope: GroupScope, listeId: string, articleId: string): Article {
  trouverListe(scope, listeId); // la liste d'abord : celle d'un autre groupe est introuvable avant même de regarder l'article
  const article = lireArticle(scope, listeId, articleId);
  if (article === undefined) throw new ErreurHttp(404, 'article.introuvable');
  return article;
}

/** L'événement visé existe dans CE groupe (la clé étrangère composite le refuserait, mais en erreur SQLite : on répond proprement avant). */
export function verifierEvenement(scope: GroupScope, evenementId: string): void {
  if (scope.un('events', evenementId) === undefined) throw new ErreurHttp(404, 'evenement.introuvable');
}

/** Les listes du groupe avec leurs compteurs ; `evenementId` restreint à celles d'un événement (404 s'il n'est pas de CE groupe). */
export function listerListes(scope: GroupScope, evenementId?: string): ListePublique[] {
  if (evenementId !== undefined) verifierEvenement(scope, evenementId);
  const articles = tousLesArticles(scope);
  return listerListesEnBase(scope, evenementId).map((liste) => {
    const siens = articles.filter((a) => a.shopping_list_id === liste.id);
    return { ...liste, articles_total: siens.length, articles_faits: siens.filter((a) => a.is_done === 1).length };
  });
}

export function detailListe(scope: GroupScope, listeId: string): DetailListe {
  const liste = trouverListe(scope, listeId);
  const nomsMembres = noms(scope);
  return { ...liste, articles: articlesDe(scope, liste.id).map((a) => publier(a, nomsMembres)) };
}

export function creerListe(contexte: Contexte, scope: GroupScope, champs: { title: string; event_id: string | null }): DetailListe {
  if (champs.event_id !== null) verifierEvenement(scope, champs.event_id);
  const id = creerListeEnBase(scope, champs);
  contexte.diffuseur.diffuser(scope, { type: 'liste.creee', ressource: 'liste', id, parent_id: champs.event_id });
  return detailListe(scope, id);
}

export function renommerListe(contexte: Contexte, scope: GroupScope, listeId: string, title: string): DetailListe {
  const liste = trouverListe(scope, listeId);
  if (!renommerListeEnBase(scope, liste.id, title)) throw new ErreurHttp(404, 'liste.introuvable');
  contexte.diffuseur.diffuser(scope, { type: 'liste.renommee', ressource: 'liste', id: liste.id, parent_id: liste.event_id });
  return detailListe(scope, liste.id);
}

/** Suppression logique de la liste et de ses articles. */
export function supprimerListe(contexte: Contexte, scope: GroupScope, listeId: string): void {
  const liste = trouverListe(scope, listeId);
  if (!supprimerListeEnBase(scope, liste.id)) throw new ErreurHttp(404, 'liste.introuvable');
  contexte.diffuseur.diffuser(scope, { type: 'liste.supprimee', ressource: 'liste', id: liste.id, parent_id: liste.event_id });
}

function diffuserArticle(contexte: Contexte, scope: GroupScope, verbe: string, article: Pick<Article, 'id' | 'shopping_list_id'>): void {
  contexte.diffuseur.diffuser(scope, { type: `article.${verbe}`, ressource: 'article', id: article.id, parent_id: article.shopping_list_id });
}

function rendre(scope: GroupScope, article: Article): ArticlePublic {
  return publier(article, noms(scope));
}

export function ajouterArticle(contexte: Contexte, scope: GroupScope, listeId: string, champs: { label: string; quantity: string | null }): ArticlePublic {
  const liste = trouverListe(scope, listeId);
  const id = creerArticleEnBase(scope, liste.id, champs);
  if (id === undefined) throw new ErreurHttp(409, 'liste.pleine');
  const article = lireArticle(scope, liste.id, id);
  if (article === undefined) throw new Error("Article créé puis introuvable dans sa liste.");
  diffuserArticle(contexte, scope, 'ajoute', article);
  return rendre(scope, article);
}

/** Libellé, quantité et/ou place dans la liste (`after_item_id` : après cet article, `null` : en tête). */
export function modifierArticle(
  contexte: Contexte,
  scope: GroupScope,
  listeId: string,
  articleId: string,
  champs: { label?: string | undefined; quantity?: string | null | undefined; after_item_id?: string | null | undefined },
): ArticlePublic {
  const article = trouverArticle(scope, listeId, articleId);
  scope.transaction(() => {
    if (champs.label !== undefined || champs.quantity !== undefined) {
      if (!modifierArticleEnBase(scope, article.id, champs)) throw new ErreurHttp(404, 'article.introuvable');
    }
    if (champs.after_item_id !== undefined) {
      const resultat = deplacerArticleEnBase(scope, article.shopping_list_id, article.id, champs.after_item_id);
      if (resultat !== 'deplace') throw new ErreurHttp(404, 'article.introuvable'); // l'article lui-même, ou la référence : introuvables dans CETTE liste
    }
  });
  diffuserArticle(contexte, scope, 'modifie', article);
  return rendre(scope, trouverArticle(scope, listeId, articleId));
}

export function retirerArticle(contexte: Contexte, scope: GroupScope, listeId: string, articleId: string): void {
  const article = trouverArticle(scope, listeId, articleId);
  if (!supprimerArticleEnBase(scope, article.id)) throw new ErreurHttp(404, 'article.introuvable');
  diffuserArticle(contexte, scope, 'supprime', article);
}

/** Les conflits sont des 409 qui NOMMENT celui qui a gagné : l'interface dit « Camille l'a déjà pris » sans second appel. */
function leverConflit(scope: GroupScope, resultat: ResultatArticle): void {
  if (resultat.etat === 'introuvable') throw new ErreurHttp(404, 'article.introuvable');
  if (resultat.etat === 'ok') return;
  const par: Personne = { membership_id: resultat.par, display_name: noms(scope).get(resultat.par) ?? '' };
  throw new ErreurHttp(409, resultat.etat === 'deja_pris' ? 'article.deja_pris' : 'article.pas_le_votre', undefined, undefined, { pris_par: par });
}

/** « Je le prends » / « finalement non » : toujours MON marquage, aucun identifiant de membre ne transite par le corps. */
export function definirPreneur(contexte: Contexte, scope: GroupScope, listeId: string, articleId: string, prend: boolean): ArticlePublic {
  trouverListe(scope, listeId);
  const resultat = definirPreneurEnBase(scope, listeId, articleId, prend, versInstant(contexte.horloge()));
  leverConflit(scope, resultat);
  const article = trouverArticle(scope, listeId, articleId);
  if (resultat.etat === 'ok' && resultat.change) diffuserArticle(contexte, scope, prend ? 'pris' : 'libere', article);
  return rendre(scope, article);
}

/** Acheté / décoché. */
export function definirFait(contexte: Contexte, scope: GroupScope, listeId: string, articleId: string, fait: boolean): ArticlePublic {
  trouverListe(scope, listeId);
  const resultat = definirFaitEnBase(scope, listeId, articleId, fait, versInstant(contexte.horloge()));
  leverConflit(scope, resultat);
  const article = trouverArticle(scope, listeId, articleId);
  if (resultat.etat === 'ok' && resultat.change) diffuserArticle(contexte, scope, fait ? 'coche' : 'decoche', article);
  return rendre(scope, article);
}
