import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  listerMessages,
  modifierMessage,
  posterMessage,
  supprimerMessage,
  type Message,
} from '../api/fils';
import { lireGroupe } from '../api/groupes';
import { useRechargement } from '../api/rechargement';
import { useTempsReel } from '../api/tempsReel';
import { useSoumission } from '../hooks/useSoumission';
import { DialogueConfirmation } from './DialogueConfirmation';
import { Erreur, messageDe } from './Erreur';
import { IconePoubelle } from './Icones';
import { t } from '../i18n';

function horodatage(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
}

/** Longueur maximale d'un message, alignée sur le schéma du serveur. */
const LONGUEUR_MAX = 8000;

/**
 * Fusionne la première page relue (les plus récents) dans les messages déjà affichés, par `id`.
 * Les messages plus anciens que la page, chargés par « Charger les messages précédents », sont conservés ;
 * ceux que la page couvre sont remplacés par elle, ce qui retire aussi un message supprimé entre-temps.
 */
function fusionner(
  courants: readonly Message[],
  page: readonly Message[],
  pageSuivante: string | null,
): { messages: Message[]; ancienConserve: boolean } {
  const debutPage = page[0];
  if (debutPage === undefined) return { messages: [...page], ancienConserve: false };

  // Trou d'historique : après une longue coupure, il a pu se poster plus de messages que n'en tient
  // une page. Ce qui est encore affiché est alors séparé de la page relue par des messages que
  // « Charger les précédents » ne pourrait plus atteindre, puisqu'on garderait l'ancien curseur.
  // On le reconnaît à l'absence totale de recouvrement : on repart alors de la page et de SON curseur.
  const seRecouvrent = courants.some((m) => page.some((p) => p.id === m.id));
  if (!seRecouvrent && pageSuivante !== null && courants.length > 0) {
    return { messages: [...page], ancienConserve: false };
  }

  const anciens = courants.filter(
    (m) => Date.parse(m.created_at) < Date.parse(debutPage.created_at) && !page.some((p) => p.id === m.id),
  );
  return { messages: [...anciens, ...page], ancienConserve: anciens.length > 0 };
}

/**
 * Fil de discussion réutilisable (fil libre ou fil d'événement), abonné au flux temps réel du groupe.
 * À monter avec une `key` propre au couple groupe / fil : l'état n'est pas réinitialisé si les propriétés changent.
 */
export function FilDiscussion({ groupId, filId }: { groupId: string; filId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [suivant, setSuivant] = useState<string | null>(null);
  const [monMembreId, setMonMembreId] = useState<string | null>(null);
  const [admin, setAdmin] = useState(false);
  const [nouveau, setNouveau] = useState('');
  const [editionId, setEditionId] = useState<string | null>(null);
  const [editionCorps, setEditionCorps] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [pret, setPret] = useState(false);
  const [aSupprimer, setASupprimer] = useState<string | null>(null);
  const envoi = useSoumission();
  const edition = useSoumission();
  const suppression = useSoumission();
  // Les messages courants, lisibles par la fusion sans la rendre dépendante d'un rendu précis.
  const courants = useRef<readonly Message[]>(messages);
  courants.current = messages;

  // Les messages sont rechargés (regroupés, réponses obsolètes ignorées) ; le groupe, lui, n'est lu qu'une fois.
  const { recharger, planifier } = useRechargement(
    () => listerMessages(groupId, filId),
    (page) => {
      const { messages: fusionnes, ancienConserve } = fusionner(courants.current, page.messages, page.suivant);
      setMessages(fusionnes);
      // Tant que de l'historique ancien est affiché, c'est SON curseur qui fait foi : la relecture ne remet pas la pagination au début.
      if (!ancienConserve) setSuivant(page.suivant);
      setPret(true);
    },
    (err) => setErreur(messageDe(err)),
  );

  useEffect(() => {
    recharger();
  }, [recharger]);

  useEffect(() => {
    let abandonne = false;
    lireGroupe(groupId)
      .then((groupe) => {
        if (abandonne) return;
        setMonMembreId(groupe.mon_appartenance_id);
        setAdmin(groupe.mon_role === 'admin');
      })
      .catch((err: unknown) => {
        if (!abandonne) setErreur(messageDe(err));
      });
    return () => {
      abandonne = true;
    };
  }, [groupId]);

  useTempsReel(groupId, {
    onOuvert: recharger,
    onEvenement: (e) => {
      if (e.ressource === 'message' && e.parent_id === filId) {
        // Une suppression se traite ICI, localement : un message sorti de la première page n'est
        // plus jamais relu, donc la relecture seule ne le ferait jamais disparaître de l'écran.
        if (e.type === 'message.supprime') setMessages((liste) => liste.filter((m) => m.id !== e.id));
        planifier();
      }
    },
  });

  const chargerPrecedents = (): void => {
    if (suivant === null) return;
    setErreur(null);
    listerMessages(groupId, filId, suivant)
      .then((page) => {
        setMessages((courants) => [...page.messages, ...courants]);
        setSuivant(page.suivant);
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const envoyer = (e: FormEvent): void => {
    e.preventDefault();
    if (nouveau.trim() === '') return;
    setErreur(null);
    envoi
      .lancer(() =>
        posterMessage(groupId, filId, nouveau.trim()).then((m) => {
          setMessages((deja) => (deja.some((c) => c.id === m.id) ? deja : [...deja, m]));
          setNouveau('');
        }),
      )
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const enregistrerEdition = (e: FormEvent): void => {
    e.preventDefault();
    if (editionId === null || editionCorps.trim() === '') return;
    setErreur(null);
    edition
      .lancer(() =>
        modifierMessage(groupId, filId, editionId, editionCorps.trim()).then((modifie) => {
          setMessages((deja) => deja.map((m) => (m.id === modifie.id ? modifie : m)));
          setEditionId(null);
          setEditionCorps('');
        }),
      )
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const supprimer = (messageId: string): void => {
    setErreur(null);
    suppression
      .lancer(() =>
        supprimerMessage(groupId, filId, messageId).then(() => {
          setMessages((deja) => deja.filter((m) => m.id !== messageId));
        }),
      )
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  return (
    <div className="fil-discussion">
      <Erreur message={erreur} />
      {suivant !== null && (
        <div className="fil-precedents">
          <button type="button" className="bouton-compact" onClick={chargerPrecedents}>
            {t('fil.charger_precedents')}
          </button>
        </div>
      )}
      {!pret ? (
        erreur === null && <p className="discret">{t('commun.chargement')}</p>
      ) : messages.length === 0 ? (
        <p className="discret">{t('fil.aucun_message')}</p>
      ) : (
        <ul className="fil-messages" role="log" aria-live="polite" aria-relevant="additions">
          {messages.map((m) => {
            const peutGerer = admin || m.author_membership_id === monMembreId;
            const estMien = monMembreId !== null && m.author_membership_id === monMembreId;
            return (
              <li key={m.id} className={`fil-message${estMien ? ' fil-message-mien' : ''}`}>
                <div className="fil-message-entete">
                  <strong className="fil-message-auteur">{m.author_name}</strong>
                  <span className="fil-message-heure">
                    {horodatage(m.created_at)}
                    {m.edited_at !== null && ` ${t('fil.modifie')}`}
                  </span>
                </div>
                {editionId === m.id ? (
                  <form onSubmit={enregistrerEdition} className="formulaire">
                    <textarea value={editionCorps} aria-label={t('fil.modifier')} maxLength={LONGUEUR_MAX} onChange={(e) => setEditionCorps(e.target.value)} required />
                    <div className="barre-compacte">
                      <button type="submit" className="bouton-compact" disabled={edition.enCours}>
                        {edition.enCours ? t('commun.enregistrement') : t('fil.enregistrer')}
                      </button>
                      <button type="button" className="bouton-compact" onClick={() => setEditionId(null)}>
                        {t('commun.annuler')}
                      </button>
                    </div>
                  </form>
                ) : (
                  <p className="fil-message-corps">{m.body}</p>
                )}
                {peutGerer && editionId !== m.id && (
                  <div className="fil-message-actions">
                    <button
                      type="button"
                      className="bouton-lien"
                      onClick={() => {
                        setEditionId(m.id);
                        setEditionCorps(m.body);
                      }}
                    >
                      {t('fil.modifier')}
                    </button>
                    <button
                      type="button"
                      className="bouton-icone-discret"
                      aria-label={`${t('fil.supprimer')} ${m.author_name}`}
                      disabled={suppression.enCours}
                      onClick={() => setASupprimer(m.id)}
                    >
                      <IconePoubelle className="icone-mini" />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <form onSubmit={envoyer} className="fil-compositeur">
        <textarea
          value={nouveau}
          rows={2}
          maxLength={LONGUEUR_MAX}
          aria-label={t('fil.nouveau_message')}
          placeholder={t('fil.nouveau_message')}
          onChange={(e) => setNouveau(e.target.value)}
          required
        />
        <button type="submit" disabled={nouveau.trim() === '' || envoi.enCours}>
          {envoi.enCours ? t('commun.envoi') : t('fil.envoyer')}
        </button>
      </form>
      <DialogueConfirmation
        ouvert={aSupprimer !== null}
        titre={t('confirm.fil.supprimer.titre')}
        consequence={t('confirm.fil.supprimer.consequence')}
        reversible={false}
        libelleConfirmer={t('confirm.fil.supprimer.action')}
        danger
        onConfirmer={() => {
          const cible = aSupprimer;
          setASupprimer(null);
          if (cible !== null) supprimer(cible);
        }}
        onAnnuler={() => setASupprimer(null)}
      />
    </div>
  );
}
