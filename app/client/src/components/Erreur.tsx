import { ErreurApi, ErreurLocale } from '../api/client';
import { texteErreur } from '../i18n';

/** Message d'une erreur porteuse d'une clé — venue du serveur (`ErreurApi`) ou décidée ici (`ErreurLocale`) — ou générique pour le reste. */
export function messageDe(erreur: unknown): string {
  if (erreur instanceof ErreurApi || erreur instanceof ErreurLocale) return texteErreur(erreur.cle);
  return texteErreur('erreur.interne');
}

export function Erreur({ message }: { message: string | null }) {
  return message === null ? null : <p role="alert">{message}</p>;
}
