import { appeler, booleen, champ, liste, nombre, texte, texteOuNul } from './client';

// Les formes de l'API des listes de courses (architecture §6), relues champ par champ à l'arrivée.

export interface Article {
  id: string;
  label: string;
  quantity: string | null;
  claimed_by_membership_id: string | null;
  claimed_by_name: string | null;
  is_done: boolean;
  position: number;
}

export interface ResumeListe {
  id: string;
  title: string;
  event_id: string | null;
  articles_total: number;
  articles_faits: number;
}

export interface DetailListe {
  id: string;
  title: string;
  event_id: string | null;
  articles: Article[];
}

function article(a: unknown): Article {
  return {
    id: texte(champ(a, 'id')),
    label: texte(champ(a, 'label')),
    quantity: texteOuNul(champ(a, 'quantity')),
    claimed_by_membership_id: texteOuNul(champ(a, 'claimed_by_membership_id')),
    claimed_by_name: texteOuNul(champ(a, 'claimed_by_name')),
    is_done: booleen(champ(a, 'is_done')),
    position: nombre(champ(a, 'position')),
  };
}

function detail(l: unknown): DetailListe {
  return {
    id: texte(champ(l, 'id')),
    title: texte(champ(l, 'title')),
    event_id: texteOuNul(champ(l, 'event_id')),
    articles: liste(champ(l, 'articles')).map(article),
  };
}

const base = (groupId: string): string => `/api/groupes/${encodeURIComponent(groupId)}/listes`;
const uneListe = (groupId: string, id: string): string => `${base(groupId)}/${encodeURIComponent(id)}`;
const unArticle = (groupId: string, listeId: string, id: string): string => `${uneListe(groupId, listeId)}/articles/${encodeURIComponent(id)}`;

export async function listerListes(groupId: string, evenementId?: string): Promise<ResumeListe[]> {
  const requete = evenementId === undefined ? '' : `?event_id=${encodeURIComponent(evenementId)}`;
  return liste(champ(await appeler('GET', `${base(groupId)}${requete}`), 'listes')).map((l) => ({
    id: texte(champ(l, 'id')),
    title: texte(champ(l, 'title')),
    event_id: texteOuNul(champ(l, 'event_id')),
    articles_total: nombre(champ(l, 'articles_total')),
    articles_faits: nombre(champ(l, 'articles_faits')),
  }));
}

export async function lireListe(groupId: string, id: string): Promise<DetailListe> {
  return detail(await appeler('GET', uneListe(groupId, id)));
}

export async function creerListe(groupId: string, title: string, eventId: string | null): Promise<DetailListe> {
  return detail(await appeler('POST', base(groupId), { title, event_id: eventId }));
}

export async function renommerListe(groupId: string, id: string, title: string): Promise<DetailListe> {
  return detail(await appeler('PATCH', uneListe(groupId, id), { title }));
}

export async function supprimerListe(groupId: string, id: string): Promise<void> {
  await appeler('DELETE', uneListe(groupId, id));
}

export async function ajouterArticle(groupId: string, listeId: string, label: string): Promise<Article> {
  return article(await appeler('POST', `${uneListe(groupId, listeId)}/articles`, { label, quantity: null }));
}

/** Place l'article après `apresId` (`null` : en tête). */
export async function deplacerArticle(groupId: string, listeId: string, id: string, apresId: string | null): Promise<Article> {
  return article(await appeler('PATCH', unArticle(groupId, listeId, id), { after_item_id: apresId }));
}

export async function retirerArticle(groupId: string, listeId: string, id: string): Promise<void> {
  await appeler('DELETE', unArticle(groupId, listeId, id));
}

/** « Je le prends » / « finalement non ». Un 409 `article.deja_pris` porte le nom de celui qui l'a pris (`ErreurApi.donnees`). */
export async function definirPreneur(groupId: string, listeId: string, id: string, prend: boolean): Promise<Article> {
  return article(await appeler('PUT', `${unArticle(groupId, listeId, id)}/preneur`, { prend }));
}

export async function definirFait(groupId: string, listeId: string, id: string, fait: boolean): Promise<Article> {
  return article(await appeler('PUT', `${unArticle(groupId, listeId, id)}/fait`, { fait }));
}

/** Nom de celui qui a gagné la course, dans le corps d'un 409 (`pris_par` / `assignee`), s'il y est. */
export function nomDuGagnant(donnees: unknown, cle: 'pris_par' | 'assignee'): string | null {
  try {
    return texte(champ(champ(donnees, cle), 'display_name'));
  } catch {
    return null;
  }
}
