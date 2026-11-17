import { useCallback, useEffect, useState } from 'react';
import type { GroupeResume } from '../api/groupes';
import {
  definirPreferenceNotification,
  listerNotifications,
  listerPreferencesNotifications,
  marquerNotificationsLues,
  type EmailMode,
  type Notification,
  type PreferenceNotification,
} from '../api/notifications';
import { CarteNotificationsPush } from '../components/CarteNotificationsPush';
import { Erreur, messageDe } from '../components/Erreur';
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
  const [preferences, setPreferences] = useState<PreferenceNotification[]>([]);
  const [erreur, setErreur] = useState<string | null>(null);

  const charger = useCallback((): void => {
    setErreur(null);
    Promise.all([listerNotifications(), listerPreferencesNotifications()])
      .then(([notifs, prefs]) => {
        setNotifications(notifs.notifications);
        setNonLues(notifs.non_lues);
        setPreferences(prefs);
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

  const changerPreference = (groupId: string, mode: EmailMode): void => {
    setErreur(null);
    definirPreferenceNotification(groupId, mode)
      .then(setPreferences)
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const modePour = (groupId: string): EmailMode => {
    return preferences.find((p) => p.group_id === groupId)?.email_mode ?? 'immediate';
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
        <ul>
          {notifications.map((n) => {
            const lien = lienNotification(n);
            const lue = n.read_at !== null;
            return (
              <li key={n.id}>
                <span>
                  {t('notifications.ligne', {
                    marque: lue ? '' : '● ',
                    groupe: n.group_name ?? t('notifications.groupe_inconnu'),
                    date: horodatage(n.created_at),
                  })}
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
      )}

      <h3>{t('notifications.preferences_titre')}</h3>
      <div className="formulaire">
        <label>
          {t('notifications.preference_globale')}
          <select value={modePour('*')} onChange={(e) => changerPreference('*', e.target.value as EmailMode)}>
            <option value="immediate">{t('notifications.mode_immediate')}</option>
            <option value="daily">{t('notifications.mode_daily')}</option>
            <option value="off">{t('notifications.mode_off')}</option>
          </select>
        </label>
        {groupes.map((g) => (
          <label key={g.group_id}>
            {g.name}
            <select value={modePour(g.group_id)} onChange={(e) => changerPreference(g.group_id, e.target.value as EmailMode)}>
              <option value="immediate">{t('notifications.mode_immediate')}</option>
              <option value="daily">{t('notifications.mode_daily')}</option>
              <option value="off">{t('notifications.mode_off')}</option>
            </select>
          </label>
        ))}
      </div>
    </section>
  );
}
