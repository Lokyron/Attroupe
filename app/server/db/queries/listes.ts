import { z } from 'zod';
import type { GroupScope } from '../scope.js';

// Listes de courses et articles (lot 6). Toutes les fonctions prennent un `GroupScope` : le groupe est celui du scope, jamais un
// paramètre. `category` (réservé V2) n'est ni écrite ni lue : `ligneArticle` ne la déclare pas, donc elle ne sort jamais.
//
// Les écritures qui se disputent (preneur, case cochée) sont des `UPDATE` CONDITIONNELS : la condition est dans le `WHERE`, la base
// tranche, et `false` veut dire « quelqu'un a été plus rapide ». Jamais « je lis, puis j'écris » : c'est la seule forme qui reste
// juste quand huit personnes cochent en même temps.

export type TypeListe = 'courses' | 'affaires' | 'taches';

const ligneListe = z.object({
  id: z.string(),
  event_id: z.string().nullable(),
  title: z.string(),
  kind: z.enum(['courses', 'affaires', 'taches']),
  created_by_membership_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Liste = z.infer<typeof ligneListe>;

const ligneArticle = z.object({
  id: z.string(),
  shopping_list_id: z.string(),
  label: z.string(),
  quantity: z.string().nullable(),
  claimed_by_membership_id: z.string().nullable(),
  claimed_at: z.string().nullable(),
  is_done: z.union([z.literal(0), z.literal(1)]),
  done_at: z.string().nullable(),
  position: z.number().int(),
  created_by_membership_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Article = z.infer<typeof ligneArticle>;

/**
 * Écart entre deux positions voisines à l'ajout. Un déplacement place l'article au MILIEU de ses voisines (une seule ligne écrite) ;
 * l'écart se réduit de moitié à chaque insertion au même endroit, et la liste n'est renumérotée que lorsqu'il n'en reste plus.
 */
export const PAS_POSITION = 1024;

/** Ordre d'une liste : par position, puis par identifiant. À position égale (collision), l'identifiant tranche : l'ordre est déterministe. */
const ORDRE_ARTICLES = [{ colonne: 'position' }, { colonne: 'id' }] as const;

// --- Listes -------------------------------------------------------------------------------------------------------------

/** Une liste de CE groupe, ou `undefined` (404 `liste.introuvable` : la liste d'un autre groupe est introuvable). */
export function lireListe(scope: GroupScope, listeId: string): Liste | undefined {
  const ligne = scope.un<unknown>('shopping_lists', listeId);
  return ligne === undefined ? undefined : ligneListe.parse(ligne);
}

/** Les listes du groupe, de la plus ancienne à la plus récente ; `eventId` restreint à celles d'un événement. */
export function listerListes(scope: GroupScope, eventId?: string): Liste[] {
  const filtres = eventId === undefined ? [] : [{ colonne: 'event_id', operateur: '=' as const, valeur: eventId }];
  return scope.tous<unknown>('shopping_lists', filtres, { ordre: [{ colonne: 'created_at' }, { colonne: 'id' }] }).map((ligne) => ligneListe.parse(ligne));
}

export function creerListe(
  scope: GroupScope,
  champs: { readonly title: string; readonly event_id: string | null; readonly kind?: TypeListe },
): string {
  return scope.inserer('shopping_lists', {
    title: champs.title,
    event_id: champs.event_id,
    kind: champs.kind ?? 'courses',
  });
}

export function renommerListe(
  scope: GroupScope,
  listeId: string,
  champs: { readonly title?: string | undefined; readonly kind?: TypeListe | undefined },
): boolean {
  return scope.modifier('shopping_lists', listeId, {
    ...(champs.title !== undefined ? { title: champs.title } : {}),
    ...(champs.kind !== undefined ? { kind: champs.kind } : {}),
  });
}

/**
 * Suppression logique de la liste ET de ses articles, dans la même transaction (cascade logique) : un article ne survit pas à sa
 * liste, même lu par un chemin qui ne regarderait pas la liste d'abord.
 */
export function supprimerListe(scope: GroupScope, listeId: string): boolean {
  return scope.transaction(() => {
    if (!scope.supprimerDoux('shopping_lists', listeId)) return false;
    for (const article of articlesDe(scope, listeId)) scope.supprimerDoux('shopping_items', article.id);
    return true;
  });
}

// --- Articles -----------------------------------------------------------------------------------------------------------

/** Les articles de la liste, dans l'ordre de la liste (position, puis identifiant). */
export function articlesDe(scope: GroupScope, listeId: string): Article[] {
  return scope
    .tous<unknown>('shopping_items', [{ colonne: 'shopping_list_id', operateur: '=', valeur: listeId }], { ordre: ORDRE_ARTICLES })
    .map((ligne) => ligneArticle.parse(ligne));
}

/** Tous les articles du groupe, pour les compteurs de la liste des listes (une requête, pas une par liste). */
export function tousLesArticles(scope: GroupScope): Article[] {
  return scope.tous<unknown>('shopping_items', [], { ordre: ORDRE_ARTICLES }).map((ligne) => ligneArticle.parse(ligne));
}

/** Un article de CETTE liste : l'article d'une autre liste (même du même groupe) est introuvable par ce chemin. */
export function lireArticle(scope: GroupScope, listeId: string, articleId: string): Article | undefined {
  const ligne = scope.un<unknown>('shopping_items', articleId);
  if (ligne === undefined) return undefined;
  const article = ligneArticle.parse(ligne);
  return article.shopping_list_id === listeId ? article : undefined;
}

/** Plafond d'articles (non supprimés) par liste : une liste de courses n'est pas un entrepôt, et la liste entière est relue à chaque déplacement. */
export const MAX_ARTICLES_PAR_LISTE = 500;

/** Ajoute en fin de liste (`max(position) + PAS`), dans la transaction qui lit la fin et écrit. `undefined` : plafond atteint, rien n'est écrit. */
export function creerArticle(scope: GroupScope, listeId: string, champs: { readonly label: string; readonly quantity: string | null }): string | undefined {
  return scope.transaction(() => {
    const articles = articlesDe(scope, listeId);
    if (articles.length >= MAX_ARTICLES_PAR_LISTE) return undefined;
    const derniere = articles.at(-1);
    return scope.inserer('shopping_items', {
      shopping_list_id: listeId,
      label: champs.label,
      quantity: champs.quantity,
      position: derniere === undefined ? PAS_POSITION : derniere.position + PAS_POSITION,
    });
  });
}

/** Libellé et quantité (une clé absente n'est pas touchée) ; `false` si l'article n'est plus là. */
export function modifierArticle(scope: GroupScope, articleId: string, champs: { readonly label?: string | undefined; readonly quantity?: string | null | undefined }): boolean {
  const valeurs: Record<string, string | null> = {};
  if (champs.label !== undefined) valeurs['label'] = champs.label;
  if (champs.quantity !== undefined) valeurs['quantity'] = champs.quantity;
  return scope.modifier('shopping_items', articleId, valeurs);
}

export function supprimerArticle(scope: GroupScope, articleId: string): boolean {
  return scope.supprimerDoux('shopping_items', articleId);
}

/**
 * Position à donner entre deux voisines, ou `undefined` s'il n'y a plus de place entre elles (écart < 2, y compris deux positions
 * égales après une collision) : l'appelant renumérote alors la liste.
 */
export function positionEntre(precedente: number | undefined, suivante: number | undefined): number | undefined {
  if (precedente === undefined && suivante === undefined) return PAS_POSITION;
  if (precedente === undefined) return (suivante ?? 0) - PAS_POSITION;
  if (suivante === undefined) return precedente + PAS_POSITION;
  const ecart = suivante - precedente;
  return ecart >= 2 ? precedente + Math.floor(ecart / 2) : undefined;
}

export type ResultatDeplacement = 'deplace' | 'article_introuvable' | 'reference_introuvable';

/**
 * Place l'article APRÈS `apresId` (`null` : en tête), dans la liste. On désigne un voisin et non une position absolue : deux
 * personnes qui réordonnent en même temps ne s'écrasent pas, chacune place sa ligne par rapport à ce qu'elle voit. Une seule ligne
 * est écrite (la sienne), sauf quand l'écart entre voisines est épuisé : la liste est alors renumérotée, en conservant son ordre.
 * La référence doit être un AUTRE article de la même liste.
 */
export function deplacerArticle(scope: GroupScope, listeId: string, articleId: string, apresId: string | null): ResultatDeplacement {
  return scope.transaction(() => {
    const articles = articlesDe(scope, listeId);
    const deplace = articles.find((a) => a.id === articleId);
    if (deplace === undefined) return 'article_introuvable' as const;
    const autres = articles.filter((a) => a.id !== articleId);
    let rang = 0;
    if (apresId !== null) {
      const voisine = autres.findIndex((a) => a.id === apresId);
      if (voisine < 0) return 'reference_introuvable' as const;
      rang = voisine + 1;
    }
    const position = positionEntre(autres[rang - 1]?.position, autres[rang]?.position);
    if (position !== undefined) {
      scope.modifier('shopping_items', articleId, { position });
      return 'deplace' as const;
    }
    // Plus de place entre les deux voisines : on renumérote (une écriture par article dont la position change).
    const nouvelOrdre = [...autres.slice(0, rang), deplace, ...autres.slice(rang)];
    nouvelOrdre.forEach((article, i) => {
      const cible = (i + 1) * PAS_POSITION;
      if (article.position !== cible) scope.modifier('shopping_items', article.id, { position: cible });
    });
    return 'deplace' as const;
  });
}

export type ResultatArticle =
  | { readonly etat: 'ok'; readonly change: boolean }
  | { readonly etat: 'introuvable' }
  /** « Je le prends » alors qu'un autre l'a pris : `par` est son appartenance. */
  | { readonly etat: 'deja_pris'; readonly par: string }
  /** « Finalement non » sur l'article d'un autre : on ne retire que son propre marquage. */
  | { readonly etat: 'pas_le_votre'; readonly par: string };

/**
 * « Je le prends » (`prend = true`) / « finalement non » (`false`). Un seul `UPDATE` conditionnel, dans une transaction :
 *  - prendre : `… WHERE claimed_by_membership_id IS NULL` — deux appels simultanés, un seul passe, l'autre apprend QUI l'a pris ;
 *  - se retirer : `… WHERE claimed_by_membership_id = <moi>` — on ne retire que son propre marquage.
 * Le marquage d'un membre qui a quitté le groupe est libre : tout membre actif peut le reprendre ou le libérer (décision du lot 6, après revue).
 * Refaire ce qui est déjà fait (je le prends alors que je l'ai déjà) est un succès sans changement : `change = false`.
 * `claimed_by_membership_id` et `claimed_at` s'écrivent ensemble (CHECK du schéma).
 */
export function definirPreneur(scope: GroupScope, listeId: string, articleId: string, prend: boolean, maintenant: string): ResultatArticle {
  return scope.transaction(() => {
    const article = lireArticle(scope, listeId, articleId);
    if (article === undefined) return { etat: 'introuvable' } as const;
    const passe = prend
      ? scope.modifier('shopping_items', article.id, { claimed_by_membership_id: scope.membershipId, claimed_at: maintenant }, [{ colonne: 'claimed_by_membership_id', operateur: 'IS NULL' }])
      : scope.modifier('shopping_items', article.id, { claimed_by_membership_id: null, claimed_at: null }, [{ colonne: 'claimed_by_membership_id', operateur: '=', valeur: scope.membershipId }]);
    if (passe) return { etat: 'ok', change: true } as const;
    // La condition ne tenait pas : on relit pour dire pourquoi.
    const actuel = lireArticle(scope, listeId, articleId);
    if (actuel === undefined) return { etat: 'introuvable' } as const;
    const detenteur = actuel.claimed_by_membership_id;
    // Le preneur n'est plus dans le groupe (retiré, parti) : son marquage ne retient plus personne. Quiconque peut alors le reprendre ou le
    // libérer, sinon l'article serait bloqué pour toujours. Vérifié ICI, dans la même transaction, et écrit sous la condition « toujours
    // à ce preneur-là » : un retour du membre entre-temps ne se fait pas écraser.
    if (detenteur !== null && detenteur !== scope.membershipId && scope.un<{ status: string }>('memberships', detenteur)?.status !== 'active') {
      const valeurs = prend ? { claimed_by_membership_id: scope.membershipId, claimed_at: maintenant } : { claimed_by_membership_id: null, claimed_at: null };
      if (scope.modifier('shopping_items', article.id, valeurs, [{ colonne: 'claimed_by_membership_id', operateur: '=', valeur: detenteur }])) {
        return { etat: 'ok', change: true } as const;
      }
    }
    if (prend) {
      if (detenteur === null) throw new Error('Preneur : la condition « libre » a échoué sur un article libre.');
      return detenteur === scope.membershipId ? ({ etat: 'ok', change: false } as const) : ({ etat: 'deja_pris', par: detenteur } as const);
    }
    return detenteur === null ? ({ etat: 'ok', change: false } as const) : ({ etat: 'pas_le_votre', par: detenteur } as const);
  });
}

/**
 * Acheté (`fait = true`) / décoché. `UPDATE … WHERE is_done = <état de départ>` : deux personnes qui cochent la même case en même
 * temps ne se marchent pas dessus (la seconde ne change rien, `done_at` garde l'instant du premier), et `is_done` / `done_at`
 * s'écrivent ensemble (CHECK du schéma).
 */
export function definirFait(scope: GroupScope, listeId: string, articleId: string, fait: boolean, maintenant: string): ResultatArticle {
  return scope.transaction(() => {
    const article = lireArticle(scope, listeId, articleId);
    if (article === undefined) return { etat: 'introuvable' } as const;
    const passe = scope.modifier('shopping_items', article.id, { is_done: fait ? 1 : 0, done_at: fait ? maintenant : null }, [
      { colonne: 'is_done', operateur: '=', valeur: fait ? 0 : 1 },
    ]);
    return { etat: 'ok', change: passe } as const;
  });
}
