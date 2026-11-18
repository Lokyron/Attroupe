import { appeler, booleen, champ, liste, nombre, texte, texteOuNul } from './client';

// Sources d'agenda externe (ADR-0013) : l'application s'abonne à une URL ICS distante et n'en retient que des
// PLAGES d'indisponibilité. L'URL n'est JAMAIS rendue par l'API — elle donne accès au calendrier complet de
// l'utilisateur, détails compris. Seul l'hôte revient, pour que l'écran puisse dire « agenda chez google.com ».

/** Résultat de la dernière tentative. `null` : jamais tentée. */
export type StatutSource = 'ok' | 'vide' | 'injoignable' | 'trop_gros' | 'illisible' | 'refuse' | 'cle_illisible';

export interface SourceAgenda {
  id: string;
  label: string;
  /** Hôte seul (`calendar.google.com`) : l'URL complète ne sort jamais du serveur. */
  url_host: string;
  created_at: string;
  updated_at: string;
  disabled_at: string | null;
  next_attempt_at: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_status: StatutSource | null;
  consecutive_failures: number;
  slots_imported: number;
  /** Événements que l'analyseur n'a pas su lire (récurrences exotiques) : comptés, jamais devinés. */
  slots_skipped: number;
}

/** Bilan d'une synchronisation. Un 201 ne veut PAS dire qu'elle a réussi : c'est `statut` qui le dit. */
export interface BilanSynchro {
  statut: StatutSource;
  creneaux_importes: number;
  ignores: number;
  /** Le lot a été réécrit. Faux sur un 304 ou un échec : les créneaux précédents sont conservés. */
  modifiee: boolean;
  desactivee: boolean;
}

export interface SourceAvecBilan extends SourceAgenda {
  synchronisation: BilanSynchro;
}

function statut(valeur: unknown): StatutSource {
  const connus = ['ok', 'vide', 'injoignable', 'trop_gros', 'illisible', 'refuse', 'cle_illisible'] as const;
  const trouve = connus.find((s) => s === valeur);
  if (trouve === undefined) throw new Error('Réponse inattendue : statut de source inconnu.');
  return trouve;
}

function statutOuNul(valeur: unknown): StatutSource | null {
  return valeur === null ? null : statut(valeur);
}

function source(s: unknown): SourceAgenda {
  return {
    id: texte(champ(s, 'id')),
    label: texte(champ(s, 'label')),
    url_host: texte(champ(s, 'url_host')),
    created_at: texte(champ(s, 'created_at')),
    updated_at: texte(champ(s, 'updated_at')),
    disabled_at: texteOuNul(champ(s, 'disabled_at')),
    next_attempt_at: texte(champ(s, 'next_attempt_at')),
    last_attempt_at: texteOuNul(champ(s, 'last_attempt_at')),
    last_success_at: texteOuNul(champ(s, 'last_success_at')),
    last_status: statutOuNul(champ(s, 'last_status')),
    consecutive_failures: nombre(champ(s, 'consecutive_failures')),
    slots_imported: nombre(champ(s, 'slots_imported')),
    slots_skipped: nombre(champ(s, 'slots_skipped')),
  };
}

function bilan(b: unknown): BilanSynchro {
  return {
    statut: statut(champ(b, 'statut')),
    creneaux_importes: nombre(champ(b, 'creneaux_importes')),
    ignores: nombre(champ(b, 'ignores')),
    modifiee: booleen(champ(b, 'modifiee')),
    desactivee: booleen(champ(b, 'desactivee')),
  };
}

function sourceAvecBilan(r: unknown): SourceAvecBilan {
  return { ...source(r), synchronisation: bilan(champ(r, 'synchronisation')) };
}

export async function listerSources(): Promise<SourceAgenda[]> {
  return liste(champ(await appeler('GET', '/api/moi/agenda/sources'), 'sources')).map(source);
}

/**
 * Ajoute une source et la synchronise DANS LA MÊME REQUÊTE — seul moyen de valider l'URL et d'annoncer
 * « 127 créneaux importés » ou « injoignable ». La requête peut donc durer jusqu'à 20 s, et la source est
 * créée même si cette première synchronisation échoue : c'est `synchronisation.statut` qu'il faut lire.
 */
export async function ajouterSource(url: string, label: string | null): Promise<SourceAvecBilan> {
  return sourceAvecBilan(await appeler('POST', '/api/moi/agenda/sources', label === null ? { url } : { url, label }));
}

export async function modifierSource(id: string, champs: { label?: string; disabled?: boolean }): Promise<SourceAgenda> {
  return source(await appeler('PATCH', `/api/moi/agenda/sources/${encodeURIComponent(id)}`, champs));
}

export async function supprimerSource(id: string): Promise<void> {
  await appeler('DELETE', `/api/moi/agenda/sources/${encodeURIComponent(id)}`);
}

/** Relance à la demande (1 fois par 5 min et par source). Un succès réactive une source désactivée. */
export async function synchroniserSource(id: string): Promise<SourceAvecBilan> {
  return sourceAvecBilan(await appeler('POST', `/api/moi/agenda/sources/${encodeURIComponent(id)}/synchronisation`));
}
