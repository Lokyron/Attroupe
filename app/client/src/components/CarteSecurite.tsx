import { useId, useRef, useState, type FormEvent } from 'react';
import {
  changerMotDePasse,
  listerSessions,
  revoquerAutresSessions,
  revoquerSession,
  type SessionCompte,
} from '../api/compte';
import { ChargementPage } from '../components/ChargementPage';
import { DialogueConfirmation } from '../components/DialogueConfirmation';
import { Erreur, messageDe } from '../components/Erreur';
import { useLecture } from '../hooks/useLecture';
import { useSoumission } from '../hooks/useSoumission';
import { t } from '../i18n';

const LOCALE = 'fr-FR';

function dateCourte(instant: string): string {
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(instant));
}

/**
 * Traduit l'identification brute du navigateur en « Firefox sur Windows » : l'utilisateur doit reconnaître son
 * appareil, pas lire une chaîne technique. Ordre des tests = ordre des pièges (Edge et Opera se disent aussi
 * Chrome, Chrome se dit aussi Safari ; Android se dit aussi Linux, iOS se dit aussi macOS).
 */
function nomAppareil(userAgent: string | null): string {
  if (userAgent === null || userAgent.trim() === '') return t('securite.appareil_inconnu');
  const navigateurs: readonly (readonly [RegExp, string])[] = [
    [/Edg(e|A|iOS)?\//, 'Edge'],
    [/OPR\/|Opera/, 'Opera'],
    [/Firefox\/|FxiOS\//, 'Firefox'],
    [/Chrome\/|CriOS\//, 'Chrome'],
    [/Safari\//, 'Safari'],
  ];
  const systemes: readonly (readonly [RegExp, string])[] = [
    [/Android/, 'Android'],
    [/iPhone|iPad|iPod/, 'iOS'],
    [/Windows/, 'Windows'],
    [/Mac OS X|Macintosh/, 'macOS'],
    [/CrOS/, 'ChromeOS'],
    [/Linux/, 'Linux'],
  ];
  const navigateur = navigateurs.find(([motif]) => motif.test(userAgent))?.[1];
  const systeme = systemes.find(([motif]) => motif.test(userAgent))?.[1];
  if (navigateur === undefined || systeme === undefined) return t('securite.appareil_inconnu');
  return t('securite.appareil_sur', { navigateur, systeme });
}

/** Changement de mot de passe : la session courante est renouvelée, les autres sont coupées par le serveur. */
function FormulaireMotDePasse({ onChange }: { onChange: () => void }) {
  const [actuel, setActuel] = useState('');
  const [nouveau, setNouveau] = useState('');
  const [champsRequis, setChampsRequis] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const envoi = useSoumission();
  const idActuel = useId();
  const idNouveau = useId();
  const idAide = useId();
  const idRequis = useId();

  const soumettre = (e: FormEvent): void => {
    e.preventDefault();
    setInfo(null);
    setErreur(null);
    if (actuel === '' || nouveau === '') {
      setChampsRequis(true);
      return;
    }
    setChampsRequis(false);
    envoi
      .lancer(() =>
        changerMotDePasse(actuel, nouveau).then(() => {
          // Les mots de passe ne restent dans aucun état une fois envoyés, quelle que soit l'issue côté serveur
          // ci-dessous : en cas d'échec ils sont vidés dans le `catch`.
          setActuel('');
          setNouveau('');
          setInfo(t('securite.mdp_change'));
          onChange();
        }),
      )
      .catch((err: unknown) => {
        setActuel('');
        setNouveau('');
        setErreur(messageDe(err));
      });
  };

  return (
    <form onSubmit={soumettre} className="formulaire" noValidate>
      <h4>{t('securite.mdp_titre')}</h4>

      <label htmlFor={idActuel}>{t('securite.champ_actuel')}</label>
      <input
        id={idActuel}
        type="password"
        value={actuel}
        autoComplete="current-password"
        disabled={envoi.enCours}
        aria-invalid={champsRequis && actuel === ''}
        {...(champsRequis && actuel === '' ? { 'aria-describedby': idRequis } : {})}
        onChange={(e) => setActuel(e.target.value)}
      />

      <label htmlFor={idNouveau}>{t('securite.champ_nouveau')}</label>
      <input
        id={idNouveau}
        type="password"
        value={nouveau}
        autoComplete="new-password"
        disabled={envoi.enCours}
        aria-invalid={champsRequis && nouveau === ''}
        aria-describedby={champsRequis && nouveau === '' ? `${idAide} ${idRequis}` : idAide}
        onChange={(e) => setNouveau(e.target.value)}
      />
      <p id={idAide} className="texte-doux">
        {t('securite.aide_nouveau')}
      </p>
      {champsRequis && (
        <p id={idRequis} className="erreur-champ">
          {t('securite.champs_requis')}
        </p>
      )}

      <Erreur message={erreur} />
      {info !== null && (
        <p role="status" className="message-succes">
          {info}
        </p>
      )}
      <div className="barre-compacte">
        <button type="submit" className="bouton bouton-primaire" disabled={envoi.enCours}>
          {envoi.enCours ? t('securite.changement_en_cours') : t('securite.changer')}
        </button>
      </div>
    </form>
  );
}

/** Sécurité du compte : mot de passe et appareils connectés (sessions). */
export function CarteSecurite() {
  const { donnees: sessions, etat, erreur: erreurLecture, recharger, rafraichir, rafraichissement } = useLecture(
    () => listerSessions(),
    [],
  );
  const [cible, setCible] = useState<SessionCompte | null>(null);
  const [confirmerAutres, setConfirmerAutres] = useState(false);
  const [occupe, setOccupe] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const revocation = useSoumission();
  const titreSessions = useRef<HTMLHeadingElement>(null);

  const autres = sessions?.filter((s) => !s.courante) ?? [];

  // Le bouton qui avait ouvert le dialogue est grisé, puis disparaît à la relecture : le focus tomberait sur
  // `body`. On le pose sur le titre de la liste, qui reste.
  const replacerFocus = (): void => titreSessions.current?.focus();

  const confirmerRevocation = (): void => {
    if (cible === null) return;
    const s = cible;
    setCible(null);
    setErreur(null);
    setInfo(null);
    setOccupe(s.id);
    revocation
      .lancer(() =>
        revoquerSession(s.id).then(() => {
          setInfo(t('securite.appareil_deconnecte'));
          rafraichir();
        }),
      )
      .catch((err: unknown) => {
        setErreur(messageDe(err));
        // Un 404 veut dire que la ligne est périmée (appareil déjà déconnecté) : on la relit, sinon chaque essai échouerait.
        rafraichir();
      })
      .finally(() => {
        setOccupe(null);
        replacerFocus();
      });
  };

  const confirmerRevocationAutres = (): void => {
    setConfirmerAutres(false);
    setErreur(null);
    setInfo(null);
    revocation
      .lancer(() =>
        revoquerAutresSessions().then((nombre) => {
          setInfo(t('securite.autres_deconnectes', { nombre: String(nombre) }));
          rafraichir();
        }),
      )
      .catch((err: unknown) => {
        setErreur(messageDe(err));
        rafraichir();
      })
      .finally(replacerFocus);
  };

  return (
    <section className="carte">
      <div className="carte-entete">
        <h3>{t('securite.titre')}</h3>
      </div>
      <p className="texte-doux">{t('securite.description')}</p>

      {/* Après un changement, la liste est relue : le serveur a coupé les autres appareils. */}
      <FormulaireMotDePasse onChange={rafraichir} />

      <h4 ref={titreSessions} tabIndex={-1} className="carte-sous-titre">{t('securite.sessions_titre')}</h4>
      <p className="texte-doux">{t('securite.sessions_aide')}</p>

      {info !== null && (
        <p role="status" className="message-succes">
          {info}
        </p>
      )}
      <Erreur message={erreur} />

      <ChargementPage etat={etat} erreur={erreurLecture} onReessayer={recharger}>
        {/* Une relecture ratée garde l'écran intact (`rafraichir`) : sans cette ligne, la liste resterait
            périmée en silence après une action. */}
        {etat === 'pret' && <Erreur message={erreurLecture} onReessayer={rafraichir} />}
        {sessions !== null && (
          <ul className="liste-elements" aria-busy={rafraichissement}>
            {sessions.map((s) => {
              const nom = nomAppareil(s.user_agent);
              return (
                <li key={s.id} className="ligne ligne-pile">
                  <div className="ligne-principale">
                    <strong>{nom}</strong>
                    <span className="ligne-badges">
                      {s.courante && <span className="pilule pilule-positif">{t('securite.cet_appareil')}</span>}
                    </span>
                    <span className="ligne-meta">
                      {t('securite.derniere_activite', { date: dateCourte(s.last_seen_at) })}
                    </span>
                  </div>
                  {/* Pas de bouton sur la session courante : s'en déconnecter ici serait un piège, « Se déconnecter » existe ailleurs. */}
                  {!s.courante && (
                    <div className="barre-compacte">
                      <button
                        type="button"
                        className="bouton bouton-compact bouton-danger-discret"
                        disabled={occupe === s.id || revocation.enCours}
                        aria-label={`${t('securite.deconnecter')} ${nom}`}
                        onClick={() => setCible(s)}
                      >
                        {occupe === s.id ? t('securite.deconnexion_en_cours') : t('securite.deconnecter')}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {sessions !== null && autres.length === 0 && <p className="texte-doux">{t('securite.aucune_autre')}</p>}
        {autres.length > 0 && (
          <div className="barre-compacte">
            <button
              type="button"
              className="bouton bouton-compact bouton-danger-discret"
              disabled={revocation.enCours}
              onClick={() => setConfirmerAutres(true)}
            >
              {revocation.enCours && occupe === null ? t('securite.deconnexion_en_cours') : t('securite.deconnecter_autres')}
            </button>
          </div>
        )}
      </ChargementPage>

      <DialogueConfirmation
        ouvert={cible !== null}
        titre={t('confirm.securite.deconnecter_appareil.titre', { appareil: cible === null ? '' : nomAppareil(cible.user_agent) })}
        consequence={t('confirm.securite.deconnecter_appareil.consequence')}
        reversible
        libelleConfirmer={t('confirm.securite.deconnecter_appareil.action')}
        danger
        onConfirmer={confirmerRevocation}
        onAnnuler={() => setCible(null)}
      />
      <DialogueConfirmation
        ouvert={confirmerAutres}
        titre={t('confirm.securite.deconnecter_autres.titre')}
        consequence={t('confirm.securite.deconnecter_autres.consequence')}
        reversible
        libelleConfirmer={t('confirm.securite.deconnecter_autres.action')}
        danger
        onConfirmer={confirmerRevocationAutres}
        onAnnuler={() => setConfirmerAutres(false)}
      />
    </section>
  );
}
