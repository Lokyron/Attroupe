import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { creerAbonnement, listerAbonnements, revoquerAbonnement, type Abonnement, type AbonnementCree } from '../api/flux';
import type { GroupeResume } from '../api/groupes';
import { Erreur, messageDe } from '../components/Erreur';
import { t } from '../i18n';

const LOCALE = 'fr-FR';

function dateCourte(instant: string): string {
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(instant));
}

/** Création d'un abonnement : l'adresse complète n'est affichée qu'ici, une seule fois. */
function NouvelAbonnement({ groupes, abonnements, onCree }: { groupes: GroupeResume[]; abonnements: Abonnement[] | null; onCree: () => void }) {
  const [nom, setNom] = useState('');
  const [groupeId, setGroupeId] = useState('');
  const [refuses, setRefuses] = useState(true);
  const [cree, setCree] = useState<AbonnementCree | null>(null);
  const [copie, setCopie] = useState<'oui' | 'non' | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  // Le jeton qu'on vient de créer est révoqué depuis la liste : son adresse ne vaut plus rien, le panneau ne la garde pas affichée.
  const idRevoque = cree !== null && abonnements?.some((a) => a.id === cree.id && a.revoked_at !== null) === true;
  useEffect(() => {
    if (idRevoque) setCree(null);
  }, [idRevoque]);

  const soumettre = (e: FormEvent): void => {
    e.preventDefault();
    setErreur(null);
    creerAbonnement({ label: nom.trim() === '' ? null : nom.trim(), group_id: groupeId === '' ? null : groupeId, include_declined: refuses })
      .then((a) => {
        setCree(a);
        setCopie(null);
        setNom('');
        onCree();
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const copier = (url: string): void => {
    navigator.clipboard.writeText(url).then(
      () => setCopie('oui'),
      () => setCopie('non'),
    );
  };

  if (cree !== null && !idRevoque) {
    return (
      <div role="status">
        <h3>{t('flux.url_titre')}</h3>
        <p role="alert">{t('flux.url_avertissement')}</p>
        <p>
          <a href={cree.url_webcal} className="bouton">
            {t('flux.ajouter_calendrier')}
          </a>
        </p>
        <p>{t('flux.difference')}</p>
        <p>{t('flux.rafraichissement')}</p>
        <p>{t('flux.url_https_aide')}</p>
        <input type="text" readOnly value={cree.url} aria-label={t('flux.url_https_titre')} onFocus={(e) => e.target.select()} />
        <button type="button" onClick={() => copier(cree.url)}>
          {t('flux.copier')}
        </button>
        {copie === 'oui' && <p>{t('flux.copie')}</p>}
        {copie === 'non' && <p role="alert">{t('flux.copie_impossible')}</p>}
        <button type="button" onClick={() => setCree(null)}>
          {t('flux.fermer')}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={soumettre} className="formulaire">
      <h3>{t('flux.nouveau')}</h3>
      <Erreur message={erreur} />
      <label>
        {t('flux.nom')}
        <input type="text" value={nom} maxLength={80} placeholder={t('flux.nom_exemple')} onChange={(e) => setNom(e.target.value)} />
      </label>
      <label>
        {t('flux.portee')}
        <select value={groupeId} onChange={(e) => setGroupeId(e.target.value)}>
          <option value="">{t('flux.tous_groupes')}</option>
          {groupes.map((g) => (
            <option key={g.group_id} value={g.group_id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input type="checkbox" checked={refuses} onChange={(e) => setRefuses(e.target.checked)} />
        {t('flux.refuses')}
      </label>
      <button type="submit">{t('flux.creer')}</button>
    </form>
  );
}

/** Mon compte : mes abonnements calendrier. */
export function Compte({ groupes }: { groupes: GroupeResume[] }) {
  const [abonnements, setAbonnements] = useState<Abonnement[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const charger = useCallback((): void => {
    listerAbonnements().then(setAbonnements).catch((err: unknown) => setErreur(messageDe(err)));
  }, []);
  useEffect(charger, [charger]);

  const revoquer = (id: string): void => {
    if (!window.confirm(t('flux.revoquer_confirmation'))) return;
    setErreur(null);
    revoquerAbonnement(id).then(charger).catch((err: unknown) => setErreur(messageDe(err)));
  };

  return (
    <section>
      <h2>{t('compte.titre')}</h2>
      <h3>{t('flux.titre')}</h3>
      <p>{t('flux.explication')}</p>
      <Erreur message={erreur} />
      <NouvelAbonnement groupes={groupes} abonnements={abonnements} onCree={charger} />
      {abonnements === null && <p>{t('commun.chargement')}</p>}
      {abonnements?.length === 0 && <p>{t('flux.aucun')}</p>}
      <ul>
        {abonnements?.map((a) => (
          <li key={a.id}>
            <strong>{a.label ?? t('flux.sans_nom')}</strong>
            {t('flux.separateur')}
            {a.group_id === null ? t('flux.tous') : a.group_name === null ? t('flux.groupe_quitte') : t('flux.groupe', { groupe: a.group_name })}
            <br />
            {a.last_used_at === null ? t('flux.jamais_utilise') : t('flux.derniere_utilisation', { date: dateCourte(a.last_used_at) })}
            {a.last_user_agent !== null && `${t('flux.separateur')}${t('flux.appareil', { agent: a.last_user_agent })}`}
            {a.revoked_at !== null ? (
              <em>{`${t('flux.separateur')}${t('flux.revoque')}`}</em>
            ) : (
              <button type="button" onClick={() => revoquer(a.id)}>
                {t('flux.revoquer')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
