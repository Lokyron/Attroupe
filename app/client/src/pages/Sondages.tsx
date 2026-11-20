import { useState, type FormEvent } from 'react';
import { instantDepuisHeureLocale } from '../agenda/dates';
import { useRechargement } from '../api/rechargement';
import { creerSondage, listerSondages, type NouvelleOptionSondage, type ResumeSondage } from '../api/sondages';
import { useGroupe, useTempsReelGroupe } from '../components/FournisseurGroupe';
import { ChargementPage } from '../components/ChargementPage';
import { EnteteGroupe } from '../components/EnteteGroupe';
import { Erreur, messageDe } from '../components/Erreur';
import { IconeSondage } from '../components/Icones';
import { premiereErreur } from '../hooks/etatsLecture';
import { useLecture } from '../hooks/useLecture';
import { useSoumission } from '../hooks/useSoumission';
import { t, type CleTexte } from '../i18n';

interface CreneauSaisi {
  readonly cle: number;
  readonly all_day: boolean;
  readonly starts_at: string;
  readonly ends_at: string;
}

export const lienSondage = (groupId: string, sondageId: string): string =>
  `#/groupe/${encodeURIComponent(groupId)}/sondage/${encodeURIComponent(sondageId)}`;

function classeStatutSondage(statut: ResumeSondage['status']): string {
  if (statut === 'open') return 'pilule pilule-statut-yes';
  if (statut === 'converted') return 'pilule pilule-role-admin';
  if (statut === 'cancelled') return 'pilule pilule-statut-no';
  return 'pilule';
}

/** Liste des sondages de dates du groupe et formulaire de création multi-créneaux repliable. */
export function Sondages({ groupId }: { groupId: string }) {
  // Lecture initiale (trois états) ; `sondages` en est la copie locale, rafraîchie par le temps réel sans repasser par le squelette.
  const lecture = useLecture(() => listerSondages(groupId), [groupId]);
  const [source, setSource] = useState(lecture.donnees);
  const [sondages, setSondages] = useState<ResumeSondage[] | null>(lecture.donnees);
  if (source !== lecture.donnees) {
    setSource(lecture.donnees);
    setSondages(lecture.donnees);
  }
  const { enCours, lancer } = useSoumission();
  const [formulaireOuvert, setFormulaireOuvert] = useState(false);
  const { groupe, erreur: erreurGroupe } = useGroupe();
  // Saisie de l'utilisateur, tant qu'il n'en a pas fait : le fuseau du groupe (contexte).
  const [fuseauSaisi, setFuseauSaisi] = useState<string | null>(null);
  const fuseau = fuseauSaisi ?? groupe?.time_zone ?? 'Europe/Paris';
  const [titre, setTitre] = useState('');
  const [description, setDescription] = useState('');
  const [cloture, setCloture] = useState('');
  const [prochaineCle, setProchaineCle] = useState(2);
  const [creneaux, setCreneaux] = useState<CreneauSaisi[]>([{ cle: 1, all_day: false, starts_at: '', ends_at: '' }]);
  const [erreur, setErreur] = useState<string | null>(null);

  const { recharger, planifier } = useRechargement(
    () => listerSondages(groupId),
    setSondages,
    (err) => setErreur(messageDe(err)),
  );

  useTempsReelGroupe({
    onOuvert: recharger,
    onEvenement: (e) => {
      if (e.ressource === 'sondage') planifier();
    },
  });

  const modifierCreneau = (cle: number, partiel: Partial<CreneauSaisi>): void => {
    setCreneaux((actuels) => actuels.map((c) => (c.cle === cle ? { ...c, ...partiel } : c)));
  };

  const ajouterLigneCreneau = (): void => {
    setCreneaux((actuels) => [...actuels, { cle: prochaineCle, all_day: false, starts_at: '', ends_at: '' }]);
    setProchaineCle((n) => n + 1);
  };

  const retirerLigneCreneau = (cle: number): void => {
    setCreneaux((actuels) => (actuels.length <= 1 ? actuels : actuels.filter((c) => c.cle !== cle)));
  };

  const soumettre = (e: FormEvent): void => {
    e.preventDefault();
    setErreur(null);
    const fuseauNet = fuseau.trim();
    let options: NouvelleOptionSondage[];
    let closesAt: string | null = null;
    try {
      options = creneaux.map((c) => ({
        all_day: c.all_day,
        starts_at: c.all_day ? c.starts_at : instantDepuisHeureLocale(c.starts_at, fuseauNet),
        ends_at: c.ends_at === '' ? null : c.all_day ? c.ends_at : instantDepuisHeureLocale(c.ends_at, fuseauNet),
      }));
      if (cloture !== '') closesAt = instantDepuisHeureLocale(cloture, fuseauNet);
    } catch {
      setErreur(t('evenement_form.fuseau_invalide'));
      return;
    }
    lancer(() =>
      creerSondage(groupId, {
        title: titre.trim(),
        description: description.trim() === '' ? null : description.trim(),
        closes_at: closesAt,
        options,
      }).then((cree) => {
        window.location.hash = lienSondage(groupId, cree.id);
      }),
    ).catch((err: unknown) => setErreur(messageDe(err)));
  };

  return (
    <section className="page-groupe-pile">
      <EnteteGroupe
        ongletActif="sondages"
        titre={t('sondages.titre')}
        actions={
          <button
            type="button"
            className={formulaireOuvert ? '' : 'bouton-primaire'}
            onClick={() => setFormulaireOuvert(!formulaireOuvert)}
          >
            {t(formulaireOuvert ? 'sondages.fermer_formulaire' : 'sondages.nouveau_bouton')}
          </button>
        }
      />

      <Erreur message={premiereErreur(erreur, erreurGroupe)} />

      {formulaireOuvert && (
        <div className="carte">
          <div className="carte-entete">
            <h3>{t('sondages.nouveau')}</h3>
          </div>
          <form className="formulaire" onSubmit={soumettre}>
            <label>
              {t('sondages.champ_titre')}
              <input type="text" value={titre} maxLength={140} onChange={(e) => setTitre(e.target.value)} required />
            </label>
            <label>
              {t('sondages.champ_description')}
              <textarea value={description} maxLength={5000} rows={3} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <div className="grille-champs-2">
              <label>
                {t('sondages.champ_fuseau')}
                <input type="text" value={fuseau} maxLength={64} onChange={(e) => setFuseauSaisi(e.target.value)} required />
              </label>
              <label>
                {t('sondages.champ_cloture')}
                <input type="datetime-local" value={cloture} onChange={(e) => setCloture(e.target.value)} />
              </label>
            </div>

            <h4>{t('sondages.creneaux_titre')}</h4>
            <div className="liste-creneaux-form">
              {creneaux.map((c) => (
                <div key={c.cle} className="bloc-creneau-form">
                  <label className="ligne-case">
                    <input
                      type="checkbox"
                      checked={c.all_day}
                      onChange={(e) => modifierCreneau(c.cle, { all_day: e.target.checked, starts_at: '', ends_at: '' })}
                    />
                    {t('sondages.creneau_journee')}
                  </label>
                  <div className="grille-champs-2">
                    <label>
                      {t('sondages.creneau_debut')}
                      <input
                        type={c.all_day ? 'date' : 'datetime-local'}
                        value={c.starts_at}
                        onChange={(e) => modifierCreneau(c.cle, { starts_at: e.target.value })}
                        required
                      />
                    </label>
                    <label>
                      {t('sondages.creneau_fin')}
                      <input
                        type={c.all_day ? 'date' : 'datetime-local'}
                        value={c.ends_at}
                        min={c.starts_at}
                        onChange={(e) => modifierCreneau(c.cle, { ends_at: e.target.value })}
                      />
                    </label>
                  </div>
                  {creneaux.length > 1 && (
                    <button type="button" className="bouton-compact bouton-danger-discret" onClick={() => retirerLigneCreneau(c.cle)}>
                      {t('sondages.retirer_creneau')}
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="barre">
              <button type="button" onClick={ajouterLigneCreneau}>
                {t('sondages.ajouter_creneau')}
              </button>
              <button type="submit" disabled={titre.trim() === '' || creneaux.some((c) => c.starts_at === '') || enCours}>
                {enCours ? t('commun.creation') : t('sondages.creer')}
              </button>
            </div>
          </form>
        </div>
      )}

      <ChargementPage etat={lecture.etat} erreur={lecture.erreur} onReessayer={lecture.recharger}>
        {sondages !== null && sondages.length === 0 ? (
          <div className="carte">
            <div className="etat-vide">
              <p>{t('sondages.aucun')}</p>
              {!formulaireOuvert && (
                <button type="button" className="bouton-primaire" onClick={() => setFormulaireOuvert(true)}>
                  {t('sondages.nouveau_bouton')}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="grille-cartes-module">
            {(sondages ?? []).map((s) => (
              <a key={s.id} className="carte carte-lien-module" href={lienSondage(groupId, s.id)}>
                <div className="carte-module-haut">
                  <span className="kpi-icone-badge module-icone-badge kpi-badge-ambre">
                    <IconeSondage className="icone" />
                  </span>
                  <span className={classeStatutSondage(s.status)}>{t(`sondages.statut_${s.status}` as CleTexte)}</span>
                </div>
                <strong className="carte-module-titre">{s.title}</strong>
                <span className="discret ligne-meta">{t('sondages.nb_creneaux', { n: String(s.options_count) })}</span>
              </a>
            ))}
          </div>
        )}
      </ChargementPage>
    </section>
  );
}
