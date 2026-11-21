// Préférences de notification : logique pure (sans DOM ni réseau), testée dans `tests/unite`.
// Deux niveaux existent côté serveur : la ligne globale `'*'` et une ligne par groupe. La ligne d'un groupe est une SURCHARGE PARTIELLE :
// un champ à `null` (mode e-mail, genres coupés) hérite de la ligne globale. La résolution se fait champ par champ : valeur du groupe si
// elle est posée, sinon valeur globale, sinon défaut (e-mail immédiat, rien de coupé). « Suivre le réglage global » est donc un état réel
// (aucun champ posé, ou pas de ligne), pas une recopie.

export type EmailMode = 'immediate' | 'daily' | 'off';

/** Copie de `GENRES_NOTIFICATION` (serveur) : le client n'importe pas le code serveur. Un test garde les deux listes alignées. */
export const GENRES_NOTIFICATION = [
  'invitation_received',
  'member_joined',
  'event_created',
  'event_updated',
  'event_cancelled',
  'poll_opened',
  'poll_closing',
  'item_claimed',
  'task_assigned',
  'message_posted',
  'expense_added',
  'expense_updated',
  'expense_deleted',
  'settlement_created',
  'settlement_confirmed',
  'accounts_closed',
] as const;

export type GenreNotification = (typeof GENRES_NOTIFICATION)[number];

/**
 * Genres que le serveur accepte mais qu'aucun code n'émet encore : on ne les propose pas au réglage (une case qui ne fait rien laisse
 * croire à un contrôle qui n'existe pas). À ranger dans un thème dès que le serveur les émet. Vide aujourd'hui :
 * `invitation_received` est émis à l'envoi d'une invitation à un compte existant.
 */
export const GENRES_NON_EMIS: readonly GenreNotification[] = [];

/** Genres regroupés pour l'affichage ; chaque genre émis apparaît dans exactement un thème (vérifié par test). */
export type ThemeNotification = 'groupe' | 'evenements' | 'sondages' | 'organisation' | 'messages' | 'depenses';

export const THEMES_NOTIFICATION: readonly { readonly cle: ThemeNotification; readonly genres: readonly GenreNotification[] }[] = [
  { cle: 'groupe', genres: ['member_joined', 'invitation_received'] },
  { cle: 'evenements', genres: ['event_created', 'event_updated', 'event_cancelled'] },
  { cle: 'sondages', genres: ['poll_opened', 'poll_closing'] },
  { cle: 'organisation', genres: ['item_claimed', 'task_assigned'] },
  { cle: 'messages', genres: ['message_posted'] },
  {
    cle: 'depenses',
    genres: ['expense_added', 'expense_updated', 'expense_deleted', 'settlement_created', 'settlement_confirmed', 'accounts_closed'],
  },
];

/** Une ligne telle que le serveur la rend : `null` = non posé, hérité de la ligne globale (jamais `null` pour `'*'`). */
export interface PreferenceBrute {
  group_id: string;
  email_mode: EmailMode | null;
  muted_kinds: readonly GenreNotification[] | null;
}

export interface PreferenceEffective {
  email_mode: EmailMode;
  muted_kinds: readonly GenreNotification[];
  /** Le groupe pose lui-même son mode e-mail (toujours faux pour `'*'`). */
  mode_propre: boolean;
  /** Le groupe pose lui-même ses genres coupés (toujours faux pour `'*'`). */
  genres_propres: boolean;
  /** Aucun champ propre : le groupe suit entièrement le réglage global. */
  suit_global: boolean;
}

/**
 * Même résolution que le serveur, champ par champ : valeur du groupe si elle est posée, sinon celle de la ligne `'*'`, sinon le défaut
 * (e-mail immédiat, rien de coupé). Un écart avec le serveur ferait croire qu'un genre est coupé alors qu'il est encore reçu.
 */
export function preferenceEffective(preferences: readonly PreferenceBrute[], groupId: string): PreferenceEffective {
  const specifique = groupId === '*' ? undefined : preferences.find((p) => p.group_id === groupId);
  const globale = preferences.find((p) => p.group_id === '*');
  const modePropre = specifique?.email_mode ?? null;
  const genresPropres = specifique?.muted_kinds ?? null;
  return {
    email_mode: modePropre ?? globale?.email_mode ?? 'immediate',
    muted_kinds: genresPropres ?? globale?.muted_kinds ?? [],
    mode_propre: modePropre !== null,
    genres_propres: genresPropres !== null,
    suit_global: modePropre === null && genresPropres === null,
  };
}

/** Liste de genres coupés après (dé)coupure d'un genre : sans doublon, dans l'ordre de `GENRES_NOTIFICATION`. */
export function basculerGenre(coupes: readonly GenreNotification[], genre: GenreNotification, coupe: boolean): GenreNotification[] {
  const ensemble = new Set(coupes);
  if (coupe) ensemble.add(genre);
  else ensemble.delete(genre);
  return GENRES_NOTIFICATION.filter((g) => ensemble.has(g));
}

export interface ChangementPreference {
  email_mode?: EmailMode;
  muted_kinds?: readonly GenreNotification[];
}

export interface CorpsPreference {
  group_id: string;
  email_mode?: EmailMode;
  muted_kinds?: GenreNotification[];
}

/**
 * Corps du PUT. Un champ absent n'est PAS modifié côté serveur : on n'envoie donc que ce qui change (jamais `undefined`
 * sérialisé en valeur par défaut), et au moins un champ est obligatoire — sinon le serveur répond 400.
 */
export function corpsPreference(groupId: string, changement: ChangementPreference): CorpsPreference {
  if (changement.email_mode === undefined && changement.muted_kinds === undefined) {
    throw new Error('Préférence vide : fournir email_mode ou muted_kinds.');
  }
  const corps: CorpsPreference = { group_id: groupId };
  if (changement.email_mode !== undefined) corps.email_mode = changement.email_mode;
  if (changement.muted_kinds !== undefined) corps.muted_kinds = [...new Set(changement.muted_kinds)];
  return corps;
}

export function estGenreNotification(valeur: unknown): valeur is GenreNotification {
  return typeof valeur === 'string' && (GENRES_NOTIFICATION as readonly string[]).includes(valeur);
}
