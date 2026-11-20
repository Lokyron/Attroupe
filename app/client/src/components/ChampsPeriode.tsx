import type { Ref } from 'react';
import { t, type CleTexte } from '../i18n';

interface Props {
  /** Journée entière : champs `date` ; sinon `datetime-local`. */
  readonly journee: boolean;
  readonly debut: string;
  readonly fin: string;
  readonly onDebut: (valeur: string) => void;
  readonly onFin: (valeur: string) => void;
  readonly cleLibelleDebut: CleTexte;
  readonly cleLibelleFin: CleTexte;
  /** Pour donner le focus au début depuis l'extérieur. */
  readonly refDebut?: Ref<HTMLInputElement>;
}

/** Couple de champs début (obligatoire) / fin (facultative, jamais avant le début). */
export function ChampsPeriode({ journee, debut, fin, onDebut, onFin, cleLibelleDebut, cleLibelleFin, refDebut }: Props) {
  const type = journee ? 'date' : 'datetime-local';
  return (
    <div className="grille-champs-2">
      <label>
        {t(cleLibelleDebut)}
        <input ref={refDebut} type={type} value={debut} onChange={(e) => onDebut(e.target.value)} required />
      </label>
      <label>
        {t(cleLibelleFin)}
        <input type={type} value={fin} min={debut} onChange={(e) => onFin(e.target.value)} />
      </label>
    </div>
  );
}
