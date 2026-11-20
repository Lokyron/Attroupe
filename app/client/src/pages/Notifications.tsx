import { useCallback, useEffect, useState } from 'react';
import type { GroupeResume } from '../api/groupes';
import {
  listerNotifications,
  marquerNotificationsLues,
  type Notification,
} from '../api/notifications';
import { CarteNotificationsPush } from '../components/CarteNotificationsPush';
import { Erreur, messageDe } from '../components/Erreur';
import { PreferencesNotifications } from '../components/PreferencesNotifications';
import { t } from '../i18n';

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

export function Notifications({ groupes, onChange }: { groupes: GroupeResume[]; onChange?: () => void }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [nonLues, setNonLues] = useState(0);
  const [limite, setLimite] = useState(20);
  const [erreur, setErreur] = useState<string | null>(null);

  const charger = useCallback((): void => {
    setErreur(null);
    listerNotifications()
      .then((notifs) => {
        setNotifications(notifs.notifications);
        setNonLues(notifs.non_lues);
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  }, []);

  useEffect(charger, [charger]);

  const toutMarquerLu = (): void => {
    setErreur(null);
    marquerNotificationsLues()
      .then(() => {
        charger();
        onChange?.();
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const marquerUneLue = (id: string): void => {
    setErreur(null);
    marquerNotificationsLues([id])
      .then(() => {
        charger();
        onChange?.();
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  return (
    <section className="page-pile">
      <h2>{t('notifications.titre')}</h2>
      <CarteNotificationsPush />
      <Erreur message={erreur} />
      {nonLues > 0 && (
        <p>
          <button type="button" onClick={toutMarquerLu}>
            {t('notifications.tout_marquer_lu')}
          </button>
        </p>
      )}
      {notifications.length === 0 ? (
        <p>{t('notifications.aucune')}</p>
      ) : (
        <>
          <ul>
            {notifications.slice(0, limite).map((n) => {
              const lien = lienNotification(n);
              const lue = n.read_at !== null;
              return (
                <li key={n.id}>
                  <span>
                    {t('notifications.ligne_sans_date', {
                      marque: lue ? '' : '● ',
                      groupe: n.group_name ?? t('notifications.groupe_inconnu'),
                    })}
                    {t('commun.separateur_tiret')}
                    <time dateTime={n.created_at}>{horodatage(n.created_at)}</time>
                  </span>
                  {lien !== null && (
                    <>
                      {' '}
                      <a href={lien}>{t('notifications.ouvrir')}</a>
                    </>
                  )}
                  {!lue && (
                    <>
                      {' '}
                      <button type="button" onClick={() => marquerUneLue(n.id)}>
                        {t('notifications.marquer_lue')}
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {notifications.length > limite && (
            <p className="barre-compacte">
              <button type="button" className="bouton-compact" onClick={() => setLimite((n) => n + 20)}>
                {t('notifications.voir_plus', { reste: String(notifications.length - limite) })}
              </button>
            </p>
          )}
        </>
      )}

      <PreferencesNotifications groupes={groupes} />
    </section>
  );
}
