// Les types du flux sont définis ICI (et ré-exportés par `tempsReel`) pour que ce module reste PUR : les tests
// unitaires, compilés en `nodenext`, ne peuvent pas suivre l'import de `tempsReel` (extensions relatives).

export interface EvenementTempsReel {
  /** `ressource.verbe` : `article.coche`, `liste.creee`, `tache.assignee`… */
  type: string;
  ressource: string;
  id: string;
  /** La liste d'un article, l'événement d'une tâche ou d'une liste… */
  parent_id: string | null;
  /** Appartenance de l'auteur du changement. */
  par: string;
  at: string;
}

export type EtatFlux = 'connecte' | 'reconnexion';

/** Ce qu'un abonné fournit. Lu à travers une `ref` : les fonctions peuvent changer à chaque rendu. */
export interface RappelsTempsReel {
  readonly onEvenement: (e: EvenementTempsReel) => void;
  /**
   * Appelé à CHAQUE connexion réussie du flux — y compris une reconnexion après coupure, car le
   * serveur ne rejoue rien (ADR-0011, décision 3) — et à l'abonnement s'il a lieu APRÈS qu'une
   * connexion a déjà abouti. Autrement dit : « recharge ce que tu affiches ».
   */
  readonly onOuvert: () => void;
  readonly onEtat?: ((etat: EtatFlux) => void) | undefined;
}

/** La référence que `useTempsReelGroupe` passe au canal : son `.current` est relu à chaque appel. */
export interface ReferenceAbonne {
  readonly current: RappelsTempsReel;
}

export interface CanalGroupe {
  /** Inscrit un abonné ; la fonction rendue le retire (idempotente). */
  readonly abonner: (abonne: ReferenceAbonne) => () => void;
  /** Un message du flux : distribué à TOUS les abonnés, qui filtrent eux-mêmes. */
  readonly diffuser: (e: EvenementTempsReel) => void;
  /** Une connexion a abouti : tous les abonnés rechargent. */
  readonly signalerOuverture: () => void;
  readonly signalerEtat: (etat: EtatFlux) => void;
  /** Pour les tests et le diagnostic. */
  readonly nombreAbonnes: () => number;
}

/**
 * Un seul flux SSE par groupe, N abonnés. Volontairement SANS React et SANS EventSource : le
 * transport reste `ouvrirTempsReel` (qui porte la reconnexion progressive `RETENTES_MS`), et toute
 * la logique de partage est ici, donc éprouvable sans navigateur.
 *
 * Deux règles qui font la correction de l'ensemble :
 *  - `signalerOuverture` appelle `onOuvert` sur TOUS les abonnés, à chaque (re)connexion : la
 *    sémantique d'avant le partage (un `onopen` = un rechargement par vue) est conservée ;
 *  - un abonné qui arrive APRÈS l'ouverture reçoit `onOuvert` tout de suite, sinon il attendrait
 *    le prochain message ou la prochaine coupure pour se synchroniser.
 */
export function creerCanalGroupe(): CanalGroupe {
  const abonnes = new Set<ReferenceAbonne>();
  let aEteOuvert = false;
  let dernierEtat: EtatFlux | undefined;

  /** Un abonné qui lève ne doit pas priver les autres du message. L'erreur est journalisée, jamais avalée. */
  const sans = (quoi: string, action: () => void): void => {
    try {
      action();
    } catch (erreur) {
      console.error(`Abonné au flux du groupe en échec (${quoi}) :`, erreur);
    }
  };

  return {
    abonner: (abonne) => {
      abonnes.add(abonne);
      const etatRejoue = dernierEtat;
      if (etatRejoue !== undefined) sans('onEtat', () => abonne.current.onEtat?.(etatRejoue));
      if (aEteOuvert) sans('onOuvert', () => abonne.current.onOuvert());
      return () => {
        abonnes.delete(abonne);
      };
    },
    diffuser: (e) => {
      for (const a of [...abonnes]) sans('onEvenement', () => a.current.onEvenement(e));
    },
    signalerOuverture: () => {
      aEteOuvert = true;
      for (const a of [...abonnes]) sans('onOuvert', () => a.current.onOuvert());
    },
    signalerEtat: (etat) => {
      dernierEtat = etat;
      for (const a of [...abonnes]) sans('onEtat', () => a.current.onEtat?.(etat));
    },
    nombreAbonnes: () => abonnes.size,
  };
}
