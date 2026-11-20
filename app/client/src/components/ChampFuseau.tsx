import { useId, useMemo } from 'react';
import { fuseauxConnus } from '../lib/fuseaux';

export interface PropsChampFuseau {
  readonly value: string;
  readonly onChange: (nouveauFuseau: string) => void;
  readonly id?: string;
  readonly required?: boolean;
  readonly ariaInvalid?: boolean;
  readonly ariaDescribedBy?: string;
}

/** Champ fuseau horaire avec autocomplétion `<datalist>` sur les fuseaux IANA supportés par le navigateur. */
export function ChampFuseau({ value, onChange, id, required = true, ariaInvalid, ariaDescribedBy }: PropsChampFuseau) {
  const idListe = useId();
  const options = useMemo(fuseauxConnus, []);

  return (
    <>
      <input
        id={id}
        type="text"
        value={value}
        maxLength={64}
        required={required}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        list={options !== null ? idListe : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {options !== null && (
        <datalist id={idListe}>
          {options.map((tz) => (
            <option key={tz} value={tz} />
          ))}
        </datalist>
      )}
    </>
  );
}
