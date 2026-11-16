import { appeler, champ, liste, texte, texteOuNul } from './client';

// Abonnements calendrier (flux iCal, architecture §7.1). Le jeton n'est rendu que par la création : `AbonnementCree.url`.

export interface Abonnement {
  id: string;
  label: string | null;
  group_id: string | null;
  group_name: string | null;
  include_declined: boolean;
  created_at: string;
  last_used_at: string | null;
  last_user_agent: string | null;
  revoked_at: string | null;
}

export interface AbonnementCree extends Abonnement {
  /** Adresse complète à coller dans le calendrier. Jamais relue ailleurs. */
  url: string;
}

function abonnement(a: unknown): Abonnement {
  return {
    id: texte(champ(a, 'id')),
    label: texteOuNul(champ(a, 'label')),
    group_id: texteOuNul(champ(a, 'group_id')),
    group_name: texteOuNul(champ(a, 'group_name')),
    include_declined: champ(a, 'include_declined') === 1,
    created_at: texte(champ(a, 'created_at')),
    last_used_at: texteOuNul(champ(a, 'last_used_at')),
    last_user_agent: texteOuNul(champ(a, 'last_user_agent')),
    revoked_at: texteOuNul(champ(a, 'revoked_at')),
  };
}

export async function listerAbonnements(): Promise<Abonnement[]> {
  return liste(champ(await appeler('GET', '/api/moi/flux-ical'), 'abonnements')).map(abonnement);
}

export async function creerAbonnement(corps: { label: string | null; group_id: string | null; include_declined: boolean }): Promise<AbonnementCree> {
  const r = await appeler('POST', '/api/moi/flux-ical', corps);
  return { ...abonnement(r), url: texte(champ(r, 'url')) };
}

export async function revoquerAbonnement(id: string): Promise<void> {
  await appeler('DELETE', `/api/moi/flux-ical/${encodeURIComponent(id)}`);
}
