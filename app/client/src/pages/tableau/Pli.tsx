import type { ReactNode } from 'react';

/** Bloc replié (`<details>` : l'état ouvert/fermé est annoncé par le navigateur). Le titre de section est dans le `summary`. */
export function Pli({ titre, icone, children }: { titre: string; icone: ReactNode; children: ReactNode }) {
  return (
    <details className="carte pli">
      <summary>
        <h2 className="pli-titre">
          {icone}
          <span>{titre}</span>
        </h2>
        <span className="pli-signe" aria-hidden="true" />
      </summary>
      <div className="pli-contenu">{children}</div>
    </details>
  );
}
