import { useId, useMemo } from 'react';
import { fuseauxConnus } from '../lib/fuseaux';

export interface PropsChampFuseau {
  readonly value: string;
  readonly onChange: (nouveauFuseau: string) => void;
  readonly id?: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
  /** Fuseau à proposer même si le navigateur ne le connaît pas (« UTC », fuseau enregistré du compte). */
  readonly inclure?: string;
  readonly ariaInvalid?: boolean;
  readonly ariaDescribedBy?: string;
}

/** Champ fuseau horaire avec autocomplétion `<datalist>` sur les fuseaux IANA supportés par le navigateur. */
export function ChampFuseau({ value, onChange, id, required = true, disabled = false, inclure, ariaInvalid, ariaDescribedBy }: PropsChampFuseau) {
  const idListe = useId();
  const options = useMemo(() => {
    const connus = fuseauxConnus();
    return connus === null || inclure === undefined || connus.includes(inclure) ? connus : [inclure, ...connus];
  }, [inclure]);

  return (
    <>
      <input
        id={id}
        type="text"
        value={value}
        maxLength={64}
        required={required}
        disabled={disabled}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
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
