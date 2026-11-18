import { ErreurApi, ErreurLocale } from '../api/client';
import { t, texteErreur } from '../i18n';

/** Message d'une erreur porteuse d'une clé — venue du serveur (`ErreurApi`) ou décidée ici (`ErreurLocale`) — ; une coupure réseau (`fetch` lève un `TypeError`) ; ou générique pour le reste. */
export function messageDe(erreur: unknown): string {
  if (erreur instanceof ErreurApi || erreur instanceof ErreurLocale) return texteErreur(erreur.cle);
  if (erreur instanceof TypeError) return t('erreur.reseau');
  return texteErreur('interne');
}

/** Bloc d'erreur ; si `onReessayer` est fourni, il propose de relancer l'opération qui a échoué. */
export function Erreur({ message, onReessayer }: { message: string | null; onReessayer?: () => void }) {
  if (message === null) return null;
  return (
    <div className="erreur" role="alert">
      <p>{message}</p>
      {onReessayer !== undefined && (
        <button type="button" onClick={onReessayer}>
          {t('commun.reessayer')}
        </button>
      )}
    </div>
  );
}
