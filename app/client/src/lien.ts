// Les trois liens envoyés par e-mail — confirmation d'adresse, réinitialisation, invitation — ont la même forme :
// un CHEMIN que le serveur sert comme n'importe quelle page du client (repli index.html), et le jeton dans le
// FRAGMENT (`#jeton=…`). Le fragment ne quitte jamais le navigateur : ni requête, ni journal d'accès, ni proxy.
// Le routeur de l'application, lui, route sur le fragment ; ces pages se reconnaissent donc au chemin, pas au hash.
// Les chemins ci-dessous doivent rester identiques à `GABARITS_A_JETON` (app/server/services/emails.ts), que le
// test `app/tests/unite/liens-email.test.ts` vérifie.

/** Même forme que `FORME_JETON` côté serveur : 43 caractères base64url. */
const FORME_JETON = /^[A-Za-z0-9_-]{43}$/;

export type PageLien = 'invitation' | 'verification-email' | 'reinitialisation';

export const CHEMINS_LIEN: Readonly<Record<string, PageLien>> = {
  '/invitation': 'invitation',
  '/verification-email': 'verification-email',
  '/reinitialisation': 'reinitialisation',
};

/** La page à jeton correspondant à ce chemin, ou `null` si l'URL n'en est pas une. Le chemin est passé par l'appelant : ce module reste testable hors navigateur. */
export function pageDuLien(chemin: string): PageLien | null {
  return CHEMINS_LIEN[chemin.replace(/\/+$/, '') || '/'] ?? null;
}

/** Le jeton porté par le fragment, ou `null` si absent ou mal formé (lien tronqué par un client de messagerie). */
export function jetonDuFragment(fragment: string): string | null {
  const jeton = new URLSearchParams(fragment.replace(/^#/, '')).get('jeton');
  return jeton !== null && FORME_JETON.test(jeton) ? jeton : null;
}
