import type { ReactNode } from 'react';

interface Props<T> {
  readonly elements: readonly T[];
  readonly cle: (element: T) => string;
  /** Contenu de la carte ; la grille l'enveloppe dans son `<li>`. */
  readonly rendu: (element: T) => ReactNode;
}

/** Grille de cartes de module, sémantiquement une liste : un `<li>` par élément. */
export function GrilleCartes<T>({ elements, cle, rendu }: Props<T>) {
  return (
    <ul className="grille-cartes-module">
      {elements.map((element) => (
        <li key={cle(element)}>{rendu(element)}</li>
      ))}
    </ul>
  );
}
