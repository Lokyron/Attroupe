import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type RefObject } from 'react';
import { instantDepuisHeureLocale } from '../agenda/dates';
import { libelleDateHoraire } from '../agenda/format';
import {
  creerCreneauPersonnel,
  listerMonAgenda,
  supprimerCreneauPersonnel,
  visibilitePartage,
  type CreneauPersonnel,
} from '../api/agenda-personnel';
import { modifierProfil } from '../api/compte';
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
import { CarteProfil } from '../components/CarteProfil';
import { CarteSecurite } from '../components/CarteSecurite';
import { ChampFuseau } from '../components/ChampFuseau';
import { CarteSourcesAgenda } from '../components/CarteSourcesAgenda';
import { DialogueConfirmation } from '../components/DialogueConfirmation';
import { Erreur, messageDe } from '../components/Erreur';
import { useSoumission } from '../hooks/useSoumission';
import { t } from '../i18n';
import { ChampsPeriode } from '../components/ChampsPeriode';
import { initialesDe } from '../lib/initiales';

const LOCALE = 'fr-FR';

function dateCourte(instant: string): string {
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(instant));
}

/**
 * État d'un chargement distant : on ne déduit pas « en cours » de `null`, sinon un échec reste « Chargement… » à jamais.
 *
 * Gardé à la place de `useLecture` : `useLecture` vide `donnees` à chaque rechargement. Or ici la liste est rechargée après
 * chaque écriture, et pour les abonnements `NouvelAbonnement` a besoin de la liste pour ne pas être démonté pendant
 * l'affichage de l'adresse secrète, qu'on ne reverra jamais. Ce type conserve la liste affichée pendant le rechargement.
 */
type EtatChargement = 'chargement' | 'erreur' | 'pret';

/**
 * Réduit la chaîne `User-Agent` brute (« Mozilla/5.0 (iPhone; CPU iPhone OS… ») à un nom lisible, par exemple « Safari, iPhone ».
 * Renvoie `null` quand rien de connu n'est reconnu : mieux vaut ne rien afficher que du bruit technique.
 */
function appareilLisible(agent: string): string | null {
  const logiciel =
    /Google-?Calendar/i.test(agent) ? 'Google Agenda'
    : /dataaccessd|CalendarAgent|accountsd/i.test(agent) ? 'Calendrier Apple'
    : /Thunderbird/i.test(agent) ? 'Thunderbird'
    : /Outlook/i.test(agent) ? 'Outlook'
    : /Edg\//.test(agent) ? 'Edge'
    : /OPR\//.test(agent) ? 'Opera'
    : /Firefox\//.test(agent) ? 'Firefox'
    : /Chrome\//.test(agent) ? 'Chrome'
    : /Safari\//.test(agent) ? 'Safari'
    : null;
  const systeme =
    /iPhone/.test(agent) ? 'iPhone'
    : /iPad/.test(agent) ? 'iPad'
    : /Android/.test(agent) ? 'Android'
    : /Windows/.test(agent) ? 'Windows'
    : /Macintosh|Mac OS X/.test(agent) ? 'Mac'
    : /Linux/.test(agent) ? 'Linux'
    : null;
  const morceaux = [logiciel, systeme].filter((m): m is string => m !== null);
  return morceaux.length === 0 ? null : morceaux.join(', ');
}

/**
 * Création d'un abonnement : l'adresse complète n'est affichée qu'ICI, une seule fois, et l'application
 * n'en garde aucune copie lisible.
 *
 * D'où la séparation entre `onCree` et `onFerme` : `onCree` ne fait que recharger la liste, et seul
 * `onFerme` — le bouton « J'ai terminé » — referme le formulaire. Si le parent repliait le formulaire dès
 * la création, ce composant serait démonté avant d'avoir montré l'adresse, et l'abonnement tout juste créé
 * serait bon à révoquer.
 *
 * Même piège côté parent avec un compte sans abonnement : le formulaire n'y est visible que parce que la liste est
 * vide, et la création la rend non vide. Le parent force donc `ouvert` à la création (voir `onCree` plus bas), et
 * `onAdresse` lui signale qu'une adresse est à l'écran pour qu'il masque son bouton « Annuler », qui démonterait
 * le composant sans avoir laissé le temps de la copier.
 */
function NouvelAbonnement({
  groupes,
  abonnements,
  onCree,
  onFerme,
  onAdresse,
}: {
  groupes: GroupeResume[];
  abonnements: Abonnement[] | null;
  onCree: () => void;
  onFerme: () => void;
  onAdresse: (visible: boolean) => void;
}) {
  const [nom, setNom] = useState('');
  const [groupeId, setGroupeId] = useState('');
  const [inclurePerso, setInclurePerso] = useState(false);
  const [refuses, setRefuses] = useState(true);
  const [cree, setCree] = useState<AbonnementCree | null>(null);
  const [copie, setCopie] = useState<{ cible: 'webcal' | 'https'; ok: boolean } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const creation = useSoumission();

  const champWebcal = useRef<HTMLInputElement>(null);
  const champHttps = useRef<HTMLInputElement>(null);

  // Le jeton qu'on vient de créer est révoqué depuis la liste : son adresse ne vaut plus rien, le panneau ne la garde pas affichée.
  const idRevoque = cree !== null && abonnements?.some((a) => a.id === cree.id && a.revoked_at !== null) === true;
  const adresseVisible = cree !== null && !idRevoque;

  // Le parent doit savoir qu'une adresse (qu'on ne reverra jamais) est à l'écran ; au démontage, il n'y en a plus.
  useEffect(() => {
    onAdresse(adresseVisible);
    return () => onAdresse(false);
  }, [adresseVisible, onAdresse]);

  const soumettre = (e: FormEvent): void => {
    e.preventDefault();
    setErreur(null);
    creation
      .lancer(() =>
        creerAbonnement({
          label: nom.trim() === '' ? null : nom.trim(),
          group_id: groupeId === '' ? null : groupeId,
          include_personal: inclurePerso,
          include_declined: refuses,
        }).then((a) => {
          setCree(a);
          setCopie(null);
          setNom('');
          onCree();
        }),
      )
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  // `navigator.clipboard` est ABSENT hors contexte sécurisé (Attroupe auto-hébergé, parfois en HTTP sur le réseau local) :
  // l'appel lève alors un `TypeError` synchrone que les gestionnaires de la promesse n'attraperaient pas. Dans tous les
  // cas d'échec, on sélectionne le champ pour que l'utilisateur copie à la main, et on affiche le message de repli.
  const copier = (cible: 'webcal' | 'https', adresse: string, champ: RefObject<HTMLInputElement | null>): void => {
    const repli = (): void => {
      champ.current?.select();
      setCopie({ cible, ok: false });
    };
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') {
        repli();
        return;
      }
      navigator.clipboard.writeText(adresse).then(() => setCopie({ cible, ok: true }), repli);
    } catch {
      repli();
    }
  };

  if (cree !== null && adresseVisible) {
    return (
      <div role="status" className="flux-cree">
        <h4>{t('flux.url_titre')}</h4>
        <p role="alert" className="message-avertissement">{t('flux.url_avertissement')}</p>

        <div className="flux-bloc">
          <a href={cree.url_webcal} className="bouton bouton-primaire">
            {t('flux.ajouter_calendrier')}
          </a>
          <p className="texte-doux">{t('flux.ajouter_calendrier_aide')}</p>
        </div>

        <div className="flux-bloc">
          <h5>{t('flux.webcal_titre')}</h5>
          <p className="texte-doux">{t('flux.webcal_aide')}</p>
          <div className="barre-compacte">
            <input
              ref={champWebcal}
              type="text"
              readOnly
              className="champ-adresse"
              value={cree.url_webcal}
              aria-label={t('flux.webcal_titre')}
              onFocus={(e) => e.target.select()}
            />
            <button type="button" className="bouton bouton-compact" onClick={() => copier('webcal', cree.url_webcal, champWebcal)}>
              {t('flux.copier')}
            </button>
          </div>
          {copie?.cible === 'webcal' &&
            (copie.ok ? <p className="message-succes">{t('flux.copie')}</p> : <p role="alert">{t('flux.copie_impossible')}</p>)}
        </div>

        <div className="flux-bloc">
          <h5>{t('flux.url_https_titre')}</h5>
          <p className="texte-doux">{t('flux.url_https_aide')}</p>
          <div className="barre-compacte">
            <input
              ref={champHttps}
              type="text"
              readOnly
              className="champ-adresse"
              value={cree.url}
              aria-label={t('flux.url_https_titre')}
              onFocus={(e) => e.target.select()}
            />
            <button type="button" className="bouton bouton-compact" onClick={() => copier('https', cree.url, champHttps)}>
              {t('flux.copier')}
            </button>
          </div>
          {copie?.cible === 'https' &&
            (copie.ok ? <p className="message-succes">{t('flux.copie')}</p> : <p role="alert">{t('flux.copie_impossible')}</p>)}
          <p>
            <a href={lienGoogleAgenda(cree.url)} className="bouton bouton-compact" target="_blank" rel="noopener noreferrer">
              {t('flux.google_lien')}
            </a>
          </p>
          <p className="texte-doux">{t('flux.google_aide')}</p>
        </div>

        <details className="flux-details">
          <summary>{t('flux.rafraichissement_titre')}</summary>
          <p className="texte-doux">{t('flux.rafraichissement')}</p>
        </details>

        <button
          type="button"
          className="bouton bouton-primaire"
          onClick={() => {
            setCree(null);
            onFerme();
          }}
        >
          {t('flux.fermer')}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={soumettre} className="formulaire formulaire-encadre">
      <h4>{t('flux.nouveau')}</h4>
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
      {/* `ligne-case` : sans elle, `.formulaire label` est une grille et la case se place AU-DESSUS de son libellé. */}
      <label className="ligne-case">
        <input type="checkbox" checked={inclurePerso} onChange={(e) => setInclurePerso(e.target.checked)} />
        {t('flux.inclure_perso')}
      </label>
      <label className="ligne-case">
        <input type="checkbox" checked={refuses} onChange={(e) => setRefuses(e.target.checked)} />
        {t('flux.refuses')}
      </label>
      <button type="submit" className="bouton bouton-primaire" disabled={creation.enCours}>
        {creation.enCours ? t('commun.creation') : t('flux.creer')}
      </button>
    </form>
  );
}

/** Mon agenda personnel : le réglage de visibilité (unique, pour tous les créneaux), la liste des créneaux, la création et la suppression. */
function MonAgendaPersonnel({ moi, onProfilChange }: { moi: Moi; onProfilChange?: (() => void) | undefined }) {
  const [visibilite, setVisibilite] = useState(moi.personal_agenda_visibility);
  const reglage = useSoumission();
  const idVisibilite = useId();
  const [creneaux, setCreneaux] = useState<CreneauPersonnel[] | null>(null);
  const [etat, setEtat] = useState<EtatChargement>('chargement');
  const [titre, setTitre] = useState('');
  const [journeeEntiere, setJourneeEntiere] = useState(false);
  const [debut, setDebut] = useState('');
  const [fin, setFin] = useState('');
  const [fuseau, setFuseau] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [lieu, setLieu] = useState('');
  const [description, setDescription] = useState('');
  const [ouvert, setOuvert] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [cible, setCible] = useState<CreneauPersonnel | null>(null);
  const creation = useSoumission();
  const suppression = useSoumission();

  const charger = useCallback((): void => {
    setEtat('chargement');
    setErreur(null);
    listerMonAgenda()
      .then((lus) => {
        setCreneaux(lus);
        setEtat('pret');
      })
      .catch((err: unknown) => {
        setEtat('erreur');
        setErreur(messageDe(err));
      });
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
    creation
      .lancer(() =>
        creerCreneauPersonnel({
          title: titre.trim(),
          description: description.trim() === '' ? null : description.trim(),
          location_name: lieu.trim() === '' ? null : lieu.trim(),
          all_day: journeeEntiere,
          starts_at: startsAt,
          ends_at: endsAt,
          time_zone: fuseauNet,
        }).then(() => {
          setTitre('');
          setDebut('');
          setFin('');
          setLieu('');
          setDescription('');
          setOuvert(false);
          charger();
        }),
      )
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const confirmerSuppression = (): void => {
    if (cible === null) return;
    const id = cible.id;
    setCible(null);
    setErreur(null);
    suppression
      .lancer(() => supprimerCreneauPersonnel(id).then(charger))
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const changerVisibilite = (nouvelle: typeof visibilite): void => {
    setErreur(null);
    reglage
      .lancer(() =>
        modifierProfil({ personal_agenda_visibility: nouvelle }).then((profil) => {
          setVisibilite(profil.personal_agenda_visibility);
          onProfilChange?.();
        }),
      )
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  const vide = creneaux !== null && creneaux.length === 0;
  // Liste vide : le formulaire s'affiche d'emblée, il n'y a rien d'autre à montrer. Sinon il est replié,
  // pour que la page s'ouvre sur ce qu'on a déjà enregistré et non sur sept champs à remplir.
  const formulaireVisible = ouvert || vide;

  return (
    <section className="carte">
      <div className="carte-entete">
        <h3>{t('agenda_perso.titre')}</h3>
        {!vide && (
          <button type="button" className="bouton bouton-compact" onClick={() => setOuvert(!ouvert)}>
            {ouvert ? t('commun.annuler') : t('agenda_perso.nouveau')}
          </button>
        )}
      </div>
      <p className="texte-doux">{t('agenda_perso.explication')}</p>
      <div>
        <label className="agenda-visibilite-champ" htmlFor={idVisibilite}>
          <span>{t('agenda_perso.visibilite_titre')}</span>
          <select
            id={idVisibilite}
            value={visibilite}
            disabled={reglage.enCours}
            aria-describedby={`${idVisibilite}-aide`}
            onChange={(e) => changerVisibilite(visibilitePartage(e.target.value))}
          >
            <option value="none">{t('agenda_perso.visibilite_none')}</option>
            <option value="busy">{t('agenda_perso.visibilite_busy')}</option>
            <option value="details">{t('agenda_perso.visibilite_details')}</option>
          </select>
        </label>
        <p id={`${idVisibilite}-aide`} className="texte-doux">
          {t('agenda_perso.visibilite_aide')}
        </p>
      </div>
      <Erreur message={erreur} {...(etat === 'erreur' ? { onReessayer: charger } : {})} />

      {formulaireVisible && (
        <form onSubmit={soumettre} className="formulaire formulaire-encadre">
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
                // Les dates déjà saisies sont conservées, converties au format du champ : « 2026-05-01T10:00 » ne
                // s'affiche pas dans un champ `date`, et inversement une date seule n'est pas valide en `datetime-local`.
                setJourneeEntiere(e.target.checked);
                const versJournee = e.target.checked;
                const convertir = (v: string): string =>
                  v === '' ? v : versJournee ? v.slice(0, 10) : v.length === 10 ? `${v}T00:00` : v;
                setDebut(convertir);
                setFin(convertir);
              }}
            />
            {t('agenda_perso.champ_journee')}
          </label>
          <ChampsPeriode
            journee={journeeEntiere}
            debut={debut}
            fin={fin}
            onDebut={setDebut}
            onFin={setFin}
            cleLibelleDebut="agenda_perso.champ_debut"
            cleLibelleFin="agenda_perso.champ_fin"
          />
          <div className="grille-champs-2">
            <label>
              {t('agenda_perso.champ_fuseau')}
              <ChampFuseau value={fuseau} onChange={setFuseau} />
            </label>
            <label>
              {t('agenda_perso.champ_lieu')}
              <input type="text" value={lieu} maxLength={140} onChange={(e) => setLieu(e.target.value)} />
            </label>
          </div>
          <label>
            {t('agenda_perso.champ_description')}
            <textarea value={description} maxLength={5000} rows={2} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <button type="submit" className="bouton bouton-primaire" disabled={creation.enCours || titre.trim() === '' || debut === ''}>
            {creation.enCours ? t('commun.creation') : t('agenda_perso.ajouter')}
          </button>
        </form>
      )}

      {etat === 'chargement' && (
        <p role="status" className="texte-doux">
          {t('commun.chargement')}
        </p>
      )}
      {vide && <p className="texte-doux">{t('agenda_perso.aucun')}</p>}
      {creneaux !== null && creneaux.length > 0 && (() => {
        const maintenantIso = new Date().toISOString();
        const aVenir = creneaux.filter((c) => (c.ends_at ?? c.starts_at) >= maintenantIso);
        const passes = creneaux.filter((c) => (c.ends_at ?? c.starts_at) < maintenantIso);
        const rendreCreneau = (c: CreneauPersonnel) => (
            <li key={c.id} className="ligne ligne-pile">
              <div className="ligne-principale">
                {/* `ligne-principale` est une grille : une pastille posée directement dedans s'étirerait sur
                    toute la largeur. `ligne-badges` est la rangée flex prévue pour ça. */}
                <span className="ligne-badges">
                  <strong>{c.title}</strong>
                  {c.calendar_source_id !== null && <span className="pilule pilule-neutre">{t('agenda_perso.importe')}</span>}
                </span>
                <span className="ligne-meta">{libelleDateHoraire(c)}</span>
                {c.location_name !== null && <span className="ligne-meta">{t('evenement.lieu', { lieu: c.location_name })}</span>}
                {c.description !== null && <span className="ligne-meta">{c.description}</span>}
              </div>
              {c.calendar_source_id === null ? (
                <button type="button" className="bouton bouton-compact bouton-danger-discret" aria-label={`${t('agenda_perso.supprimer')} ${c.title}`} disabled={suppression.enCours} onClick={() => setCible(c)}>
                  {suppression.enCours ? t('commun.suppression') : t('agenda_perso.supprimer')}
                </button>
              ) : (
                <span className="ligne-meta">{t('agenda_perso.importe_aide')}</span>
              )}
            </li>
        );
        return (
          <>
            {aVenir.length > 0 && <ul className="liste-elements">{aVenir.map(rendreCreneau)}</ul>}
            {passes.length > 0 && (
              <details className="liste-compacte-haut">
                <summary>{t('agenda_perso.passes_titre', { count: String(passes.length) })}</summary>
                <ul className="liste-elements">{passes.map(rendreCreneau)}</ul>
              </details>
            )}
          </>
        );
      })()}

      <DialogueConfirmation
        ouvert={cible !== null}
        titre={t('confirm.agenda_perso.supprimer.titre')}
        consequence={t('confirm.agenda_perso.supprimer.consequence')}
        reversible={false}
        libelleConfirmer={t('confirm.agenda_perso.supprimer.action')}
        danger
        onConfirmer={confirmerSuppression}
        onAnnuler={() => setCible(null)}
      />
    </section>
  );
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
            {initialesDe(moi.display_name)}
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

/** Une ligne d'abonnement : nom, portée, usage, et l'action à droite. */
function LigneAbonnement({ abonnement, onRevoquer }: { abonnement: Abonnement; onRevoquer: (id: string) => void }) {
  const a = abonnement;
  const appareil = a.last_user_agent === null ? null : appareilLisible(a.last_user_agent);
  return (
    <li className="ligne">
      <div className="ligne-principale">
        <strong>{a.label ?? t('flux.sans_nom')}</strong>
        <span className="ligne-meta">
          {a.group_id === null
            ? t('flux.tous')
            : a.group_name === null
              ? t('flux.groupe_quitte')
              : t('flux.groupe', { groupe: a.group_name })}
          {a.include_personal && `${t('flux.separateur')}${t('flux.avec_perso')}`}
        </span>
        <span className="ligne-meta">
          {a.last_used_at === null ? t('flux.jamais_utilise') : t('flux.derniere_utilisation', { date: dateCourte(a.last_used_at) })}
          {appareil !== null && `${t('flux.separateur')}${t('flux.appareil', { agent: appareil })}`}
        </span>
      </div>
      {a.revoked_at !== null ? (
        <span className="pilule pilule-neutre">{t('flux.revoque')}</span>
      ) : (
        <button type="button" className="bouton bouton-compact bouton-danger-discret"
          aria-label={`${t('flux.revoquer')} ${a.label ?? t('flux.sans_nom')}`}
          onClick={() => onRevoquer(a.id)}
        >
          {t('flux.revoquer')}
        </button>
      )}
    </li>
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
  const [etat, setEtat] = useState<EtatChargement>('chargement');
  const [ouvert, setOuvert] = useState(false);
  const [adresseVisible, setAdresseVisible] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [cibleId, setCibleId] = useState<string | null>(null);
  const revocation = useSoumission();

  const charger = useCallback((): void => {
    setEtat('chargement');
    setErreur(null);
    listerAbonnements()
      .then((lus) => {
        setAbonnements(lus);
        setEtat('pret');
      })
      .catch((err: unknown) => {
        setEtat('erreur');
        setErreur(messageDe(err));
      });
  }, []);
  useEffect(charger, [charger]);

  const confirmerRevocation = (): void => {
    if (cibleId === null) return;
    const id = cibleId;
    setCibleId(null);
    setErreur(null);
    revocation
      .lancer(() => revoquerAbonnement(id).then(charger))
      .catch((err: unknown) => setErreur(messageDe(err)));
  };

  // Un abonnement révoqué n'est plus actionnable : il ne sert qu'à se souvenir qu'on l'a coupé. Il reste
  // consultable (la purge d'entretien l'efface au bout de 30 jours) mais replié, sinon la liste s'allonge
  // sans fin et les abonnements vivants s'y noient.
  const actifs = abonnements?.filter((a) => a.revoked_at === null) ?? null;
  const revoques = abonnements?.filter((a) => a.revoked_at !== null) ?? [];
  const vide = actifs !== null && actifs.length === 0;
  const formulaireVisible = ouvert || vide;

  return (
    <section className="page-pile">
      <h2>{t('compte.titre')}</h2>
      <CarteProfil moi={moi} onProfilChange={onProfilChange} />
      <CarteSecurite />
      <CartePhotoProfil moi={moi} onProfilChange={onProfilChange} />
      <CarteNotificationsPush />
      <MonAgendaPersonnel moi={moi} onProfilChange={onProfilChange} />
      <CarteSourcesAgenda />

      <section className="carte">
        <div className="carte-entete">
          <h3>{t('flux.titre')}</h3>
          {/* Masqué tant que l'adresse du flux est affichée : « Annuler » démonterait le panneau, et l'adresse ne sera plus jamais montrée. */}
          {!vide && !adresseVisible && (
            <button type="button" className="bouton bouton-compact" onClick={() => setOuvert(!ouvert)}>
              {ouvert ? t('commun.annuler') : t('flux.nouveau')}
            </button>
          )}
        </div>
        <p className="texte-doux">{t('flux.explication')}</p>
        <Erreur message={erreur} {...(etat === 'erreur' ? { onReessayer: charger } : {})} />

        {formulaireVisible && (
          <NouvelAbonnement
            groupes={groupes}
            abonnements={abonnements}
            // PIÈGE : avec zéro abonnement actif, le formulaire n'est visible que par `vide`. Dès que la création
            // réussit, la liste n'est plus vide, `formulaireVisible` retomberait à faux et `NouvelAbonnement`
            // serait démonté avec l'adresse secrète, jamais vue. On force donc `ouvert` : le panneau ne se
            // referme que par `onFerme` (« J'ai terminé »).
            onCree={() => {
              setOuvert(true);
              charger();
            }}
            onFerme={() => setOuvert(false)}
            onAdresse={setAdresseVisible}
          />
        )}

        {etat === 'chargement' && (
          <p role="status" className="texte-doux">
            {t('commun.chargement')}
          </p>
        )}
        {vide && <p className="texte-doux">{t('flux.aucun')}</p>}
        {actifs !== null && actifs.length > 0 && (
          <ul className="liste-elements">
            {actifs.map((a) => (
              <LigneAbonnement key={a.id} abonnement={a} onRevoquer={setCibleId} />
            ))}
          </ul>
        )}
        {revoques.length > 0 && (
          <details className="flux-details">
            <summary>{t('flux.revoques', { nombre: String(revoques.length) })}</summary>
            <p className="texte-doux">{t('flux.revoques_aide')}</p>
            <ul className="liste-elements">
              {revoques.map((a) => (
                <LigneAbonnement key={a.id} abonnement={a} onRevoquer={setCibleId} />
              ))}
            </ul>
          </details>
        )}

        <DialogueConfirmation
          ouvert={cibleId !== null}
          titre={t('confirm.flux.revoquer.titre')}
          consequence={t('confirm.flux.revoquer.consequence')}
          reversible={false}
          libelleConfirmer={t('confirm.flux.revoquer.action')}
          danger
          onConfirmer={confirmerRevocation}
          onAnnuler={() => setCibleId(null)}
        />
      </section>
    </section>
  );
}
