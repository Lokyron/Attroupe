import type { FormEvent, ReactNode } from 'react';

interface Props {
  readonly onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  /** Texte du bouton d'envoi, déjà adapté à l'état d'envoi en cours. */
  readonly libelleBouton: string;
  readonly desactive: boolean;
  /** Les champs (au moins un `<input>`), placés avant le bouton. */
  readonly children: ReactNode;
}

/** Barre d'ajout en tête de liste : une carte avec le ou les champs, puis le bouton d'envoi. */
export function BarreAjout({ onSubmit, libelleBouton, desactive, children }: Props) {
  return (
    <form className="carte barre-ajout-ligne" onSubmit={onSubmit}>
      {children}
      <button type="submit" disabled={desactive}>
        {libelleBouton}
      </button>
    </form>
  );
}
