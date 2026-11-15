import { z } from 'zod';
import { HEURE_MS, MINUTE_MS, plus, versInstant } from '../domain/instant.js';
import { empreinteJeton, nouveauJeton } from '../domain/jetons.js';
import type { Base } from '../db/base.js';
import { armerJetonEnvoi } from '../db/queries/comptes.js';
import { marquerEmailEchec, marquerEmailEnvoye, reserverEmailsDus, type EmailDu } from '../db/queries/transverse.js';
import { ErreurGabarit, GABARITS_A_JETON, jetonIdDuPayload, lienAvecJeton, rendre, type MessageRendu } from './emails.js';

// Remise de la file `email_outbox` à l'API transactionnelle de Brevo (architecture §7.3). Rien n'est
// envoyé dans le cycle d'une requête HTTP : les routes écrivent dans la file, `remettreFile` (appelée
// toutes les 30 s par services/taches.ts) l'écoule. Brevo est un transporteur, remplaçable : tout le
// reste ne connaît que l'interface `Transporteur`.

export interface MessageSortant extends MessageRendu {
  readonly to: string;
}

export interface Transporteur {
  /** Remet un message. Rejette par une `ErreurTransport` : la file décide quoi faire de l'échec. */
  readonly envoyer: (message: MessageSortant) => Promise<{ readonly messageId: string | null }>;
}

/**
 * Échec de remise. `definitif` : inutile de réessayer (requête refusée telle quelle). `configuration` : panne de
 * NOTRE configuration (clé d'API refusée) — l'e-mail attend le rétablissement sans consommer ses essais.
 */
export class ErreurTransport extends Error {
  constructor(
    message: string,
    public readonly definitif: boolean,
    public readonly configuration = false,
  ) {
    super(message);
    this.name = 'ErreurTransport';
  }
}

export interface OptionsBrevo {
  readonly apiKey: string;
  readonly expediteurEmail: string;
  readonly expediteurNom: string;
  /** Racine de l'API (`https://api.brevo.com/v3`). */
  readonly urlApi: string;
  /** Délai maximal d'un appel. */
  readonly delaiMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DELAI_DEFAUT_MS = 10_000;
const reponseBrevo = z.object({ messageId: z.string().optional() });

export function creerTransporteurBrevo(options: OptionsBrevo): Transporteur {
  const appeler = options.fetchImpl ?? fetch;
  const url = `${options.urlApi.replace(/\/+$/, '')}/smtp/email`;
  return {
    async envoyer(message) {
      let reponse: Response;
      try {
        reponse = await appeler(url, {
          method: 'POST',
          headers: { 'api-key': options.apiKey, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            sender: { email: options.expediteurEmail, name: options.expediteurNom },
            to: [{ email: message.to }],
            subject: message.sujet,
            textContent: message.texte,
            htmlContent: message.html,
          }),
          signal: AbortSignal.timeout(options.delaiMs ?? DELAI_DEFAUT_MS),
        });
      } catch (erreur) {
        // Jamais le message de l'erreur brute : il pourrait contenir l'URL ou des en-têtes. Un libellé fixe suffit au diagnostic.
        const delai = erreur instanceof Error && (erreur.name === 'TimeoutError' || erreur.name === 'AbortError');
        throw new ErreurTransport(delai ? 'délai dépassé' : 'réseau indisponible', false);
      }
      if (!reponse.ok) {
        await reponse.body?.cancel();
        // 400 : requête invalide (adresse refusée…) — la rejouer ne changera rien. 401/403 : clé révoquée ou
        // droits retirés, une panne de configuration qui n'a rien à voir avec cet e-mail (il ne consomme pas ses
        // essais et repart au rétablissement). Le reste (429, 5xx) se répare côté Brevo : report exponentiel.
        throw new ErreurTransport(
          `Brevo a répondu ${String(reponse.status)}`,
          reponse.status === 400,
          reponse.status === 401 || reponse.status === 403,
        );
      }
      const corps = reponseBrevo.safeParse(await reponse.json().catch(() => ({})));
      return { messageId: corps.success ? (corps.data.messageId ?? null) : null };
    },
  };
}

/** Report exponentiel (architecture §7.3) : 1 min, 5 min, 25 min, 2 h, 12 h ; au 6e échec, l'e-mail est abandonné. */
export const REPORTS_MS: readonly number[] = [MINUTE_MS, 5 * MINUTE_MS, 25 * MINUTE_MS, 2 * HEURE_MS, 12 * HEURE_MS];
export const ESSAIS_MAX = REPORTS_MS.length + 1;
/** Durée pendant laquelle un e-mail pris en charge n'est pas repris par une autre remise (au-delà du délai d'un appel). */
const BAIL_MS = 2 * MINUTE_MS;
/** Nouvelle tentative après une panne de configuration (clé refusée) : régulière, sans escalade ni plafond d'essais. */
export const REPORT_CONFIGURATION_MS = 15 * MINUTE_MS;
const LOT = 20;

export interface BilanRemise {
  readonly envoyes: number;
  readonly reportes: number;
  readonly abandonnes: number;
  readonly definitifs: number;
}

/** Remet un lot d'e-mails dus. Les échecs sont enregistrés dans la file ; seule une panne de la base remonte. */
export async function remettreFile(base: Base, transporteur: Transporteur, maintenant: Date, baseUrl: string): Promise<BilanRemise> {
  const dus = reserverEmailsDus(base, versInstant(maintenant), versInstant(plus(maintenant, BAIL_MS)), LOT);
  let envoyes = 0;
  let reportes = 0;
  let abandonnes = 0;
  let definitifs = 0;
  for (const email of dus) {
    const instant = maintenant;
    const issue = await tenter(base, transporteur, email, instant, baseUrl);
    if (issue.type === 'envoye') {
      marquerEmailEnvoye(base, email.id, issue.messageId, versInstant(instant));
      envoyes++;
    } else if (issue.definitif) {
      marquerEmailEchec(base, email.id, 'failed', versInstant(instant), issue.erreur);
      definitifs++;
    } else if (issue.configuration) {
      marquerEmailEchec(base, email.id, 'pending', versInstant(plus(instant, REPORT_CONFIGURATION_MS)), issue.erreur, false);
      reportes++;
    } else if (email.attempts + 1 >= ESSAIS_MAX) {
      marquerEmailEchec(base, email.id, 'abandoned', versInstant(instant), issue.erreur);
      abandonnes++;
    } else {
      const report = REPORTS_MS[email.attempts] ?? REPORTS_MS[REPORTS_MS.length - 1] ?? MINUTE_MS;
      marquerEmailEchec(base, email.id, 'pending', versInstant(plus(instant, report)), issue.erreur);
      reportes++;
    }
  }
  return { envoyes, reportes, abandonnes, definitifs };
}

type Issue =
  | { readonly type: 'envoye'; readonly messageId: string | null }
  | { readonly type: 'echec'; readonly definitif: boolean; readonly configuration: boolean; readonly erreur: string };

/**
 * Prépare puis remet un e-mail. Pour un gabarit à lien secret, le jeton est tiré ICI : son empreinte est écrite sur
 * la ligne de jeton avec une validité qui part de cet instant, le clair n'existe que dans le message sortant. Si la
 * ligne est déjà utilisée ou remplacée, ou si la demande est trop ancienne, rien n'est posté (échec définitif).
 */
async function tenter(base: Base, transporteur: Transporteur, email: EmailDu, maintenant: Date, baseUrl: string): Promise<Issue> {
  let message: MessageRendu;
  try {
    const gabarit = GABARITS_A_JETON[email.template_key];
    let complements: Record<string, string> = {};
    if (gabarit !== undefined) {
      const jeton = nouveauJeton();
      const arme = armerJetonEnvoi(
        base,
        gabarit.nature,
        jetonIdDuPayload(email.payload_json),
        empreinteJeton(jeton),
        versInstant(plus(maintenant, gabarit.validiteMs)),
        versInstant(plus(maintenant, -gabarit.delaiRemiseMs)),
      );
      if (!arme) {
        return { type: 'echec', definitif: true, configuration: false, erreur: 'Lien périmé ou déjà remplacé : e-mail non envoyé.' };
      }
      complements = { lien: lienAvecJeton(baseUrl, gabarit, jeton) };
    }
    message = rendre(email.template_key, email.payload_json, email.locale, complements);
  } catch (erreur) {
    if (erreur instanceof ErreurGabarit) return { type: 'echec', definitif: true, configuration: false, erreur: erreur.message };
    throw erreur;
  }
  try {
    const { messageId } = await transporteur.envoyer({ ...message, to: email.to_email });
    return { type: 'envoye', messageId };
  } catch (erreur) {
    if (erreur instanceof ErreurTransport) {
      return { type: 'echec', definitif: erreur.definitif, configuration: erreur.configuration, erreur: erreur.message };
    }
    throw erreur;
  }
}
