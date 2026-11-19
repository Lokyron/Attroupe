import { useEffect, useRef } from 'react';
import { champ, SESSION_EXPIREE, texte, texteOuNul } from './client';

// Le flux temps réel du groupe (SSE, architecture §3.2) : descendant seulement. Le message est MINIMAL (type, identifiant, parent) :
// il dit « ceci a changé », jamais « voici la nouvelle valeur ». Le client recharge ce qu'il a le droit de voir par les routes
// ordinaires, qui passent par le cloisonnement. La forme est stable : les messages de discussion du lot 10 s'y ajoutent sans la changer.

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

/** Délais de nouvelle tentative quand le serveur a REFUSÉ le flux (EventSource ne retente alors plus de lui-même), en ms. */
const RETENTES_MS = [2000, 5000, 15000, 30000] as const;

function evenement(donnees: string): EvenementTempsReel {
  const brut: unknown = JSON.parse(donnees);
  return {
    type: texte(champ(brut, 'type')),
    ressource: texte(champ(brut, 'ressource')),
    id: texte(champ(brut, 'id')),
    parent_id: texteOuNul(champ(brut, 'parent_id')),
    par: texte(champ(brut, 'par')),
    at: texte(champ(brut, 'at')),
  };
}

/**
 * Ouvre le flux du groupe. Renvoie la fonction qui le ferme.
 *  - La reconnexion après une coupure est CELLE D'EVENTSOURCE (délai `retry:` du serveur) : on ne ferme jamais la source dans `onerror`,
 *    sinon on la casserait. `onOuvert` se déclenche à CHAQUE (re)connexion : l'appelant recharge alors tout (des changements ont pu
 *    passer pendant la coupure, le serveur ne rejoue rien).
 *  - Si le serveur a refusé le flux (429 plafond, 401, 404…), EventSource passe à CLOSED et ne retente plus : on rouvre nous-mêmes, avec un
 *    délai croissant ; si c'est un 401, la page est rechargée (elle affiche alors la connexion).
 */
export function ouvrirTempsReel(
  groupId: string,
  rappels: { onEvenement: (e: EvenementTempsReel) => void; onOuvert: () => void; onEtat: (etat: EtatFlux) => void },
): () => void {
  let source: EventSource | undefined;
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  let ferme = false;
  let echecs = 0;

  const ouvrir = (): void => {
    const s = new EventSource(`/api/groupes/${encodeURIComponent(groupId)}/temps-reel`);
    source = s;
    s.onopen = () => {
      echecs = 0;
      rappels.onEtat('connecte');
      rappels.onOuvert();
    };
    s.onmessage = (m: MessageEvent<string>) => {
      try {
        rappels.onEvenement(evenement(m.data));
      } catch (erreur) {
        console.error('Message temps réel illisible :', erreur);
      }
    };
    s.onerror = () => {
      rappels.onEtat('reconnexion');
      if (s.readyState !== EventSource.CLOSED || ferme) return; // coupure ordinaire : EventSource reconnecte seule
      s.close();
      // EventSource ne montre pas le statut du refus : un 401 (session échue ou révoquée) se reconnaît par une lecture du compte, et ramène à la connexion.
      fetch('/api/moi', { credentials: 'same-origin' })
        .then((r) => {
          // Un rechargement complet de la page jetait au passage tout ce que l'utilisateur était en
          // train de saisir. On emprunte désormais le même chemin que les appels d'API : la coque
          // repasse à l'écran de connexion sans démonter brutalement le navigateur.
          if (r.status === 401 && !ferme) window.dispatchEvent(new Event(SESSION_EXPIREE));
        })
        .catch(() => undefined); // réseau coupé : la nouvelle tentative ci-dessous s'en chargera
      minuterie = setTimeout(ouvrir, RETENTES_MS[Math.min(echecs, RETENTES_MS.length - 1)]);
      echecs += 1;
    };
  };
  ouvrir();

  return () => {
    ferme = true;
    if (minuterie !== undefined) clearTimeout(minuterie);
    source?.close();
  };
}

/** Abonne le composant au flux du groupe tant qu'il est monté. Les rappels peuvent changer à chaque rendu sans rouvrir le flux. */
export function useTempsReel(
  groupId: string,
  rappels: { onEvenement: (e: EvenementTempsReel) => void; onOuvert: () => void; onEtat?: (etat: EtatFlux) => void },
): void {
  const derniers = useRef(rappels);
  derniers.current = rappels;
  useEffect(
    () =>
      ouvrirTempsReel(groupId, {
        onEvenement: (e) => derniers.current.onEvenement(e),
        onOuvert: () => derniers.current.onOuvert(),
        onEtat: (etat) => derniers.current.onEtat?.(etat),
      }),
    [groupId],
  );
}
