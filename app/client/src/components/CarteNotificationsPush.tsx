import { useCallback, useEffect, useState } from 'react';
import { ErreurApi, ErreurLocale } from '../api/client';
import { useSoumission } from '../hooks/useSoumission';
import {
  enregistrerAbonnementPush,
  lireClePush,
  supprimerAbonnementPush,
  testerNotificationPush,
} from '../api/notifications';
import { t } from '../i18n';
import { Erreur, messageDe } from './Erreur';

type EtatPush = 'chargement' | 'non_supporte' | 'https_requis' | 'bloquee' | 'inactive' | 'active';

function base64UrlVersUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const binaire = window.atob(base64);
  const tampon = new ArrayBuffer(binaire.length);
  const octets = new Uint8Array(tampon);
  for (let i = 0; i < binaire.length; i += 1) {
    octets[i] = binaire.charCodeAt(i);
  }
  return octets;
}

function arrayBufferVersBase64Url(tampon: ArrayBuffer | null): string {
  if (tampon === null) return '';
  const octets = new Uint8Array(tampon);
  let binaire = '';
  for (let i = 0; i < octets.length; i += 1) {
    binaire += String.fromCharCode(octets[i] ?? 0);
  }
  return window.btoa(binaire).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function supportPushNavigateur(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Carte réutilisable pour activer, tester et désactiver les notifications Push Web sur l'appareil courant. */
export function CarteNotificationsPush() {
  const [etat, setEtat] = useState<EtatPush>('chargement');
  const [abonnement, setAbonnement] = useState<PushSubscription | null>(null);
  const [nbAppareils, setNbAppareils] = useState<number | null>(null);
  const activation = useSoumission();
  const desactivation = useSoumission();
  const test = useSoumission();
  const enCours = activation.enCours || desactivation.enCours || test.enCours;
  const [info, setInfo] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const verifierEtat = useCallback(async (): Promise<void> => {
    if (!supportPushNavigateur()) {
      setEtat('non_supporte');
      return;
    }
    if (!window.isSecureContext) {
      setEtat('https_requis');
      return;
    }
    if (Notification.permission === 'denied') {
      setEtat('bloquee');
      return;
    }

    try {
      const [cle, registration] = await Promise.all([
        lireClePush().catch((err: unknown) => {
          console.error('Push : lecture de la clé publique impossible', err);
          return null;
        }),
        navigator.serviceWorker.getRegistration(),
      ]);
      if (cle !== null) setNbAppareils(cle.nb_appareils);
      const sub = registration !== undefined ? await registration.pushManager.getSubscription() : null;
      setAbonnement(sub);
      setEtat(sub !== null && Notification.permission === 'granted' ? 'active' : 'inactive');
    } catch (err: unknown) {
      // Service worker absent ou injoignable : on journalise, sinon le bouton d'activation échouerait sans explication.
      console.error('Push : état de l\'abonnement illisible', err);
      setEtat('inactive');
    }
  }, []);

  // Le compteur est secondaire : son échec est journalisé mais ne remet pas en cause l'action qui vient de réussir.
  const rafraichirNbAppareils = async (): Promise<void> => {
    try {
      const cle = await lireClePush();
      setNbAppareils(cle.nb_appareils);
    } catch (err: unknown) {
      console.error('Push : nombre d\'appareils illisible', err);
    }
  };

  useEffect(() => {
    void verifierEtat();
  }, [verifierEtat]);

  const activer = (): void => {
    setErreur(null);
    setInfo(null);
    activation
      .lancer(async () => {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          setEtat(permission === 'denied' ? 'bloquee' : 'inactive');
          setErreur(t('push.permission_refusee'));
          return;
        }

        const registration = await navigator.serviceWorker.ready;
        const { cle_publique } = await lireClePush();
        const applicationServerKey = base64UrlVersUint8Array(cle_publique);

        const existant = await registration.pushManager.getSubscription();
        const sub =
          existant ??
          (await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey,
          }));

        const json = sub.toJSON();
        const p256dh = json.keys?.['p256dh'] ?? arrayBufferVersBase64Url(sub.getKey('p256dh'));
        const auth = json.keys?.['auth'] ?? arrayBufferVersBase64Url(sub.getKey('auth'));
        if (p256dh === '' || auth === '') {
          throw new Error(t('push.erreur_abonnement'));
        }

        await enregistrerAbonnementPush({
          endpoint: sub.endpoint,
          keys: { p256dh, auth },
        });

        setAbonnement(sub);
        setEtat('active');
        setInfo(t('push.activee'));
        await rafraichirNbAppareils();
      })
      .catch((err: unknown) => {
        console.error('Push : activation impossible', err);
        // `messageDe` ne connaît que les erreurs de l'API : toute autre erreur (navigateur, clés vides) reçoit le message générique.
        setErreur(err instanceof ErreurApi || err instanceof ErreurLocale ? messageDe(err) : t('push.erreur_abonnement'));
      });
  };

  const tester = (): void => {
    setErreur(null);
    setInfo(null);
    test
      .lancer(async () => {
        const res = await testerNotificationPush();
        if (res.appareils > 0) {
          setInfo(t('push.test_demande', { n: String(res.appareils) }));
        } else {
          setErreur(t('push.test_aucun_appareil'));
        }
      })
      .catch((err: unknown) => {
        console.error('Push : notification de test impossible', err);
        setErreur(messageDe(err));
      });
  };

  // Le serveur d'abord : s'il échoue, rien n'a bougé et l'interface reste « Activées », ce qui est vrai. Dans l'ordre
  // inverse, l'abonnement du navigateur serait déjà perdu alors que l'interface annoncerait encore des notifications.
  const desactiver = (): void => {
    setErreur(null);
    setInfo(null);
    desactivation
      .lancer(async () => {
        await supprimerAbonnementPush(abonnement?.endpoint);
        // Le serveur n'enverra plus rien : l'état devient « inactif » même si le navigateur refuse de se désabonner.
        setAbonnement(null);
        setEtat('inactive');
        setInfo(t('push.desactivee'));
        if (abonnement !== null) {
          try {
            await abonnement.unsubscribe();
          } catch (err: unknown) {
            console.error('Push : désabonnement du navigateur impossible', err);
          }
        }
        await rafraichirNbAppareils();
      })
      .catch((err: unknown) => {
        console.error('Push : désactivation impossible', err);
        setErreur(messageDe(err));
      });
  };

  const libelleEtat = (() => {
    switch (etat) {
      case 'chargement':
        return t('commun.chargement');
      case 'active':
        return t('push.etat_active');
      case 'bloquee':
        return t('push.etat_bloquee');
      case 'https_requis':
        return t('push.etat_https_requis');
      case 'non_supporte':
        return t('push.etat_non_supporte');
      default:
        return t('push.etat_inactive');
    }
  })();

  const classePilule =
    etat === 'active'
      ? 'pilule pilule-positif'
      : etat === 'bloquee' || etat === 'https_requis'
        ? 'pilule pilule-negatif'
        : 'pilule';

  return (
    <div className="carte carte-push">
      <div className="carte-entete">
        <h3>{t('push.titre')}</h3>
        <span className={classePilule}>{libelleEtat}</span>
      </div>
      <p className="texte-doux">{t('push.description')}</p>
      {nbAppareils !== null && nbAppareils > 0 && (
        <p className="texte-doux">
          {t(nbAppareils <= 1 ? 'push.appareils_singulier' : 'push.appareils_pluriel', {
            n: String(nbAppareils),
          })}
        </p>
      )}
      <Erreur message={erreur} />
      {info !== null && (
        <p role="status" className="message-succes">
          {info}
        </p>
      )}
      <div className="barre-compacte">
        {etat === 'inactive' && (
          <button type="button" className="bouton bouton-primaire" disabled={enCours} onClick={activer}>
            {t('push.activer')}
          </button>
        )}
        {etat === 'active' && (
          <>
            <button type="button" className="bouton bouton-primaire" disabled={enCours} onClick={tester}>
              {t('push.tester')}
            </button>
            <button
              type="button"
              className="bouton bouton-danger-discret"
              disabled={enCours}
              onClick={desactiver}
            >
              {t('push.desactiver')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
