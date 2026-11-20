import { useRef, useState, type FormEvent } from 'react';
import {
  ajouterSource,
  listerSources,
  modifierSource,
  supprimerSource,
  synchroniserSource,
  type SourceAgenda,
  type StatutSource,
} from '../api/agenda-externe';
import { ChargementPage } from '../components/ChargementPage';
import { DialogueConfirmation } from '../components/DialogueConfirmation';
import { Erreur, messageDe } from '../components/Erreur';
import { useLecture } from '../hooks/useLecture';
import { useSoumission } from '../hooks/useSoumission';
import { t } from '../i18n';
import { cleAccord } from '../lib/pluriel';

// Sources d'agenda externe (ADR-0013). Deux choses que cet écran doit dire, et qu'il dit AVANT le champ d'URL :
//  - iCloud ne convient pas. Apple n'offre aucune URL privée : seul un « calendrier public » existe, lisible par
//    quiconque a le lien, détails compris. Demander ça pour afficher « occupé » à trois amis serait l'inverse du but.
//  - ce qui sera visible des groupes, c'est « occupé » et rien d'autre. Jamais le titre, jamais le lieu.

const LOCALE = 'fr-FR';

function dateCourte(instant: string): string {
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(instant));
}

/** Libellé du dernier résultat. La clé est stable ; le texte explique quoi faire, pas ce qui s'est passé en interne. */
function libelleStatut(s: StatutSource): string {
  const cles: Readonly<Record<StatutSource, Parameters<typeof t>[0]>> = {
    ok: 'source.statut_ok',
    vide: 'source.statut_vide',
    injoignable: 'source.statut_injoignable',
    trop_gros: 'source.statut_trop_gros',
    illisible: 'source.statut_illisible',
    refuse: 'source.statut_refuse',
    cle_illisible: 'source.statut_cle_illisible',
  };
  return t(cles[s]);
}

/** Pastille COURTE (état seul) : `.pilule` ne passe pas à la ligne, une phrase entière déborderait sur téléphone. */
function pilulteStatut(source: SourceAgenda): { classe: string; texte: string } {
  if (source.disabled_at !== null) return { classe: 'pilule pilule-neutre', texte: t('source.desactivee') };
  if (source.last_status === null) return { classe: 'pilule pilule-neutre', texte: t('source.jamais_synchronisee') };
  if (source.last_status === 'ok' || source.last_status === 'vide') {
    return { classe: 'pilule pilule-positif', texte: libelleStatut(source.last_status) };
  }
  return { classe: 'pilule pilule-negatif', texte: t('source.statut_echec') };
}

/** Explication longue d'un échec, à afficher dans un paragraphe sous la pastille ; `null` quand tout va bien. */
function explicationStatut(source: SourceAgenda): string | null {
  if (source.disabled_at !== null || source.last_status === null) return null;
  if (source.last_status === 'ok' || source.last_status === 'vide') return null;
  return libelleStatut(source.last_status);
}

function FormulaireSource({ onAjoutee, onAnnuler }: { onAjoutee: (message: string) => void; onAnnuler: () => void }) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);
  // Une requête en vol bloque la suivante. Le garde est un `ref` : React groupe les mises à jour, donc un état
  // serait encore à `false` pour tous les clics d'une même salve. La création dure jusqu'à 20 s — la fenêtre est large.
  const enVol = useRef(false);

  const soumettre = (e: FormEvent): void => {
    e.preventDefault();
    if (enVol.current) return;
    setErreur(null);
    enVol.current = true;
    setEnvoi(true);
    ajouterSource(url.trim(), label.trim() === '' ? null : label.trim())
      .then((s) => {
        // La source est créée même si la première synchronisation a échoué : on annonce le résultat réel,
        // pas un succès de façade.
        onAjoutee(
          s.synchronisation.statut === 'ok'
            ? t(cleAccord('source.ajoutee', s.synchronisation.creneaux_importes), { n: String(s.synchronisation.creneaux_importes) })
            : t('source.ajoutee_mais', { raison: libelleStatut(s.synchronisation.statut) }),
        );
      })
      .catch((err: unknown) => setErreur(messageDe(err)))
      .finally(() => {
        enVol.current = false;
        setEnvoi(false);
      });
  };

  return (
    <form onSubmit={soumettre} className="formulaire formulaire-encadre">
      <h4>{t('source.nouveau')}</h4>

      <p className="message-avertissement">{t('source.avertissement_icloud')}</p>

      <label>
        {t('source.champ_url')}
        <input
          type="url"
          value={url}
          maxLength={2048}
          required
          disabled={envoi}
          placeholder={t('source.url_exemple')}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <p className="texte-doux">{t('source.aide_google')}</p>
      <p className="texte-doux">{t('source.aide_outlook')}</p>

      <label>
        {t('source.champ_label')}
        <input type="text" value={label} maxLength={60} disabled={envoi} onChange={(e) => setLabel(e.target.value)} />
      </label>

      <p className="texte-doux">{t('source.rappel_confidentialite')}</p>
      <Erreur message={erreur} />

      <div className="barre-compacte">
        <button type="submit" className="bouton bouton-primaire" disabled={envoi || url.trim() === ''}>
          {envoi ? t('source.ajout_en_cours') : t('source.ajouter')}
        </button>
        <button type="button" className="bouton bouton-compact" disabled={envoi} onClick={onAnnuler}>
          {t('commun.annuler')}
        </button>
      </div>
      {envoi && <p role="status" className="texte-doux">{t('source.ajout_patience')}</p>}
    </form>
  );
}

/** Mes agendas externes : ajout, état, relance, désactivation et suppression. */
export function CarteSourcesAgenda() {
  const { donnees: sources, etat, erreur: erreurLecture, recharger, rafraichir } = useLecture(() => listerSources(), []);
  const [cible, setCible] = useState<SourceAgenda | null>(null);
  const suppression = useSoumission();
  const [ouvert, setOuvert] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState<string | null>(null);

  const vide = sources !== null && sources.length === 0;
  const formulaireVisible = ouvert || vide;

  const agir = (id: string, action: Promise<unknown>, succes?: string): void => {
    setErreur(null);
    setInfo(null);
    setOccupe(id);
    action
      .then(() => {
        if (succes !== undefined) setInfo(succes);
        rafraichir();
      })
      .catch((err: unknown) => setErreur(messageDe(err)))
      .finally(() => setOccupe(null));
  };

  const relancer = (s: SourceAgenda): void => {
    setErreur(null);
    setInfo(null);
    setOccupe(s.id);
    synchroniserSource(s.id)
      .then((maj) => {
        setInfo(
          maj.synchronisation.statut === 'ok'
            ? t(cleAccord('source.synchronisee', maj.synchronisation.creneaux_importes), { n: String(maj.synchronisation.creneaux_importes) })
            : t('source.synchro_echec', { raison: libelleStatut(maj.synchronisation.statut) }),
        );
        rafraichir();
      })
      .catch((err: unknown) => setErreur(messageDe(err)))
      .finally(() => setOccupe(null));
  };

  const confirmerSuppression = (): void => {
    if (cible === null) return;
    const s = cible;
    setCible(null);
    setErreur(null);
    setInfo(null);
    setOccupe(s.id);
    suppression
      .lancer(() =>
        supprimerSource(s.id).then(() => {
          setInfo(t('source.supprimee'));
          rafraichir();
        }),
      )
      .catch((err: unknown) => setErreur(messageDe(err)))
      .finally(() => setOccupe(null));
  };

  return (
    <section className="carte">
      <div className="carte-entete">
        <h3>{t('source.titre')}</h3>
        {!vide && (
          <button type="button" className="bouton bouton-compact" onClick={() => setOuvert(!ouvert)}>
            {ouvert ? t('commun.annuler') : t('source.nouveau')}
          </button>
        )}
      </div>
      <p className="texte-doux">{t('source.explication')}</p>

      {formulaireVisible && (
        <FormulaireSource
          onAjoutee={(message) => {
            setInfo(message);
            setOuvert(false);
            rafraichir();
          }}
          onAnnuler={() => setOuvert(false)}
        />
      )}

      {info !== null && (
        <p role="status" className="message-succes">
          {info}
        </p>
      )}
      <Erreur message={erreur} />

      <ChargementPage etat={etat} erreur={erreurLecture} onReessayer={recharger}>
      {/* Une relecture ratée garde l'écran intact (`rafraichir`), donc `ChargementPage` n'affiche
          rien : sans cette ligne, la liste resterait périmée en silence après une action. */}
      {etat === 'pret' && <Erreur message={erreurLecture} onReessayer={rafraichir} />}
      {vide && <p className="texte-doux">{t('source.aucune')}</p>}
      {sources !== null && sources.length > 0 && (
        <ul className="liste-elements">
          {sources.map((s) => {
            const pilule = pilulteStatut(s);
            const explication = explicationStatut(s);
            const enCours = occupe === s.id;
            return (
              <li key={s.id} className="ligne ligne-pile">
                <div className="ligne-principale">
                  <strong>{s.label}</strong>
                  <span className="ligne-meta">{s.url_host}</span>
                  <span className="ligne-badges">
                    <span className={pilule.classe}>{pilule.texte}</span>
                    <span className="ligne-meta">{t(cleAccord('source.creneaux', s.slots_imported), { n: String(s.slots_imported) })}</span>
                  </span>
                  <span className="ligne-meta">
                    {s.last_success_at === null
                      ? t('source.jamais_reussie')
                      : t('source.derniere_reussite', { date: dateCourte(s.last_success_at) })}
                  </span>
                  {s.slots_skipped > 0 && (
                    <span className="ligne-meta">{t(cleAccord('source.ignores', s.slots_skipped), { n: String(s.slots_skipped) })}</span>
                  )}
                  {explication !== null && <span className="ligne-meta">{explication}</span>}
                  {s.disabled_at !== null && <span className="ligne-meta">{t('source.desactivee_aide')}</span>}
                </div>
                <div className="barre-compacte">
                  <button
                    type="button"
                    className="bouton bouton-compact"
                    disabled={enCours}
                    aria-label={`${enCours ? t('source.synchro_en_cours') : t('source.synchroniser')} ${s.label}`}
                    onClick={() => relancer(s)}
                  >
                    {enCours ? t('source.synchro_en_cours') : t('source.synchroniser')}
                  </button>
                  <button
                    type="button"
                    className="bouton bouton-compact"
                    disabled={enCours}
                    aria-label={`${s.disabled_at === null ? t('source.desactiver') : t('source.reactiver')} ${s.label}`}
                    onClick={() =>
                      agir(
                        s.id,
                        modifierSource(s.id, { disabled: s.disabled_at === null }),
                        s.disabled_at === null ? t('source.desactivee_faite') : t('source.reactivee'),
                      )
                    }
                  >
                    {s.disabled_at === null ? t('source.desactiver') : t('source.reactiver')}
                  </button>
                  <button
                    type="button"
                    className="bouton bouton-compact bouton-danger-discret"
                    disabled={enCours}
                    aria-label={`${t('source.supprimer')} ${s.label}`}
                    onClick={() => setCible(s)}
                  >
                    {t('source.supprimer')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      </ChargementPage>

      <DialogueConfirmation
        ouvert={cible !== null}
        titre={t('confirm.source.supprimer.titre', { label: cible?.label ?? '' })}
        consequence={t('confirm.source.supprimer.consequence')}
        reversible={false}
        libelleConfirmer={t('confirm.source.supprimer.action')}
        danger
        onConfirmer={confirmerSuppression}
        onAnnuler={() => setCible(null)}
      />
    </section>
  );
}
