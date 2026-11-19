import type { ReactNode } from 'react';
import { t } from '../i18n';
import type { EtatLecture } from '../hooks/useLecture';
import { Erreur } from './Erreur';

/** Squelette de liste : `lignes` barres grises animées. Décoratif, donc masqué aux lecteurs d'écran. */
export function SqueletteListe({ lignes = 3 }: { lignes?: number }) {
  return (
    <div className="squelette-liste" aria-hidden="true">
      {Array.from({ length: lignes }, (_, i) => (
        <div key={i} className="squelette squelette-ligne" />
      ))}
    </div>
  );
}

/** Squelette d'une carte : un titre court et deux lignes de texte. */
export function SqueletteCarte() {
  return (
    <div className="carte squelette-carte" aria-hidden="true">
      <div className="squelette squelette-titre" />
      <div className="squelette squelette-ligne" />
      <div className="squelette squelette-ligne squelette-court" />
    </div>
  );
}

/** Enveloppe commune des pages de détail : squelette en chargement, erreur avec « Réessayer », puis le contenu. */
export function ChargementPage({
  etat,
  erreur,
  onReessayer,
  squelette,
  children,
}: {
  etat: EtatLecture;
  erreur: string | null;
  onReessayer: () => void;
  squelette?: ReactNode;
  children: ReactNode;
}) {
  if (etat === 'chargement') {
    return (
      <>
        <p role="status" className="visuellement-cache">
          {t('commun.chargement_en_cours')}
        </p>
        {squelette ?? <SqueletteListe />}
      </>
    );
  }
  if (etat === 'erreur') return <Erreur message={erreur} onReessayer={onReessayer} />;
  return <>{children}</>;
}
