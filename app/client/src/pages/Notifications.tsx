import { useCallback, useEffect, useRef, useState } from 'react';
import { listerInvitationsRecues, type GroupeResume, type InvitationRecue } from '../api/groupes';
import {
  listerNotifications,
  marquerNotificationsLues,
  type FiltreNotifications,
  type Notification,
} from '../api/notifications';
import { CarteNotificationsPush } from '../components/CarteNotificationsPush';
import { Erreur, messageDe } from '../components/Erreur';
import { PreferencesNotifications } from '../components/PreferencesNotifications';
import { ReponseInvitation } from '../components/ReponseInvitation';
import { t } from '../i18n';
import { cleStatutInvitation, detailInvitation, invitationActionnable, invitationsSansNotification } from '../lib/notifications-vue';

const TAILLE_PAGE = 20;
const FILTRES: readonly FiltreNotifications[] = ['non_lues', 'toutes'];

function horodatage(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

function lienNotification(n: Notification): string | null {
  if (n.group_id === null) return null;
  const g = encodeURIComponent(n.group_id);
  const eventId = typeof n.payload['event_id'] === 'string' ? n.payload['event_id'] : null;
  if (eventId !== null) return `#/groupe/${g}/evenement/${encodeURIComponent(eventId)}`;
  const threadId = typeof n.payload['thread_id'] === 'string' ? n.payload['thread_id'] : null;
  if (threadId !== null) return `#/groupe/${g}/fil/${encodeURIComponent(threadId)}`;
  return `#/groupe/${g}`;
}

/**
 * Notifications : l'historique complet (filtre « Non lues » / « Toutes », pages de 20 accumulées à la demande par curseur) et les invitations
 * en attente, qui s'y répondent sur place. `onChange` relit le badge ; `onInvitationRepondue` relit aussi `moi` (groupes, invitations).
 */
export function Notifications({
  groupes,
  onChange,
  onInvitationRepondue,
}: {
  groupes: GroupeResume[];
  onChange?: () => void;
  onInvitationRepondue?: () => void;
}) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [invitations, setInvitations] = useState<InvitationRecue[]>([]);
  const [nonLues, setNonLues] = useState(0);
  const [aSuite, setASuite] = useState(false);
  const [filtre, setFiltre] = useState<FiltreNotifications>('non_lues');
  // Curseur de la page suivante (`null` : aucune) et indicateur de chargement du « Voir plus ».
  const [curseur, setCurseur] = useState<string | null>(null);
  const [chargementSuite, setChargementSuite] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  // Une réponse tardive (filtre changé entre-temps) ne doit pas remplacer la liste affichée.
  const generation = useRef(0);

  const charger = useCallback((): void => {
    generation.current += 1;
    const numero = generation.current;
    setErreur(null);
    setChargementSuite(false);
    // Toujours la première page : les suivantes s'ajoutent à la demande (`voirPlus`), sans jamais grossir la taille de page.
    Promise.all([listerNotifications(filtre, TAILLE_PAGE), listerInvitationsRecues()])
      .then(([notifs, recues]) => {
        if (numero !== generation.current) return;
        setNotifications(notifs.notifications);
        setNonLues(notifs.non_lues);
        setASuite(notifs.a_suite);
        setCurseur(notifs.curseur_suivant);
        setInvitations(recues);
      })
      .catch((err: unknown) => {
        if (numero === generation.current) setErreur(messageDe(err));
      });
  }, [filtre]);

  useEffect(charger, [charger]);

  const choisirFiltre = (f: FiltreNotifications): void => {
    setFiltre(f);
  };

  // Page suivante : accumulée à la suite des précédentes, repérée par le curseur (created_at, id) de la dernière ligne reçue.
  const voirPlus = (): void => {
    if (curseur === null || chargementSuite) return;
    const numero = generation.current;
    setErreur(null);
    setChargementSuite(true);
    listerNotifications(filtre, TAILLE_PAGE, curseur)
      .then((page) => {
        if (numero !== generation.current) return;
        // Forme fonctionnelle : une ligne marquée lue pendant le chargement ne doit pas être écrasée par une liste périmée.
        setNotifications((courantes) => {
          const connues = new Set(courantes.map((n) => n.id));
          return [...courantes, ...page.notifications.filter((n) => !connues.has(n.id))];
        });
        setNonLues(page.non_lues);
        setASuite(page.a_suite);
        setCurseur(page.curseur_suivant);
        setChargementSuite(false);
      })
      .catch((err: unknown) => {
        if (numero !== generation.current) return;
        setChargementSuite(false);
        setErreur(messageDe(err));
      });
  };

  const apresLecture = (): void => {
    charger();
    onChange?.();
  };

  const toutMarquerLu = (): void => {
    setErreur(null);
    marquerNotificationsLues()
      .then(apresLecture)
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const marquerUneLue = (id: string): void => {
    setErreur(null);
    marquerNotificationsLues([id])
      .then(() => {
        // Mise à jour sur place : relire la première page renverrait en haut d'une liste déjà dépliée.
        setNotifications((courantes) =>
          filtre === 'non_lues' ? courantes.filter((n) => n.id !== id) : courantes.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)),
        );
        setNonLues((n) => Math.max(0, n - 1));
        onChange?.();
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const apresReponse = (): void => {
    charger();
    onChange?.();
    onInvitationRepondue?.();
  };

  const enAttente = invitationsSansNotification(invitations, notifications);

  return (
    <section className="page-pile">
      <h2>{t('notifications.titre')}</h2>
      <CarteNotificationsPush />
      <Erreur message={erreur} />

      {enAttente.length > 0 && (
        <section aria-labelledby="notifications-invitations">
          <h3 id="notifications-invitations">{t('notifications.invitations_titre')}</h3>
          <ul className="liste-notifications">
            {enAttente.map((i) => (
              <li key={i.id} className="notification-ligne non-lue">
                <span className="notification-texte">
                  {t('invitations_recues.texte', {
                    invitant: i.invited_by_name,
                    groupe: i.group_name,
                    role: t(i.role === 'admin' ? 'membres.role_admin' : 'membres.role_member'),
                  })}
                  {i.message !== null && <blockquote>{i.message}</blockquote>}
                </span>
                <span className="notification-actions">
                  <ReponseInvitation invitationId={i.id} groupe={i.group_name} onRepondu={apresReponse} onErreur={setErreur} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="barre-compacte">
        <div role="group" aria-label={t('notifications.filtre_label')} className="groupe-pilules">
          {FILTRES.map((f) => (
            <button
              key={f}
              type="button"
              className="pilule-nav"
              aria-pressed={filtre === f}
              onClick={() => choisirFiltre(f)}
            >
              {t(f === 'non_lues' ? 'notifications.filtre_non_lues' : 'notifications.filtre_toutes')}
            </button>
          ))}
        </div>
        {nonLues > 0 && (
          <button type="button" className="bouton-compact" onClick={toutMarquerLu}>
            {t('notifications.tout_marquer_lu')}
          </button>
        )}
      </div>

      {notifications.length === 0 ? (
        enAttente.length === 0 && <p>{t(filtre === 'non_lues' ? 'notifications.aucune_non_lue' : 'notifications.aucune')}</p>
      ) : (
        <>
          <ul className="liste-notifications">
            {notifications.map((n) => {
              const lien = lienNotification(n);
              const lue = n.read_at !== null;
              const invitationId = invitationActionnable(n);
              const cleStatut = cleStatutInvitation(n);
              const detail = detailInvitation(n);
              const nomGroupe = typeof n.payload['group_name'] === 'string' ? n.payload['group_name'] : (n.group_name ?? t('notifications.groupe_inconnu'));
              return (
                <li key={n.id} className={`notification-ligne${lue ? '' : ' non-lue'}`}>
                  <span className="notification-texte">
                    {!lue && <span className="visuellement-cache">{t('notifications.non_lue')}{t('commun.separateur_tiret')}</span>}
                    {n.kind === 'invitation_received'
                      ? detail !== null
                        ? t('notifications.invitation_detail', {
                            invitant: detail.invitant,
                            groupe: detail.groupe,
                            role: t(detail.role === 'admin' ? 'membres.role_admin' : 'membres.role_member'),
                          })
                        : t('notifications.invitation_generique')
                      : t('notifications.ligne_sans_date', { groupe: n.group_name ?? t('notifications.groupe_inconnu') })}
                    {t('commun.separateur_tiret')}
                    <time dateTime={n.created_at}>{horodatage(n.created_at)}</time>
                    {cleStatut !== null && <span className="pilule notification-statut">{t(cleStatut)}</span>}
                  </span>
                  <span className="notification-actions">
                    {invitationId !== null && (
                      <ReponseInvitation invitationId={invitationId} groupe={nomGroupe} onRepondu={apresReponse} onErreur={setErreur} />
                    )}
                    {lien !== null && <a href={lien}>{t('notifications.ouvrir')}</a>}
                    {!lue && (
                      <button type="button" className="bouton-compact" onClick={() => marquerUneLue(n.id)}>
                        {t('notifications.marquer_lue')}
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {aSuite && (
            <p className="barre-compacte">
              <button type="button" className="bouton-compact" disabled={chargementSuite} onClick={voirPlus}>
                {t('notifications.voir_plus_suite')}
              </button>
            </p>
          )}
        </>
      )}

      <PreferencesNotifications groupes={groupes} />
    </section>
  );
}
