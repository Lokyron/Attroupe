import { useCallback, useEffect, useState } from 'react';
import { ErreurApi } from './api/client';
import { deconnecter, lireMoi, type Moi } from './api/groupes';
import { t } from './i18n';
import { Connexion } from './pages/Connexion';
import { Agenda } from './pages/Agenda';
import { Evenement, NouvelEvenement } from './pages/Evenement';
import { Groupe } from './pages/Groupe';
import { InvitationLien } from './pages/InvitationLien';
import { Invitations } from './pages/Invitations';
import { NouveauGroupe } from './pages/NouveauGroupe';

type Route = { type: 'accueil' } | { type: 'nouveau' } | { type: 'invitations' } | { type: 'groupe'; id: string }
  | { type: 'agenda'; id: string }
  | { type: 'evenement'; id: string; evenementId: string }
  | { type: 'evenement-nouveau'; id: string };
type Etat = { type: 'chargement' } | { type: 'anonyme' } | { type: 'connecte'; moi: Moi };

function lireRoute(): Route {
  const [, premier, second, troisieme, quatrieme] = window.location.hash.split('/');
  if (premier === 'nouveau') return { type: 'nouveau' };
  if (premier === 'invitations') return { type: 'invitations' };
  if (premier === 'groupe' && second !== undefined && second !== '') {
    const id = decodeURIComponent(second);
    if (troisieme === 'agenda') return { type: 'agenda', id };
    if (troisieme === 'evenement-nouveau') return { type: 'evenement-nouveau', id };
    if (troisieme === 'evenement' && quatrieme !== undefined && quatrieme !== '') return { type: 'evenement', id, evenementId: decodeURIComponent(quatrieme) };
    return { type: 'groupe', id };
  }
  return { type: 'accueil' };
}

function aller(hash: string): void {
  window.location.hash = hash;
}

export function App() {
  const [etat, setEtat] = useState<Etat>({ type: 'chargement' });
  const [route, setRoute] = useState<Route>(lireRoute);
  const lien = window.location.pathname === '/invitation';

  const recharger = useCallback((): void => {
    lireMoi()
      .then((moi) => setEtat({ type: 'connecte', moi }))
      .catch((erreur: unknown) => {
        if (erreur instanceof ErreurApi && erreur.statut === 401) setEtat({ type: 'anonyme' });
        else console.error(erreur);
      });
  }, []);
  useEffect(recharger, [recharger]);
  useEffect(() => {
    const surChangement = (): void => setRoute(lireRoute());
    window.addEventListener('hashchange', surChangement);
    return () => window.removeEventListener('hashchange', surChangement);
  }, []);

  if (etat.type === 'chargement') return <p>{t('commun.chargement')}</p>;
  if (etat.type === 'anonyme') {
    return (
      <>
        {lien && <InvitationLien connecte={false} onAcceptee={recharger} />}
        <Connexion onConnecte={recharger} />
      </>
    );
  }

  const { moi } = etat;
  const groupeCourant = route.type === 'groupe' || route.type === 'agenda' || route.type === 'evenement' || route.type === 'evenement-nouveau' ? route.id : '';
  return (
    <main className="accueil">
      <header className="entete">
        <h1>{t('app.nom')}</h1>
        <select
          aria-label={t('nav.selecteur')}
          value={groupeCourant}
          onChange={(e) => aller(e.target.value === '' ? '#/' : `#/groupe/${encodeURIComponent(e.target.value)}`)}
        >
          <option value="">{t('nav.selecteur')}</option>
          {moi.groupes.map((g) => (
            <option key={g.group_id} value={g.group_id}>
              {g.name}
            </option>
          ))}
        </select>
        <a href="#/nouveau">{t('nav.nouveau_groupe')}</a>
        <a href="#/invitations">
          {t('nav.invitations')}
          {moi.invitations_en_attente > 0 && ` (${String(moi.invitations_en_attente)})`}
        </a>
        <button type="button" onClick={() => void deconnecter().then(() => setEtat({ type: 'anonyme' }))}>
          {t('nav.deconnexion')}
        </button>
      </header>
      {lien && <InvitationLien connecte onAcceptee={recharger} />}
      {!lien && route.type === 'accueil' && moi.groupes.length === 0 && <p>{t('nav.aucun_groupe')}</p>}
      {!lien && route.type === 'nouveau' && (
        <NouveauGroupe
          onCree={(id) => {
            recharger();
            aller(`#/groupe/${encodeURIComponent(id)}`);
          }}
        />
      )}
      {!lien && route.type === 'invitations' && <Invitations onChange={recharger} />}
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
      {!lien && route.type === 'evenement-nouveau' && <NouvelEvenement key={route.id} groupId={route.id} />}
      {!lien && route.type === 'evenement' && <Evenement key={route.evenementId} groupId={route.id} evenementId={route.evenementId} />}
    </main>
  );
}
