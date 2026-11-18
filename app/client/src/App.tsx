import { useCallback, useEffect, useState } from 'react';
import { ErreurApi } from './api/client';
import { deconnecter, lireMoi, type Moi } from './api/groupes';
import { listerNotifications } from './api/notifications';
import { lireVersion, type InfoVersion } from './api/version';
import {
  IconeCalendrier,
  IconeCamera,
  IconeCloche,
  IconeDeconnexion,
  IconeEnveloppe,
  IconeGroupes,
  IconeListe,
  IconeMessage,
  IconePlus,
  IconeRecu,
  IconeSondage,
  IconeTableauDeBord,
  IconeUtilisateur,
} from './components/Icones';
import { Erreur, messageDe } from './components/Erreur';
import { t } from './i18n';
import { pageDuLien } from './lien';
import { Compte } from './pages/Compte';
import { Connexion } from './pages/Connexion';
import { Agenda } from './pages/Agenda';
import { Albums } from './pages/Albums';
import { Depenses } from './pages/Depenses';
import { Evenement, NouvelEvenement } from './pages/Evenement';
import { Exploitation } from './pages/Exploitation';
import { Fil } from './pages/Fil';
import { Fils } from './pages/Fils';
import { Groupe } from './pages/Groupe';
import { InvitationLien } from './pages/InvitationLien';
import { Reinitialisation } from './pages/Reinitialisation';
import { VerificationEmail } from './pages/VerificationEmail';
import { Liste } from './pages/Liste';
import { Listes } from './pages/Listes';
import { Invitations } from './pages/Invitations';
import { Notifications } from './pages/Notifications';
import { NouveauGroupe } from './pages/NouveauGroupe';
import { Sondage } from './pages/Sondage';
import { Sondages } from './pages/Sondages';
import { TableauDeBord } from './pages/TableauDeBord';

type Route =
  | { type: 'accueil' }
  | { type: 'nouveau' }
  | { type: 'invitations' }
  | { type: 'notifications' }
  | { type: 'compte' }
  | { type: 'exploitation' }
  | { type: 'groupe'; id: string }
  | { type: 'agenda'; id: string }
  | { type: 'listes'; id: string }
  | { type: 'liste'; id: string; listeId: string }
  | { type: 'sondages'; id: string }
  | { type: 'sondage'; id: string; sondageId: string }
  | { type: 'depenses'; id: string }
  | { type: 'fils'; id: string }
  | { type: 'fil'; id: string; filId: string }
  | { type: 'albums'; id: string }
  | { type: 'evenement'; id: string; evenementId: string }
  | { type: 'evenement-nouveau'; id: string };

type Etat = { type: 'chargement' } | { type: 'anonyme' } | { type: 'connecte'; moi: Moi } | { type: 'erreur'; message: string };

function lireRoute(): Route {
  const [, premier, second, troisieme, quatrieme] = window.location.hash.split('/');
  if (premier === 'nouveau') return { type: 'nouveau' };
  if (premier === 'invitations') return { type: 'invitations' };
  if (premier === 'notifications') return { type: 'notifications' };
  if (premier === 'compte') return { type: 'compte' };
  if (premier === 'exploitation') return { type: 'exploitation' };
  if (premier === 'groupe' && second !== undefined && second !== '') {
    const id = decodeURIComponent(second);
    if (troisieme === 'agenda') return { type: 'agenda', id };
    if (troisieme === 'listes') return { type: 'listes', id };
    if (troisieme === 'liste' && quatrieme !== undefined && quatrieme !== '') {
      return { type: 'liste', id, listeId: decodeURIComponent(quatrieme) };
    }
    if (troisieme === 'sondages') return { type: 'sondages', id };
    if (troisieme === 'sondage' && quatrieme !== undefined && quatrieme !== '') {
      return { type: 'sondage', id, sondageId: decodeURIComponent(quatrieme) };
    }
    if (troisieme === 'depenses') return { type: 'depenses', id };
    if (troisieme === 'fils') return { type: 'fils', id };
    if (troisieme === 'fil' && quatrieme !== undefined && quatrieme !== '') {
      return { type: 'fil', id, filId: decodeURIComponent(quatrieme) };
    }
    if (troisieme === 'albums') return { type: 'albums', id };
    if (troisieme === 'evenement-nouveau') return { type: 'evenement-nouveau', id };
    if (troisieme === 'evenement' && quatrieme !== undefined && quatrieme !== '') {
      return { type: 'evenement', id, evenementId: decodeURIComponent(quatrieme) };
    }
    return { type: 'groupe', id };
  }
  return { type: 'accueil' };
}

function aller(hash: string): void {
  window.location.hash = hash;
}

function initialesDe(nom: string): string {
  const morceaux = nom.trim().split(/\s+/).filter(Boolean);
  if (morceaux.length === 0) return '?';
  if (morceaux.length === 1) return (morceaux[0] ?? '?').slice(0, 2).toUpperCase();
  const premier = morceaux[0]?.[0] ?? '';
  const dernier = morceaux[morceaux.length - 1]?.[0] ?? '';
  return `${premier}${dernier}`.toUpperCase();
}

export function App() {
  const [etat, setEtat] = useState<Etat>({ type: 'chargement' });
  const [route, setRoute] = useState<Route>(lireRoute);
  const [nonLues, setNonLues] = useState(0);
  const [infoVersion, setInfoVersion] = useState<InfoVersion | null>(null);
  // Les pages à jeton se reconnaissent au CHEMIN, pas au fragment : le routeur, lui, route sur le hash.
  const lien = pageDuLien(window.location.pathname);

  const rafraichirNotifications = useCallback((): void => {
    listerNotifications()
      .then((r) => setNonLues(r.non_lues))
      .catch(() => undefined);
  }, []);

  const recharger = useCallback((): void => {
    // Depuis l'écran d'erreur, « Réessayer » repasse par le chargement ; ailleurs on ne démonte rien.
    setEtat((actuel): Etat => (actuel.type === 'erreur' ? { type: 'chargement' } : actuel));
    lireMoi()
      .then((moi) => {
        setEtat({ type: 'connecte', moi });
        rafraichirNotifications();
      })
      .catch((erreur: unknown) => {
        if (erreur instanceof ErreurApi && erreur.statut === 401) setEtat({ type: 'anonyme' });
        else {
          // Coupure réseau, 500, 502 pendant un redéploiement… : on ne reste pas sur « Chargement… ».
          console.error(erreur);
          // Mais `recharger` sert aussi APRÈS la connexion (photo de profil changée, groupe créé
          // ou quitté, invitation acceptée) : y basculer sur l'écran d'erreur démonterait tout
          // l'arbre connecté, et avec lui les formulaires en cours et l'adresse de flux iCal, qui
          // n'est affichée qu'une fois. Un utilisateur déjà connecté garde donc son écran.
          setEtat((actuel): Etat =>
            actuel.type === 'connecte'
              ? actuel
              : { type: 'erreur', message: navigator.onLine ? messageDe(erreur) : t('app.hors_ligne') },
          );
        }
      });
  }, [rafraichirNotifications]);

  useEffect(recharger, [recharger]);

  useEffect(() => {
    const surChangement = (): void => setRoute(lireRoute());
    window.addEventListener('hashchange', surChangement);
    return () => window.removeEventListener('hashchange', surChangement);
  }, []);

  useEffect(() => {
    lireVersion().then(setInfoVersion).catch(() => undefined);
  }, []);

  // Confirmation d'adresse et réinitialisation ne dépendent pas de la session : elles s'affichent seules,
  // sans attendre `lireMoi` et sans la coquille de l'application.
  if (lien === 'verification-email') return <VerificationEmail />;
  if (lien === 'reinitialisation') return <Reinitialisation />;

  if (etat.type === 'chargement') return <p className="accueil">{t('commun.chargement')}</p>;
  if (etat.type === 'erreur') {
    return (
      <div className="accueil">
        <Erreur message={etat.message} onReessayer={recharger} />
      </div>
    );
  }
  if (etat.type === 'anonyme') {
    return (
      <>
        {lien === 'invitation' && <InvitationLien connecte={false} onAcceptee={recharger} />}
        <Connexion onConnecte={recharger} />
      </>
    );
  }

  const { moi } = etat;
  const groupeCourant =
    route.type === 'groupe' ||
    route.type === 'agenda' ||
    route.type === 'listes' ||
    route.type === 'liste' ||
    route.type === 'sondages' ||
    route.type === 'sondage' ||
    route.type === 'depenses' ||
    route.type === 'fils' ||
    route.type === 'fil' ||
    route.type === 'albums' ||
    route.type === 'evenement' ||
    route.type === 'evenement-nouveau'
      ? route.id
      : '';

  const groupeActifObj = moi.groupes.find((g) => g.group_id === groupeCourant);
  const baseGroupe = groupeCourant !== '' ? `#/groupe/${encodeURIComponent(groupeCourant)}` : '';
  const initiales = initialesDe(moi.display_name);
  const libelleTousGroupes = t('nav.selecteur_tous', { n: String(moi.groupes.length) });
  const gererDeconnexion = (): void => {
    void deconnecter().then(() => setEtat({ type: 'anonyme' }));
  };

  return (
    <div className="coque-app">
      <aside className="barre-laterale" aria-label={t('nav.principale')}>
        <div className="barre-laterale-haut">
          <div className="barre-laterale-entete">
            <a href="#/" className="marque">
              <img src="/icons/logo.png" alt={''} className="marque-logo" aria-hidden="true" />
              <span>{t('app.nom')}</span>
            </a>
            <select
              className="selecteur-groupe"
              aria-label={t('nav.selecteur')}
              value={groupeCourant}
              onChange={(e) => aller(e.target.value === '' ? '#/' : `#/groupe/${encodeURIComponent(e.target.value)}`)}
            >
              <option value="">{libelleTousGroupes}</option>
              {moi.groupes.map((g) => (
                <option key={g.group_id} value={g.group_id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>

          <nav className="nav-laterale" aria-label={t('nav.principale')}>
            <a
              href="#/"
              className={`nav-laterale-lien${route.type === 'accueil' ? ' actif' : ''}`}
              aria-current={route.type === 'accueil' ? 'page' : undefined}
            >
              <IconeTableauDeBord className="nav-laterale-icone" />
              <span>{t('nav.tableau_de_bord')}</span>
            </a>
            <a
              href="#/nouveau"
              className={`nav-laterale-lien${route.type === 'nouveau' ? ' actif' : ''}`}
              aria-current={route.type === 'nouveau' ? 'page' : undefined}
            >
              <IconePlus className="nav-laterale-icone" />
              <span>{t('nav.nouveau_groupe')}</span>
            </a>
            <a
              href="#/invitations"
              className={`nav-laterale-lien${route.type === 'invitations' ? ' actif' : ''}`}
              aria-current={route.type === 'invitations' ? 'page' : undefined}
            >
              <IconeEnveloppe className="nav-laterale-icone" />
              <span>{t('nav.invitations')}</span>
              {moi.invitations_en_attente > 0 && (
                <span className="badge-alerte nav-laterale-badge">{moi.invitations_en_attente}</span>
              )}
            </a>
            <a
              href="#/notifications"
              className={`nav-laterale-lien${route.type === 'notifications' ? ' actif' : ''}`}
              aria-current={route.type === 'notifications' ? 'page' : undefined}
            >
              <IconeCloche className="nav-laterale-icone" />
              <span>{t('nav.notifications')}</span>
              {nonLues > 0 && <span className="badge-alerte nav-laterale-badge">{nonLues}</span>}
            </a>
            <a
              href="#/compte"
              className={`nav-laterale-lien${route.type === 'compte' ? ' actif' : ''}`}
              aria-current={route.type === 'compte' ? 'page' : undefined}
            >
              <IconeUtilisateur className="nav-laterale-icone" />
              <span>{t('nav.compte')}</span>
            </a>
          </nav>

          {groupeCourant !== '' && (
            <div className="bloc-groupe-actif">
              <p className="bloc-groupe-actif-titre">
                {groupeActifObj !== undefined ? groupeActifObj.name : t('nav.groupe_actif')}
              </p>
              <nav className="nav-laterale-groupe" aria-label={t('nav.groupe')}>
                <a
                  href={baseGroupe}
                  className={`nav-laterale-lien${route.type === 'groupe' ? ' actif' : ''}`}
                  aria-current={route.type === 'groupe' ? 'page' : undefined}
                >
                  <IconeGroupes className="nav-laterale-icone" />
                  <span>{t('nav.apercu')}</span>
                </a>
                <a
                  href={`${baseGroupe}/agenda`}
                  className={`nav-laterale-lien${route.type === 'agenda' || route.type === 'evenement' || route.type === 'evenement-nouveau' ? ' actif' : ''}`}
                  aria-current={route.type === 'agenda' ? 'page' : undefined}
                >
                  <IconeCalendrier className="nav-laterale-icone" />
                  <span>{t('tableau.raccourci_agenda')}</span>
                </a>
                <a
                  href={`${baseGroupe}/listes`}
                  className={`nav-laterale-lien${route.type === 'listes' || route.type === 'liste' ? ' actif' : ''}`}
                  aria-current={route.type === 'listes' ? 'page' : undefined}
                >
                  <IconeListe className="nav-laterale-icone" />
                  <span>{t('tableau.raccourci_listes')}</span>
                </a>
                <a
                  href={`${baseGroupe}/sondages`}
                  className={`nav-laterale-lien${route.type === 'sondages' || route.type === 'sondage' ? ' actif' : ''}`}
                  aria-current={route.type === 'sondages' ? 'page' : undefined}
                >
                  <IconeSondage className="nav-laterale-icone" />
                  <span>{t('nav.sondages')}</span>
                </a>
                <a
                  href={`${baseGroupe}/depenses`}
                  className={`nav-laterale-lien${route.type === 'depenses' ? ' actif' : ''}`}
                  aria-current={route.type === 'depenses' ? 'page' : undefined}
                >
                  <IconeRecu className="nav-laterale-icone" />
                  <span>{t('tableau.raccourci_depenses')}</span>
                </a>
                <a
                  href={`${baseGroupe}/fils`}
                  className={`nav-laterale-lien${route.type === 'fils' || route.type === 'fil' ? ' actif' : ''}`}
                  aria-current={route.type === 'fils' ? 'page' : undefined}
                >
                  <IconeMessage className="nav-laterale-icone" />
                  <span>{t('nav.fils')}</span>
                </a>
                <a
                  href={`${baseGroupe}/albums`}
                  className={`nav-laterale-lien${route.type === 'albums' ? ' actif' : ''}`}
                  aria-current={route.type === 'albums' ? 'page' : undefined}
                >
                  <IconeCamera className="nav-laterale-icone" />
                  <span>{t('tableau.raccourci_photos')}</span>
                </a>
              </nav>
            </div>
          )}
        </div>

        <div className="barre-laterale-pied">
          <a href="#/compte" className="barre-laterale-utilisateur">
            {moi.avatar_url !== null ? (
              <img src={moi.avatar_url} alt={t('avatar.alt', { nom: moi.display_name })} className="avatar-photo" />
            ) : (
              <span className="avatar-initiales" aria-hidden="true">
                {initiales}
              </span>
            )}
            <span className="barre-laterale-utilisateur-texte">
              <strong className="barre-laterale-utilisateur-nom">{moi.display_name}</strong>
              <span className="barre-laterale-utilisateur-pseudo">{t('nav.pseudo', { pseudo: moi.username })}</span>
            </span>
          </a>
          <button
            type="button"
            className="bouton-deconnexion-laterale"
            aria-label={t('nav.deconnexion')}
            onClick={gererDeconnexion}
          >
            <IconeDeconnexion className="nav-laterale-icone" />
            <span>{t('nav.deconnexion')}</span>
          </button>
        </div>
      </aside>

      <main className="contenu-principal">
        <header className="entete">
          <h1>
            <a href="#/" className="marque">
              <img src="/icons/logo.png" alt={''} className="marque-logo" aria-hidden="true" />
              <span className="marque-texte">{t('app.nom')}</span>
            </a>
          </h1>
          <select
            className="selecteur-groupe"
            aria-label={t('nav.selecteur')}
            value={groupeCourant}
            onChange={(e) => aller(e.target.value === '' ? '#/' : `#/groupe/${encodeURIComponent(e.target.value)}`)}
          >
            <option value="">{libelleTousGroupes}</option>
            {moi.groupes.map((g) => (
              <option key={g.group_id} value={g.group_id}>
                {g.name}
              </option>
            ))}
          </select>
          <div className="entete-actions-mobile">
            <a
              href="#/compte"
              className={moi.avatar_url !== null ? 'avatar-lien' : 'avatar-initiales avatar-lien'}
              aria-label={t('nav.compte')}
              title={moi.display_name}
            >
              {moi.avatar_url !== null ? (
                <img src={moi.avatar_url} alt={''} className="avatar-photo" aria-hidden="true" />
              ) : (
                initiales
              )}
            </a>
            <button
              type="button"
              className="bouton-deconnexion"
              aria-label={t('nav.deconnexion')}
              onClick={gererDeconnexion}
            >
              <IconeDeconnexion className="icone-bouton" />
              <span className="libelle-mobile-cache">{t('nav.quitter_mobile')}</span>
            </button>
          </div>
        </header>

        <div className="accueil">
          {lien === 'invitation' && <InvitationLien connecte onAcceptee={recharger} />}
          {!lien && route.type === 'accueil' && <TableauDeBord moi={moi} />}
          {!lien && route.type === 'nouveau' && (
            <NouveauGroupe
              onCree={(id) => {
                recharger();
                aller(`#/groupe/${encodeURIComponent(id)}`);
              }}
            />
          )}
          {!lien && route.type === 'invitations' && <Invitations onChange={recharger} />}
          {!lien && route.type === 'notifications' && (
            <Notifications groupes={moi.groupes} onChange={rafraichirNotifications} />
          )}
          {!lien && route.type === 'compte' && <Compte moi={moi} groupes={moi.groupes} onProfilChange={recharger} />}
          {!lien && route.type === 'exploitation' && <Exploitation serviceEmail={moi.service_email} />}
          {!lien && route.type === 'groupe' && (
            <Groupe
              key={route.id}
              groupId={route.id}
              onQuitte={() => {
                recharger();
                aller('#/');
              }}
            />
          )}
          {!lien && route.type === 'agenda' && <Agenda key={route.id} groupId={route.id} />}
          {!lien && route.type === 'listes' && <Listes key={route.id} groupId={route.id} />}
          {!lien && route.type === 'liste' && <Liste key={route.listeId} groupId={route.id} listeId={route.listeId} />}
          {!lien && route.type === 'sondages' && <Sondages key={route.id} groupId={route.id} />}
          {!lien && route.type === 'sondage' && (
            <Sondage key={route.sondageId} groupId={route.id} sondageId={route.sondageId} />
          )}
          {!lien && route.type === 'depenses' && <Depenses key={route.id} groupId={route.id} />}
          {!lien && route.type === 'fils' && <Fils key={route.id} groupId={route.id} />}
          {!lien && route.type === 'fil' && <Fil key={route.filId} groupId={route.id} filId={route.filId} />}
          {!lien && route.type === 'albums' && <Albums key={route.id} groupId={route.id} />}
          {!lien && route.type === 'evenement-nouveau' && <NouvelEvenement key={route.id} groupId={route.id} />}
          {!lien && route.type === 'evenement' && (
            <Evenement key={route.evenementId} groupId={route.id} evenementId={route.evenementId} />
          )}
          <footer className="pied">
            {infoVersion !== null && (
              <span>
                {t('exploitation.pied', {
                  tag: infoVersion.tag,
                  migration: infoVersion.migration ?? t('exploitation.aucune_migration'),
                })}
              </span>
            )}
            <a href="#/exploitation">{t('exploitation.lien')}</a>
          </footer>
        </div>
      </main>

      <nav className="nav-mobile" aria-label={t('nav.principale')}>
        <a
          href="#/"
          className={`nav-mobile-lien${route.type === 'accueil' ? ' actif' : ''}`}
          aria-current={route.type === 'accueil' ? 'page' : undefined}
        >
          <IconeTableauDeBord className="nav-mobile-icone" />
          <span>{t('nav.accueil')}</span>
        </a>
        <a
          href="#/nouveau"
          className={`nav-mobile-lien${route.type === 'nouveau' ? ' actif' : ''}`}
          aria-current={route.type === 'nouveau' ? 'page' : undefined}
        >
          <IconePlus className="nav-mobile-icone" />
          <span>{t('nav.creer_mobile')}</span>
        </a>
        <a
          href="#/invitations"
          className={`nav-mobile-lien${route.type === 'invitations' ? ' actif' : ''}`}
          aria-current={route.type === 'invitations' ? 'page' : undefined}
        >
          <span className="nav-mobile-icone-boite">
            <IconeEnveloppe className="nav-mobile-icone" />
            {moi.invitations_en_attente > 0 && (
              <span className="badge-alerte nav-mobile-badge">{moi.invitations_en_attente}</span>
            )}
          </span>
          <span>{t('nav.invitations')}</span>
        </a>
        <a
          href="#/notifications"
          className={`nav-mobile-lien${route.type === 'notifications' ? ' actif' : ''}`}
          aria-current={route.type === 'notifications' ? 'page' : undefined}
        >
          <span className="nav-mobile-icone-boite">
            <IconeCloche className="nav-mobile-icone" />
            {nonLues > 0 && <span className="badge-alerte nav-mobile-badge">{nonLues}</span>}
          </span>
          <span>{t('nav.notifs_mobile')}</span>
        </a>
        <a
          href="#/compte"
          className={`nav-mobile-lien${route.type === 'compte' ? ' actif' : ''}`}
          aria-current={route.type === 'compte' ? 'page' : undefined}
        >
          <IconeUtilisateur className="nav-mobile-icone" />
          <span>{t('nav.compte_mobile')}</span>
        </a>
      </nav>
    </div>
  );
}
