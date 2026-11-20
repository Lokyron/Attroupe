import { useState } from 'react';
import type { GroupeResume } from '../api/groupes';
import {
  definirPreferenceNotification,
  listerPreferencesNotifications,
  reprendreReglageGlobal,
  type PreferenceNotification,
} from '../api/notifications';
import { useLecture } from '../hooks/useLecture';
import { useSoumission } from '../hooks/useSoumission';
import { t } from '../i18n';
import {
  basculerGenre,
  preferenceEffective,
  THEMES_NOTIFICATION,
  type ChangementPreference,
  type EmailMode,
  type GenreNotification,
  type PreferenceEffective,
} from '../lib/preferences-notifications';
import { Erreur, messageDe } from './Erreur';

const MODES: readonly EmailMode[] = ['immediate', 'daily', 'off'];

interface ReglageProps {
  /** `'*'` pour le réglage global, sinon l'identifiant du groupe. */
  portee: string;
  titre: string;
  effective: PreferenceEffective;
  occupe: boolean;
  onChange: (portee: string, titre: string, changement: ChangementPreference) => void;
  /** Rend le groupe au réglage global : supprime sa ligne (les champs ne sont pas recopiés, ils redeviennent hérités). */
  onReprendre: (portee: string, titre: string) => void;
}

/** Un niveau de réglage (global ou d'un groupe) : mode e-mail + une case par genre de notification. */
function Reglage({ portee, titre, effective, occupe, onChange, onReprendre }: ReglageProps) {
  const estGlobal = portee === '*';
  const champsPropres = [effective.mode_propre ? t('notifications.champ_mode') : null, effective.genres_propres ? t('notifications.champ_genres') : null]
    .filter((c): c is string => c !== null)
    .join(t('notifications.champs_et'));
  const nomMode = `pref-mode-${portee}`;

  return (
    <fieldset className="champ-participants" aria-busy={occupe}>
      <legend>{estGlobal ? t('notifications.global_titre') : titre}</legend>
      <p className="texte-doux">
        {estGlobal
          ? t('notifications.global_aide')
          : effective.suit_global
            ? t('notifications.groupe_suit_global')
            : t('notifications.groupe_propre', { champs: champsPropres })}
      </p>
      {!estGlobal && !effective.suit_global && (
        <p className="barre-compacte">
          <button type="button" className="bouton-compact" disabled={occupe} onClick={() => onReprendre(portee, titre)}>
            {t('notifications.reprendre_global')}
          </button>
        </p>
      )}
      <label className="ligne-case" htmlFor={nomMode}>
        {t('notifications.mode_label')}
        <select
          id={nomMode}
          value={effective.email_mode}
          disabled={occupe}
          onChange={(e) => {
            const mode = MODES.find((m) => m === e.target.value);
            if (mode !== undefined) onChange(portee, titre, { email_mode: mode });
          }}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {t(`notifications.mode_${m}`)}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="champ-participants">
        <legend>{t('notifications.genres_titre')}</legend>
        <p className="texte-doux">{t('notifications.genres_aide')}</p>
        {THEMES_NOTIFICATION.map((theme) => (
          <div key={theme.cle}>
            <p className="sous-titre-compact">{t(`notifications.theme_${theme.cle}`)}</p>
            {theme.genres.map((genre: GenreNotification) => (
              <label key={genre} className="ligne-case">
                <input
                  type="checkbox"
                  checked={!effective.muted_kinds.includes(genre)}
                  disabled={occupe}
                  onChange={(e) =>
                    onChange(portee, titre, { muted_kinds: basculerGenre(effective.muted_kinds, genre, !e.target.checked) })
                  }
                />
                {t(`notifications.genre_${genre}`)}
              </label>
            ))}
          </div>
        ))}
      </fieldset>
    </fieldset>
  );
}

/**
 * Réglage des notifications : mode e-mail et genres reçus, au niveau global puis par groupe. Un groupe ne surcharge que les champs qu'il
 * a lui-même réglés ; les autres suivent le réglage global (état réel côté serveur : colonnes à NULL). « Reprendre le réglage global »
 * supprime la ligne du groupe au lieu d'y recopier les valeurs globales.
 */
export function PreferencesNotifications({ groupes }: { groupes: GroupeResume[] }) {
  const { donnees, etat, erreur, recharger } = useLecture(listerPreferencesNotifications, []);
  // Dernière liste renvoyée par une écriture : elle prime sur la lecture initiale.
  const [ecrites, setEcrites] = useState<PreferenceNotification[] | null>(null);
  const [erreurEcriture, setErreurEcriture] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const { enCours, lancer } = useSoumission();

  const enregistrer = (portee: string, titre: string, changement: ChangementPreference): void => {
    setErreurEcriture(null);
    setConfirmation('');
    lancer(() => definirPreferenceNotification(portee, changement))
      .then((prefs) => {
        if (prefs === undefined) return;
        setEcrites(prefs);
        setConfirmation(t('notifications.enregistre', { portee: portee === '*' ? t('notifications.global_titre') : titre }));
      })
      .catch((err: unknown) => setErreurEcriture(messageDe(err)));
  };

  const reprendre = (portee: string, titre: string): void => {
    setErreurEcriture(null);
    setConfirmation('');
    lancer(() => reprendreReglageGlobal(portee))
      .then((prefs) => {
        if (prefs === undefined) return;
        setEcrites(prefs);
        setConfirmation(t('notifications.enregistre', { portee: titre }));
      })
      .catch((err: unknown) => setErreurEcriture(messageDe(err)));
  };

  const preferences = ecrites ?? donnees;
  const globale = preferences === null ? null : preferenceEffective(preferences, '*');

  return (
    <section aria-labelledby="preferences-notifications-titre" className="page-pile">
      <h3 id="preferences-notifications-titre">{t('notifications.preferences_titre')}</h3>
      <p className="texte-doux">{t('notifications.hierarchie')}</p>
      {etat === 'chargement' && <p>{t('commun.chargement')}</p>}
      {etat === 'erreur' && <Erreur message={erreur} onReessayer={recharger} />}
      <Erreur message={erreurEcriture} />
      <p role="status" className="texte-doux">
        {confirmation}
      </p>
      {preferences !== null && globale !== null && (
        <div className="formulaire">
          <Reglage portee="*" titre="" effective={globale} occupe={enCours} onChange={enregistrer} onReprendre={reprendre} />
          {groupes.map((g) => (
            <Reglage
              key={g.group_id}
              portee={g.group_id}
              titre={g.name}
              effective={preferenceEffective(preferences, g.group_id)}
              occupe={enCours}
              onChange={enregistrer}
              onReprendre={reprendre}
            />
          ))}
        </div>
      )}
    </section>
  );
}
