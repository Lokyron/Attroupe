import { useState, type FormEvent } from 'react';
import { creerEvenement, modifierEvenement, type ChampsEvenement, type DetailEvenement } from '../api/evenements';
import { heureLocaleDepuisInstant, instantDepuisHeureLocale } from '../agenda/dates';
import { useSoumission } from '../hooks/useSoumission';
import { t } from '../i18n';
import { Erreur, messageDe } from './Erreur';

const vide = (valeur: string): string | null => (valeur.trim() === '' ? null : valeur.trim());

/** Valeur d'un champ date / date-heure à partir de l'événement, lue dans son fuseau. */
function versChamp(instant: string | null, journee: boolean, fuseau: string): string {
  if (instant === null) return '';
  return journee ? instant : heureLocaleDepuisInstant(instant, fuseau);
}

/** Création (sans `initial`) ou modification d'un événement. L'heure se saisit dans le fuseau de l'événement. */
export function FormulaireEvenement({
  groupId,
  fuseauParDefaut,
  initial,
  onEnregistre,
  onAnnule,
}: {
  groupId: string;
  fuseauParDefaut: string;
  initial?: DetailEvenement;
  onEnregistre: (evenement: DetailEvenement) => void;
  onAnnule: () => void;
}) {
  const [titre, setTitre] = useState(initial?.title ?? '');
  const [journee, setJournee] = useState(initial?.all_day ?? false);
  const [fuseau, setFuseau] = useState(initial?.time_zone ?? fuseauParDefaut);
  const [debut, setDebut] = useState(initial === undefined ? '' : versChamp(initial.starts_at, initial.all_day, initial.time_zone));
  const [fin, setFin] = useState(initial === undefined ? '' : versChamp(initial.ends_at, initial.all_day, initial.time_zone));
  const [lieu, setLieu] = useState(initial?.location_name ?? '');
  const [adresse, setAdresse] = useState(initial?.location_address ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [arrivee, setArrivee] = useState(initial?.arrival_note ?? '');
  const [capacite, setCapacite] = useState(initial?.capacity === null || initial === undefined ? '' : String(initial.capacity));
  const [erreur, setErreur] = useState<string | null>(null);
  const { enCours, lancer } = useSoumission();

  // Passer de « journée entière » à une heure change le format des champs : on les vide plutôt que d'en deviner la conversion.
  const basculerJournee = (valeur: boolean): void => {
    setJournee(valeur);
    setDebut('');
    setFin('');
  };

  const soumettre = (e: FormEvent): void => {
    e.preventDefault();
    setErreur(null);
    if (fin !== '' && fin < debut) {
      setErreur(t('evenement_form.fin_avant_debut'));
      return;
    }
    const fuseauNet = fuseau.trim();
    let champs: ChampsEvenement;
    try {
      champs = {
        title: titre.trim(),
        description: vide(description),
        location_name: vide(lieu),
        location_address: vide(adresse),
        all_day: journee,
        starts_at: journee ? debut : instantDepuisHeureLocale(debut, fuseauNet),
        ends_at: fin === '' ? null : journee ? fin : instantDepuisHeureLocale(fin, fuseauNet),
        time_zone: fuseauNet,
        arrival_note: vide(arrivee),
        capacity: capacite === '' ? null : Number(capacite),
      };
    } catch {
      // Fuseau inconnu du navigateur : le serveur le refuserait aussi.
      setErreur(t('evenement_form.fuseau_invalide'));
      return;
    }
    const envoi = (): Promise<DetailEvenement> => (initial === undefined ? creerEvenement(groupId, champs) : modifierEvenement(groupId, initial.id, champs));
    lancer(() => envoi().then(onEnregistre)).catch((err: unknown) => setErreur(messageDe(err)));
  };

  return (
    <form onSubmit={soumettre} className="formulaire">
      <label>
        {t('evenement_form.titre')}
        <input type="text" value={titre} onChange={(e) => setTitre(e.target.value)} required maxLength={140} />
      </label>
      <label className="ligne-case">
        <input type="checkbox" checked={journee} onChange={(e) => basculerJournee(e.target.checked)} />
        {t('evenement_form.journee_entiere')}
      </label>
      <label>
        {t('evenement_form.debut')}
        <input type={journee ? 'date' : 'datetime-local'} value={debut} onChange={(e) => setDebut(e.target.value)} required />
      </label>
      <label>
        {t('evenement_form.fin')}
        <input type={journee ? 'date' : 'datetime-local'} value={fin} min={debut} onChange={(e) => setFin(e.target.value)} />
      </label>
      <label>
        {t('evenement_form.fuseau')}
        <input type="text" value={fuseau} onChange={(e) => setFuseau(e.target.value)} required maxLength={64} />
      </label>
      <label>
        {t('evenement_form.lieu')}
        <input type="text" value={lieu} onChange={(e) => setLieu(e.target.value)} maxLength={140} />
      </label>
      <label>
        {t('evenement_form.adresse')}
        <input type="text" value={adresse} onChange={(e) => setAdresse(e.target.value)} maxLength={300} />
      </label>
      <label>
        {t('evenement_form.description')}
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} rows={4} />
      </label>
      <label>
        {t('evenement_form.arrivee')}
        <input type="text" value={arrivee} onChange={(e) => setArrivee(e.target.value)} maxLength={500} />
      </label>
      <label>
        {t('evenement_form.capacite')}
        <input type="number" inputMode="numeric" min={1} value={capacite} onChange={(e) => setCapacite(e.target.value)} />
      </label>
      <Erreur message={erreur} />
      <div className="barre">
        <button type="submit" disabled={enCours}>
          {enCours ? t('commun.enregistrement') : t('commun.enregistrer')}
        </button>
        <button type="button" onClick={onAnnule}>
          {t('commun.annuler')}
        </button>
      </div>
    </form>
  );
}
