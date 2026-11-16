import type { OptionsApp } from '../../server/http/app.js';
import type { Decor } from './comptes.js';
import { decor, groupe, membreDe, personne, type GroupeAmorce, type Personne } from './groupes.js';

// Décor des tests du lot 6 : un groupe A (Alice administratrice, Carole et Erin simples membres), un groupe B étranger (Bob), et
// des raccourcis pour lister, créer et lire. Aucun droit particulier : ce sont des membres ordinaires qui cochent.

export interface Courses {
  readonly d: Decor;
  readonly alice: Personne;
  readonly carole: Personne;
  readonly erin: Personne;
  readonly bob: Personne;
  readonly a: GroupeAmorce;
  readonly b: GroupeAmorce;
  /** Appartenance d'une personne dans A. */
  readonly membreA: (p: Personne) => string;
  /** Nom affiché du compte. */
  readonly nom: (p: Personne) => string;
  /** `/api/groupes/<A>` + `suite`. */
  readonly chemin: (suite: string) => string;
  /** Crée une liste dans A (par `auteur`) et renvoie son identifiant. */
  readonly creerListe: (auteur: Personne, titre?: string, eventId?: string | null) => Promise<string>;
  /** Ajoute des articles à la liste et renvoie leurs identifiants, dans l'ordre. */
  readonly ajouter: (auteur: Personne, listeId: string, ...labels: string[]) => Promise<string[]>;
  /** Crée un événement dans A et renvoie son identifiant. */
  readonly creerEvenement: (auteur: Personne, titre?: string) => Promise<string>;
}

export async function courses(prefixe: string, surcharges: Partial<OptionsApp> = {}): Promise<Courses> {
  const d = decor(surcharges);
  const alice = await personne(d, `alice_${prefixe}`);
  const carole = await personne(d, `carole_${prefixe}`);
  const erin = await personne(d, `erin_${prefixe}`);
  const bob = await personne(d, `bob_${prefixe}`);
  const a = await groupe(d, 'Les potes', [
    { personne: alice, role: 'admin' },
    { personne: carole, role: 'member' },
    { personne: erin, role: 'member' },
  ]);
  const b = await groupe(d, 'Les voisins', [{ personne: bob, role: 'admin' }]);
  const chemin = (suite: string): string => `/api/groupes/${a.groupId}${suite}`;
  return {
    d,
    alice,
    carole,
    erin,
    bob,
    a,
    b,
    membreA: (p) => membreDe(a, p),
    nom: (p) => d.sql.prepare('SELECT display_name FROM users WHERE id = ?').pluck().get(p.userId) as string,
    chemin,
    creerListe: async (auteur, titre = 'Courses du barbecue', eventId = null) => {
      const r = await auteur.client.post(chemin('/listes'), { title: titre, event_id: eventId });
      if (r.statut !== 201) throw new Error(`Liste refusée : ${JSON.stringify(r.corps)}`);
      return r.corps['id'] as string;
    },
    ajouter: async (auteur, listeId, ...labels) => {
      const ids: string[] = [];
      for (const label of labels) {
        const r = await auteur.client.post(chemin(`/listes/${listeId}/articles`), { label });
        if (r.statut !== 201) throw new Error(`Article refusé : ${JSON.stringify(r.corps)}`);
        ids.push(r.corps['id'] as string);
      }
      return ids;
    },
    creerEvenement: async (auteur, titre = 'Barbecue') => {
      const r = await auteur.client.post(chemin('/evenements'), { title: titre, starts_at: '2027-03-20T18:00:00Z', time_zone: 'Europe/Paris' });
      if (r.statut !== 201) throw new Error(`Événement refusé : ${JSON.stringify(r.corps)}`);
      return r.corps['id'] as string;
    },
  };
}
