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

/** `action` : libellé du bouton. Absent, le lien reste un lien dans le corps. */
const schemaGabarit = z.object({ sujet: z.string(), texte: z.string(), action: z.string().optional() });
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

// --- Mise en page HTML ------------------------------------------------------------------------------
//
// Un e-mail n'est pas une page web : pas de feuille de style externe, pas de flexbox, pas de grille. Les
// clients de messagerie (Outlook en tête) découpent le HTML, ignorent `<style>` et ne comprennent que des
// tableaux et des styles en ligne. D'où la mise en page ci-dessous, volontairement archaïque.
//
// Le texte brut reste la source de vérité : le HTML en est dérivé, jamais rédigé à part. Un gabarit modifié
// ne peut donc pas voir ses deux versions diverger — et le texte brut compte dans la note anti-spam.

const PRIMAIRE = '#4338ca';
const TEXTE = '#0f172a';
const TEXTE_DOUX = '#475569';
const FOND = '#f1f5f9';
const BORDURE = '#e2e8f0';
const POLICE = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Un paragraphe qui n'est QU'une URL : il devient le bouton d'action. */
const SEUL_LIEN = /^https?:\/\/\S+$/;

/** Bouton « à l'épreuve des balles » : un tableau, parce qu'Outlook ignore les marges intérieures d'un `<a>`. */
function bouton(url: string, libelle: string): string {
  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px auto;">',
    '<tr><td align="center" bgcolor="' + PRIMAIRE + '" style="border-radius:10px;">',
    `<a href="${url}" style="display:inline-block;padding:14px 28px;font-family:${POLICE};font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${echapperHtml(libelle)}</a>`,
    '</td></tr></table>',
  ].join('');
}

function paragraphe(contenu: string): string {
  return `<p style="margin:0 0 16px;font-family:${POLICE};font-size:16px;line-height:1.6;color:${TEXTE};">${contenu}</p>`;
}

/**
 * Enveloppe la carte dans la mise en page de marque : logo, contenu, pied.
 *
 * `preheader` est le texte d'aperçu affiché par les boîtes de réception à côté de l'objet. Caché dans le
 * message, il évite que l'aperçu reprenne « Bonjour Théo » pour les six gabarits.
 */
function enveloppe(corps: string, baseUrl: string, preheader: string, lienBrut: string | undefined): string {
  const logo = `${baseUrl.replace(/\/+$/, '')}/icons/logo.png`;
  const repli =
    lienBrut === undefined
      ? ''
      : `<p style="margin:0 0 16px;font-family:${POLICE};font-size:13px;line-height:1.6;color:${TEXTE_DOUX};">Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur :<br><span style="word-break:break-all;color:${PRIMAIRE};">${echapperHtml(lienBrut)}</span></p>`;
  return [
    '<!doctype html><html lang="fr"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">',
    `<title>${echapperHtml(textes.application)}</title></head>`,
    `<body style="margin:0;padding:0;background:${FOND};">`,
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${echapperHtml(preheader)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${FOND};padding:24px 12px;">`,
    '<tr><td align="center">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">',
    // En-tête : logo et nom de l'application.
    '<tr><td align="center" style="padding:8px 0 20px;">',
    `<img src="${logo}" width="48" height="48" alt="" style="display:block;border:0;border-radius:12px;">`,
    `<div style="margin-top:10px;font-family:${POLICE};font-size:20px;font-weight:700;color:${TEXTE};">${echapperHtml(textes.application)}</div>`,
    '</td></tr>',
    // La carte.
    `<tr><td style="background:#ffffff;border:1px solid ${BORDURE};border-radius:16px;padding:32px 28px;">`,
    corps,
    repli,
    '</td></tr>',
    // Pied.
    `<tr><td align="center" style="padding:20px 8px 8px;font-family:${POLICE};font-size:12px;line-height:1.6;color:${TEXTE_DOUX};">`,
    `${echapperHtml(textes.application)} — message automatique, inutile d'y répondre.`,
    '</td></tr>',
    '</table></td></tr></table></body></html>',
  ].join('\n');
}

/**
 * Rend un e-mail de la file : texte brut et HTML.
 *
 * Le HTML est DÉRIVÉ du texte, paragraphe par paragraphe. Un paragraphe qui n'est qu'une URL devient le
 * bouton d'action (libellé `action` du gabarit), et l'adresse est rappelée en toutes lettres plus bas : un
 * client de messagerie qui n'affiche pas les images ou refuse le bouton laisse quand même l'utilisateur agir.
 */
export function rendre(
  templateKey: string,
  payloadJson: string,
  _locale: string,
  complements: Readonly<Record<string, string>> = {},
  baseUrl = '',
): MessageRendu {
  const gabarit = textes.emails[templateKey];
  if (gabarit === undefined) throw new ErreurGabarit(`Gabarit d'e-mail inconnu : « ${templateKey} ».`);
  let variables: Record<string, string>;
  try {
    variables = { ...schemaVariables.parse(JSON.parse(payloadJson)), ...complements };
  } catch {
    throw new ErreurGabarit(`Variables illisibles pour le gabarit « ${templateKey} ».`);
  }
  const texte = remplacer(gabarit.texte, variables);
  const sujet = remplacer(gabarit.sujet, variables);

  const paragraphes = texte.split(/\n{2,}/);
  let lienBouton: string | undefined;
  const corps = paragraphes
    .map((p) => {
      const net = p.trim();
      if (gabarit.action !== undefined && SEUL_LIEN.test(net)) {
        lienBouton = net;
        return bouton(net, gabarit.action);
      }
      const echappe = echapperHtml(p).replace(
        /https?:\/\/[^\s<]+/g,
        (url) => `<a href="${url}" style="color:${PRIMAIRE};">${url}</a>`,
      );
      return paragraphe(echappe.replace(/\n/g, '<br>'));
    })
    .join('\n');

  // L'aperçu de la boîte de réception : la première phrase utile, et non « Bonjour X ».
  const preheader = paragraphes.find((p) => !SEUL_LIEN.test(p.trim()) && !/^Bonjour/.test(p.trim()))?.replace(/\s+/g, ' ').slice(0, 160) ?? sujet;

  return { sujet, texte, html: enveloppe(corps, baseUrl, preheader, lienBouton) };
}

/** Lien absolu vers une page du client ; le jeton est dans le FRAGMENT (`#jeton=…`), qui n'est jamais envoyé au serveur ni aux journaux du proxy. */
function lien(baseUrl: string, chemin: string, jeton?: string): string {
  const url = new URL(chemin, baseUrl);
  if (jeton !== undefined) url.hash = `jeton=${jeton}`;
  return url.toString();
}

/** Validité d'une invitation (modèle §3.4) : 14 jours. */
export const DUREE_INVITATION_MS = 14 * JOUR_MS;

/** Gabarit à lien secret : la table de jetons concernée, la page du client, la validité (qui part de l'ENVOI) et l'âge maximal d'une demande encore envoyable. */
export interface GabaritAJeton {
  readonly nature: 'verification' | 'reinitialisation' | 'invitation';
  readonly chemin: string;
  readonly validiteMs: number;
  /** Au-delà, la demande est périmée : on n'envoie pas un lien pour une demande qui a dormi (Brevo en panne, clé absente…). */
  readonly delaiRemiseMs: number;
}

export const GABARITS_A_JETON: Readonly<Record<string, GabaritAJeton>> = {
  verification_email: { nature: 'verification', chemin: '/verification-email', validiteMs: JOUR_MS, delaiRemiseMs: JOUR_MS },
  // Les réessais de la file s'étalent sur ~2 h 30 avant le report de 12 h : 3 h couvrent une panne passagère, pas un oubli de configuration.
  reinitialisation_mot_de_passe: { nature: 'reinitialisation', chemin: '/reinitialisation', validiteMs: HEURE_MS, delaiRemiseMs: 3 * HEURE_MS },
  // Invitation à un groupe : le lien vaut 14 jours à partir de l'ENVOI ; une demande vieille de plus de deux jours ne part plus.
  invitation_groupe: { nature: 'invitation', chemin: '/invitation', validiteMs: DUREE_INVITATION_MS, delaiRemiseMs: 2 * JOUR_MS },
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

const schemaPayloadInvitation = z.object({ groupe_id: z.string().min(1) });

/** Identifiant du groupe porté par un e-mail d'invitation de la file (la ligne d'invitation se retrouve par `jeton_id` ET ce groupe). */
export function groupeIdDuPayload(payloadJson: string): string {
  try {
    return schemaPayloadInvitation.parse(JSON.parse(payloadJson)).groupe_id;
  } catch {
    throw new ErreurGabarit("Identifiant de groupe absent ou illisible dans la file.");
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

export interface DonneesInvitation {
  readonly to: string;
  readonly invitant: string;
  readonly groupe: string;
  readonly groupeId: string;
  readonly message: string | null;
}

/** E-mail d'invitation : il ne porte que l'identifiant de la ligne d'invitation, le jeton naît à l'envoi. */
export function emailInvitation(donnees: DonneesInvitation, invitationId: string): EmailAEnfiler {
  const mot = donnees.message === null ? '' : `\n\nSon message : « ${donnees.message} »`;
  return {
    to: donnees.to,
    templateKey: 'invitation_groupe',
    payload: { invitant: donnees.invitant, groupe: donnees.groupe, groupe_id: donnees.groupeId, mot, jeton_id: invitationId },
  };
}
