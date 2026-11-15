import { z } from 'zod';
import type { EmailAEnfiler } from '../db/queries/transverse.js';
import { HEURE_MS, JOUR_MS } from '../domain/instant.js';
import fr from '../i18n/fr.json' with { type: 'json' };

// Gabarits locaux (architecture §7.3) : le texte vit dans i18n/fr.json et se relit avec le code, Brevo
// n'est qu'un transporteur. Ce module fabrique d'une part les lignes à mettre en file (`EmailAEnfiler`),
// d'autre part le message final (`rendre`) au moment de l'envoi.
//
// Les e-mails à lien secret (vérification, réinitialisation) ne portent dans la file QUE l'identifiant de leur
// ligne de jeton : le jeton est tiré à l'envoi (services/brevo.ts), son clair n'existe que dans le message sortant.

const schemaGabarit = z.object({ sujet: z.string(), texte: z.string() });
const schemaTextes = z.object({
  application: z.string(),
  emails: z.record(z.string(), schemaGabarit),
});
const textes = schemaTextes.parse(fr);

const schemaVariables = z.record(z.string(), z.string());

export interface MessageRendu {
  readonly sujet: string;
  readonly texte: string;
  readonly html: string;
}

/** Gabarit inconnu ou variables illisibles : l'e-mail ne partira jamais, il est mis en échec définitif. */
export class ErreurGabarit extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErreurGabarit';
  }
}

function echapperHtml(texte: string): string {
  return texte.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function remplacer(modele: string, variables: Readonly<Record<string, string>>): string {
  return modele.replace(/\{(\w+)\}/g, (motif, nom: string) => (nom === 'application' ? textes.application : (variables[nom] ?? motif)));
}

/** Rend un e-mail de la file : texte brut et HTML (les liens http(s) deviennent cliquables, tout est échappé). */
export function rendre(templateKey: string, payloadJson: string, _locale: string, complements: Readonly<Record<string, string>> = {}): MessageRendu {
  const gabarit = textes.emails[templateKey];
  if (gabarit === undefined) throw new ErreurGabarit(`Gabarit d'e-mail inconnu : « ${templateKey} ».`);
  let variables: Record<string, string>;
  try {
    variables = { ...schemaVariables.parse(JSON.parse(payloadJson)), ...complements };
  } catch {
    throw new ErreurGabarit(`Variables illisibles pour le gabarit « ${templateKey} ».`);
  }
  const texte = remplacer(gabarit.texte, variables);
  const html = texte
    .split(/\n{2,}/)
    .map((paragraphe) => {
      const echappe = echapperHtml(paragraphe).replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`);
      return `<p>${echappe.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
  return { sujet: remplacer(gabarit.sujet, variables), texte, html };
}

/** Lien absolu vers une page du client ; le jeton est dans le FRAGMENT (`#jeton=…`), qui n'est jamais envoyé au serveur ni aux journaux du proxy. */
function lien(baseUrl: string, chemin: string, jeton?: string): string {
  const url = new URL(chemin, baseUrl);
  if (jeton !== undefined) url.hash = `jeton=${jeton}`;
  return url.toString();
}

/** Gabarit à lien secret : la table de jetons concernée, la page du client, la validité (qui part de l'ENVOI) et l'âge maximal d'une demande encore envoyable. */
export interface GabaritAJeton {
  readonly nature: 'verification' | 'reinitialisation';
  readonly chemin: string;
  readonly validiteMs: number;
  /** Au-delà, la demande est périmée : on n'envoie pas un lien pour une demande qui a dormi (Brevo en panne, clé absente…). */
  readonly delaiRemiseMs: number;
}

export const GABARITS_A_JETON: Readonly<Record<string, GabaritAJeton>> = {
  verification_email: { nature: 'verification', chemin: '/verification-email', validiteMs: JOUR_MS, delaiRemiseMs: JOUR_MS },
  // Les réessais de la file s'étalent sur ~2 h 30 avant le report de 12 h : 3 h couvrent une panne passagère, pas un oubli de configuration.
  reinitialisation_mot_de_passe: { nature: 'reinitialisation', chemin: '/reinitialisation', validiteMs: HEURE_MS, delaiRemiseMs: 3 * HEURE_MS },
};

/** Lien du message sortant pour ce gabarit, jeton en clair dans le fragment. */
export function lienAvecJeton(baseUrl: string, gabarit: GabaritAJeton, jeton: string): string {
  return lien(baseUrl, gabarit.chemin, jeton);
}

const schemaPayloadJeton = z.object({ jeton_id: z.string().min(1) });

/** Identifiant de la ligne de jeton portée par un e-mail de la file. */
export function jetonIdDuPayload(payloadJson: string): string {
  try {
    return schemaPayloadJeton.parse(JSON.parse(payloadJson)).jeton_id;
  } catch {
    throw new ErreurGabarit('Identifiant de jeton absent ou illisible dans la file.');
  }
}

export function emailVerification(to: string, nom: string, jetonId: string): EmailAEnfiler {
  return { to, templateKey: 'verification_email', payload: { nom, jeton_id: jetonId } };
}

export function emailReinitialisation(to: string, nom: string, jetonId: string): EmailAEnfiler {
  return { to, templateKey: 'reinitialisation_mot_de_passe', payload: { nom, jeton_id: jetonId } };
}

export function emailCompteExistant(baseUrl: string, to: string, nom: string): EmailAEnfiler {
  return { to, templateKey: 'compte_existant', payload: { nom, lien: lien(baseUrl, '/connexion') } };
}
