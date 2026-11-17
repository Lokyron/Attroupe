import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  listerMessages,
  modifierMessage,
  posterMessage,
  supprimerMessage,
  type Message,
} from '../api/fils';
import { lireGroupe } from '../api/groupes';
import { useTempsReel } from '../api/tempsReel';
import { Erreur, messageDe } from './Erreur';
import { IconePoubelle } from './Icones';
import { t } from '../i18n';

function horodatage(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
}

/** Fil de discussion réutilisable (fil libre ou fil d'événement), abonné au flux temps réel du groupe. */
export function FilDiscussion({ groupId, filId }: { groupId: string; filId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [suivant, setSuivant] = useState<string | null>(null);
  const [monMembreId, setMonMembreId] = useState<string | null>(null);
  const [admin, setAdmin] = useState(false);
  const [nouveau, setNouveau] = useState('');
  const [editionId, setEditionId] = useState<string | null>(null);
  const [editionCorps, setEditionCorps] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);

  const charger = useCallback((): void => {
    setErreur(null);
    Promise.all([listerMessages(groupId, filId), lireGroupe(groupId)])
      .then(([page, groupe]) => {
        setMessages(page.messages);
        setSuivant(page.suivant);
        setMonMembreId(groupe.mon_appartenance_id);
        setAdmin(groupe.mon_role === 'admin');
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  }, [groupId, filId]);

  useEffect(charger, [charger]);

  useTempsReel(groupId, {
    onOuvert: charger,
    onEvenement: (e) => {
      if (e.ressource === 'message' && e.parent_id === filId) {
        charger();
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
    posterMessage(groupId, filId, nouveau.trim())
      .then((m) => {
        setMessages((courants) => (courants.some((c) => c.id === m.id) ? courants : [...courants, m]));
        setNouveau('');
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const enregistrerEdition = (e: FormEvent): void => {
    e.preventDefault();
    if (editionId === null || editionCorps.trim() === '') return;
    setErreur(null);
    modifierMessage(groupId, filId, editionId, editionCorps.trim())
      .then((modifie) => {
        setMessages((courants) => courants.map((m) => (m.id === modifie.id ? modifie : m)));
        setEditionId(null);
        setEditionCorps('');
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const supprimer = (messageId: string): void => {
    if (!window.confirm(t('fil.supprimer_confirmation'))) return;
    setErreur(null);
    supprimerMessage(groupId, filId, messageId)
      .then(() => {
        setMessages((courants) => courants.filter((m) => m.id !== messageId));
      })
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
      {messages.length === 0 ? (
        <p className="discret">{t('fil.aucun_message')}</p>
      ) : (
        <ul className="fil-messages">
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
                    <textarea value={editionCorps} onChange={(e) => setEditionCorps(e.target.value)} required />
                    <div className="barre-compacte">
                      <button type="submit" className="bouton-compact">
                        {t('fil.enregistrer')}
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
                      aria-label={t('fil.supprimer')}
                      onClick={() => supprimer(m.id)}
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
          aria-label={t('fil.nouveau_message')}
          placeholder={t('fil.nouveau_message')}
          onChange={(e) => setNouveau(e.target.value)}
          required
        />
        <button type="submit" disabled={nouveau.trim() === ''}>
          {t('fil.envoyer')}
        </button>
      </form>
    </div>
  );
}
