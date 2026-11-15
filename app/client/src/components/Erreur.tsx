import { ErreurApi } from '../api/client';
import { texteErreur } from '../i18n';

/** Message d'une erreur d'API (traduit), ou générique pour toute autre erreur. */
export function messageDe(erreur: unknown): string {
  return erreur instanceof ErreurApi ? texteErreur(erreur.cle) : texteErreur('erreur.interne');
}

export function Erreur({ message }: { message: string | null }) {
  return message === null ? null : <p role="alert">{message}</p>;
}
