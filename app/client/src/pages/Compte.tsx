import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { instantDepuisHeureLocale } from '../agenda/dates';
import { libelleDateHoraire } from '../agenda/format';
import {
  creerCreneauPersonnel,
  definirPartagesCreneau,
  listerMonAgenda,
  supprimerCreneauPersonnel,
  visibilitePartage,
  type CreneauPersonnel,
  type VisibilitePartage,
} from '../api/agenda-personnel';
import { creerAbonnement, listerAbonnements, revoquerAbonnement, type Abonnement, type AbonnementCree } from '../api/flux';
import { lienGoogleAgenda } from '../api/lien-google';
import {
  enregistrerAvatar,
  preparerImageAvatar,
  supprimerAvatar,
  type GroupeResume,
  type Moi,
} from '../api/groupes';
import { CarteNotificationsPush } from '../components/CarteNotificationsPush';
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
  const [inclurePerso, setInclurePerso] = useState(false);
  const [refuses, setRefuses] = useState(true);
  const [cree, setCree] = useState<AbonnementCree | null>(null);
  const [copie, setCopie] = useState<{ cible: 'webcal' | 'https'; ok: boolean } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  // Le jeton qu'on vient de créer est révoqué depuis la liste : son adresse ne vaut plus rien, le panneau ne la garde pas affichée.
  const idRevoque = cree !== null && abonnements?.some((a) => a.id === cree.id && a.revoked_at !== null) === true;
  useEffect(() => {
    if (idRevoque) setCree(null);
  }, [idRevoque]);

  const soumettre = (e: FormEvent): void => {
    e.preventDefault();
    setErreur(null);
    creerAbonnement({
      label: nom.trim() === '' ? null : nom.trim(),
      group_id: groupeId === '' ? null : groupeId,
      include_personal: inclurePerso,
      include_declined: refuses,
    })
      .then((a) => {
        setCree(a);
        setCopie(null);
        setNom('');
        onCree();
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const copier = (cible: 'webcal' | 'https', adresse: string): void => {
    navigator.clipboard.writeText(adresse).then(
      () => setCopie({ cible, ok: true }),
      () => setCopie({ cible, ok: false }),
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
        <p>{t('flux.ajouter_calendrier_aide')}</p>
        <h4>{t('flux.webcal_titre')}</h4>
        <p>{t('flux.webcal_aide')}</p>
        <input type="text" readOnly value={cree.url_webcal} aria-label={t('flux.webcal_titre')} onFocus={(e) => e.target.select()} />
        <button type="button" onClick={() => copier('webcal', cree.url_webcal)}>
          {t('flux.copier')}
        </button>
        {copie?.cible === 'webcal' && (copie.ok ? <p>{t('flux.copie')}</p> : <p role="alert">{t('flux.copie_impossible')}</p>)}
        <h4>{t('flux.url_https_titre')}</h4>
        <p>{t('flux.url_https_aide')}</p>
        <input type="text" readOnly value={cree.url} aria-label={t('flux.url_https_titre')} onFocus={(e) => e.target.select()} />
        <button type="button" onClick={() => copier('https', cree.url)}>
          {t('flux.copier')}
        </button>
        {copie?.cible === 'https' && (copie.ok ? <p>{t('flux.copie')}</p> : <p role="alert">{t('flux.copie_impossible')}</p>)}
        <p>
          <a href={lienGoogleAgenda(cree.url)} className="bouton" target="_blank" rel="noopener noreferrer">
            {t('flux.google_lien')}
          </a>
        </p>
        <p>{t('flux.google_aide')}</p>
        <p>{t('flux.rafraichissement')}</p>
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
        <input type="checkbox" checked={inclurePerso} onChange={(e) => setInclurePerso(e.target.checked)} />
        {t('flux.inclure_perso')}
      </label>
      <label>
        <input type="checkbox" checked={refuses} onChange={(e) => setRefuses(e.target.checked)} />
        {t('flux.refuses')}
      </label>
      <button type="submit">{t('flux.creer')}</button>
    </form>
  );
}

/** Mon agenda personnel : liste des créneaux, création, suppression et partage par groupe. */
function MonAgendaPersonnel({ groupes }: { groupes: GroupeResume[] }) {
  const [creneaux, setCreneaux] = useState<CreneauPersonnel[] | null>(null);
  const [titre, setTitre] = useState('');
  const [journeeEntiere, setJourneeEntiere] = useState(false);
  const [debut, setDebut] = useState('');
  const [fin, setFin] = useState('');
  const [fuseau, setFuseau] = useState('Europe/Paris');
  const [lieu, setLieu] = useState('');
  const [description, setDescription] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);

  const charger = useCallback((): void => {
    listerMonAgenda()
      .then(setCreneaux)
      .catch((err: unknown) => setErreur(messageDe(err)));
  }, []);
  useEffect(charger, [charger]);

  const soumettre = (e: FormEvent): void => {
    e.preventDefault();
    setErreur(null);
    const fuseauNet = fuseau.trim();
    let startsAt: string;
    let endsAt: string | null = null;
    try {
      startsAt = journeeEntiere ? debut : instantDepuisHeureLocale(debut, fuseauNet);
      if (fin !== '') endsAt = journeeEntiere ? fin : instantDepuisHeureLocale(fin, fuseauNet);
    } catch {
      setErreur(t('evenement_form.fuseau_invalide'));
      return;
    }
    creerCreneauPersonnel({
      title: titre.trim(),
      description: description.trim() === '' ? null : description.trim(),
      location_name: lieu.trim() === '' ? null : lieu.trim(),
      all_day: journeeEntiere,
      starts_at: startsAt,
      ends_at: endsAt,
      time_zone: fuseauNet,
    })
      .then(() => {
        setTitre('');
        setDebut('');
        setFin('');
        setLieu('');
        setDescription('');
        charger();
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const supprimer = (id: string): void => {
    if (!window.confirm(t('agenda_perso.supprimer_confirmation'))) return;
    setErreur(null);
    supprimerCreneauPersonnel(id)
      .then(charger)
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const changerPartage = (creneauId: string, groupId: string, visibility: VisibilitePartage): void => {
    setErreur(null);
    definirPartagesCreneau(creneauId, [{ group_id: groupId, visibility }])
      .then((maj) => {
        setCreneaux((actuels) => (actuels === null ? actuels : actuels.map((c) => (c.id === maj.id ? maj : c))));
      })
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  return (
    <div>
      <h3>{t('agenda_perso.titre')}</h3>
      <p>{t('agenda_perso.explication')}</p>
      <Erreur message={erreur} />
      <form onSubmit={soumettre} className="formulaire">
        <h4>{t('agenda_perso.nouveau')}</h4>
        <label>
          {t('agenda_perso.champ_titre')}
          <input type="text" value={titre} maxLength={140} onChange={(e) => setTitre(e.target.value)} required />
        </label>
        <label className="ligne-case">
          <input
            type="checkbox"
            checked={journeeEntiere}
            onChange={(e) => {
              setJourneeEntiere(e.target.checked);
              setDebut('');
              setFin('');
            }}
          />
          {t('agenda_perso.champ_journee')}
        </label>
        <label>
          {t('agenda_perso.champ_debut')}
          <input
            type={journeeEntiere ? 'date' : 'datetime-local'}
            value={debut}
            onChange={(e) => setDebut(e.target.value)}
            required
          />
        </label>
        <label>
          {t('agenda_perso.champ_fin')}
          <input
            type={journeeEntiere ? 'date' : 'datetime-local'}
            value={fin}
            min={debut}
            onChange={(e) => setFin(e.target.value)}
          />
        </label>
        <label>
          {t('agenda_perso.champ_fuseau')}
          <input type="text" value={fuseau} maxLength={64} onChange={(e) => setFuseau(e.target.value)} required />
        </label>
        <label>
          {t('agenda_perso.champ_lieu')}
          <input type="text" value={lieu} maxLength={140} onChange={(e) => setLieu(e.target.value)} />
        </label>
        <label>
          {t('agenda_perso.champ_description')}
          <textarea value={description} maxLength={5000} rows={2} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <button type="submit" disabled={titre.trim() === '' || debut === ''}>
          {t('agenda_perso.ajouter')}
        </button>
      </form>

      {creneaux === null && <p>{t('commun.chargement')}</p>}
      {creneaux?.length === 0 && <p>{t('agenda_perso.aucun')}</p>}
      <ul>
        {creneaux?.map((c) => (
          <li key={c.id}>
            <strong>{c.title}</strong>
            {t('flux.separateur')}
            {libelleDateHoraire(c)}
            {c.location_name !== null && <p>{t('evenement.lieu', { lieu: c.location_name })}</p>}
            {c.description !== null && <p>{c.description}</p>}
            {groupes.length > 0 && (
              <div className="barre">
                <span>{t('agenda_perso.partages_titre')}</span>
                {groupes.map((g) => {
                  const partage = c.partages.find((p) => p.group_id === g.group_id)?.visibility ?? 'none';
                  return (
                    <label key={g.group_id}>
                      {g.name}
                      <select
                        value={partage}
                        onChange={(e) => changerPartage(c.id, g.group_id, visibilitePartage(e.target.value))}
                      >
                        <option value="none">{t('agenda_perso.visibilite_none')}</option>
                        <option value="busy">{t('agenda_perso.visibilite_busy')}</option>
                        <option value="details">{t('agenda_perso.visibilite_details')}</option>
                      </select>
                    </label>
                  );
                })}
              </div>
            )}
            <button type="button" onClick={() => supprimer(c.id)}>
              {t('agenda_perso.supprimer')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function initialesProfil(nom: string): string {
  const morceaux = nom.trim().split(/\s+/).filter(Boolean);
  if (morceaux.length === 0) return '?';
  if (morceaux.length === 1) return (morceaux[0] ?? '?').slice(0, 2).toUpperCase();
  const premier = morceaux[0]?.[0] ?? '';
  const dernier = morceaux[morceaux.length - 1]?.[0] ?? '';
  return `${premier}${dernier}`.toUpperCase();
}

/** Carte de gestion de la photo de profil utilisateur. */
function CartePhotoProfil({ moi, onProfilChange }: { moi: Moi; onProfilChange?: (() => void) | undefined }) {
  const [enCours, setEnCours] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const gererFichier = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const fichier = e.target.files?.[0];
    e.target.value = '';
    if (fichier === undefined) return;
    setErreur(null);
    setInfo(null);
    setEnCours(true);
    try {
      const { mime, data_base64 } = await preparerImageAvatar(fichier);
      await enregistrerAvatar(mime, data_base64);
      setInfo(t('avatar.enregistre'));
      onProfilChange?.();
    } catch (err: unknown) {
      setErreur(messageDe(err));
    } finally {
      setEnCours(false);
    }
  };

  const gererSuppression = async (): Promise<void> => {
    setErreur(null);
    setInfo(null);
    setEnCours(true);
    try {
      await supprimerAvatar();
      setInfo(t('avatar.supprime'));
      onProfilChange?.();
    } catch (err: unknown) {
      setErreur(messageDe(err));
    } finally {
      setEnCours(false);
    }
  };

  return (
    <div className="carte carte-avatar">
      <div className="carte-entete">
        <h3>{t('avatar.titre')}</h3>
      </div>
      <div className="carte-avatar-corps">
        {moi.avatar_url !== null ? (
          <img
            src={moi.avatar_url}
            alt={t('avatar.alt', { nom: moi.display_name })}
            className="avatar-photo avatar-photo-apercu"
          />
        ) : (
          <span className="avatar-initiales avatar-initiales-apercu" aria-hidden="true">
            {initialesProfil(moi.display_name)}
          </span>
        )}
        <div className="carte-avatar-details">
          <p className="texte-doux">{t('avatar.description')}</p>
          <div className="barre-compacte">
            <label className="bouton bouton-primaire bouton-fichier">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="champ-fichier-cache"
                disabled={enCours}
                onChange={(e) => void gererFichier(e)}
              />
              <span>{enCours ? t('avatar.enregistrement') : t('avatar.choisir')}</span>
            </label>
            {moi.avatar_url !== null && (
              <button
                type="button"
                className="bouton bouton-danger-discret"
                disabled={enCours}
                onClick={() => void gererSuppression()}
              >
                {t('avatar.supprimer')}
              </button>
            )}
          </div>
        </div>
      </div>
      <Erreur message={erreur} />
      {info !== null && (
        <p role="status" className="message-succes">
          {info}
        </p>
      )}
    </div>
  );
}

/** Mon compte : photo de profil, notifications push, agenda personnel et abonnements calendrier. */
export function Compte({
  moi,
  groupes,
  onProfilChange,
}: {
  moi: Moi;
  groupes: GroupeResume[];
  onProfilChange?: (() => void) | undefined;
}) {
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
    <section className="page-pile">
      <h2>{t('compte.titre')}</h2>
      <CartePhotoProfil moi={moi} onProfilChange={onProfilChange} />
      <CarteNotificationsPush />
      <MonAgendaPersonnel groupes={groupes} />
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
            {a.include_personal && `${t('flux.separateur')}${t('flux.avec_perso')}`}
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
