import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { creerCanalGroupe, type CanalGroupe, type RappelsTempsReel } from '../api/canalGroupe';
import { lireGroupe, type DetailGroupe } from '../api/groupes';
import { ouvrirTempsReel } from '../api/tempsReel';
import { useLecture, type EtatLecture } from '../hooks/useLecture';

export interface ValeurGroupe {
  readonly groupId: string;
  /** `null` tant que la lecture du groupe n'a pas abouti. C'est `etat === 'pret'` qui dit qu'elle a abouti. */
  readonly groupe: DetailGroupe | null;
  /**
   * Nom affichable DÈS LE PREMIER RENDU : celui du groupe lu, sinon celui que la coque connaît déjà
   * par `moi.groupes`. C'est ce repli qui supprime le saut de titre de `EnteteGroupe`.
   */
  readonly nom: string;
  readonly etat: EtatLecture;
  readonly erreur: string | null;
  /** Relance la lecture du groupe DEPUIS ZÉRO. À brancher sur « Réessayer ». */
  readonly rechargerGroupe: () => void;
  /** Relit le groupe SANS vider l'écran : après un renommage, un changement de visibilité, un branchement Immich. */
  readonly rafraichirGroupe: () => void;
  /** Le flux du groupe, partagé. Identité STABLE pour toute la vie du fournisseur. */
  readonly canal: CanalGroupe;
}

const ContexteGroupe = createContext<ValeurGroupe | null>(null);

/**
 * Porte, pour toute la durée de la visite d'un groupe : l'unique lecture de `lireGroupe` et
 * l'unique flux SSE. Monté avec `key={groupId}` dans `App.tsx` : changer de groupe DÉMONTE ce
 * fournisseur, ce qui ferme le flux et jette les données de l'ancien groupe — aucune donnée d'un
 * groupe ne peut survivre à l'affichage d'un autre.
 *
 * Il ne RETARDE PAS ses enfants : ils se montent tout de suite et lancent leurs lectures en
 * parallèle de celle du groupe, puis fusionnent les états (`hooks/etatsLecture.ts`). Les faire
 * attendre donnerait deux squelettes successifs.
 */
export function FournisseurGroupe({
  groupId,
  nomInitial,
  children,
}: {
  readonly groupId: string;
  readonly nomInitial?: string | undefined;
  readonly children: ReactNode;
}) {
  const { donnees, etat, erreur, recharger, rafraichir } = useLecture(() => lireGroupe(groupId), [groupId]);

  // Créé une seule fois : `useTempsReelGroupe` s'abonne sur cette identité, et un canal recréé
  // ferait se réabonner tous les abonnés à chaque rendu (donc recharger en boucle).
  const canalRef = useRef<CanalGroupe | null>(null);
  canalRef.current ??= creerCanalGroupe();
  const canal = canalRef.current;

  useEffect(() => {
    // `ouvrirTempsReel` garde tout ce qui est acquis : reconnexion d'EventSource, reprise avec
    // RETENTES_MS après un refus (429, 404), détection du 401 par `/api/moi`.
    return ouvrirTempsReel(groupId, {
      onEvenement: (e) => canal.diffuser(e),
      onOuvert: () => canal.signalerOuverture(),
      onEtat: (etatFlux) => canal.signalerEtat(etatFlux),
    });
  }, [groupId, canal]);

  const nom = donnees?.name ?? nomInitial ?? '';
  const valeur = useMemo<ValeurGroupe>(
    () => ({
      groupId,
      groupe: donnees,
      nom,
      etat,
      erreur,
      rechargerGroupe: recharger,
      rafraichirGroupe: rafraichir,
      canal,
    }),
    [groupId, donnees, nom, etat, erreur, recharger, rafraichir, canal],
  );

  return <ContexteGroupe.Provider value={valeur}>{children}</ContexteGroupe.Provider>;
}

/**
 * Le groupe courant. Hors de `<FournisseurGroupe>`, LÈVE : ce n'est pas une erreur d'exécution
 * récupérable mais une faute de montage (une vue de groupe rendue hors d'une route de groupe), et
 * un repli silencieux la transformerait en page vide inexplicable.
 */
export function useGroupe(): ValeurGroupe {
  const valeur = useContext(ContexteGroupe);
  if (valeur === null) {
    throw new Error('useGroupe() appelé hors de <FournisseurGroupe> : cette vue doit être montée sous une route de groupe.');
  }
  return valeur;
}

/**
 * Abonne le composant à l'UNIQUE flux du groupe, tant qu'il est monté. Remplace `useTempsReel` :
 * pas de `groupId` à passer (il vient du fournisseur) et aucune connexion ouverte ici.
 *  - `onEvenement` est appelé pour TOUS les messages du groupe : l'abonné filtre lui-même
 *    (`e.ressource`, `e.id`, `e.parent_id`), exactement comme avant, et regroupe ses rafales avec
 *    `useRechargement.planifier` ;
 *  - `onOuvert` est appelé à chaque (re)connexion ET à l'abonnement si le flux est déjà ouvert ;
 *  - les rappels sont lus dans une `ref` : ils peuvent changer à chaque rendu sans réabonnement.
 */
export function useTempsReelGroupe(rappels: RappelsTempsReel): void {
  const { canal } = useGroupe();
  const derniers = useRef(rappels);
  derniers.current = rappels;
  // Dépendance au SEUL canal (stable) : mettre `rappels` ici provoquerait un réabonnement par
  // rendu, donc un `onOuvert` par rendu, donc une boucle de rechargement infinie.
  const abonner = canal.abonner;
  useEffect(() => abonner(derniers), [abonner]);
}
