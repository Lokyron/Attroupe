import type { Request, RequestHandler } from 'express';
import type { CleCadence, NomCadence } from '../../services/cadence.js';
import type { Contexte } from '../contexte.js';
import { ErreurHttp } from '../erreurs.js';
import { authentification } from './session.js';

// Limitation de débit (architecture §5), par couple (adresse e-mail visée, adresse IP) ET, plus largement, par
// adresse e-mail seule, par IP, par réseau /48 (IPv6) et par compte (routes authentifiées) :
//  - le COUPLE est la limite de base : depuis son IP, un tiers qui martèle l'adresse d'un autre n'épuise que son
//    propre couple, donc ne peut pas bloquer le propriétaire qui se connecte depuis une autre adresse ;
//  - l'e-mail seul, beaucoup plus large, retient une attaque répartie sur de nombreuses adresses ;
//  - l'IP seule empêche de balayer tous les comptes depuis une adresse.
//
// L'adresse du client vient de `req.ip`, que Express calcule d'après ATTROUPE_TRUST_PROXY (nombre de proxys
// de confiance en amont). Si le port est joignable DIRECTEMENT (sans le proxy), un client peut forger
// `X-Forwarded-For` et changer d'adresse à chaque requête : les clés IP et couple ne le retiennent plus, mais la
// clé e-mail tient toujours (au prix de son seuil large), et le plafond de hachages simultanés
// (services/mot-de-passe.ts) borne le coût. Le compose publie donc le port sur 127.0.0.1 par défaut
// (ATTROUPE_BIND). Contrepartie assumée : un attaquant qui dispose de nombreuses adresses peut épuiser la clé
// e-mail d'un compte précis (déni de connexion à durée limitée) — d'où le report exponentiel plutôt qu'un
// blocage définitif, et le seuil large.
//
// Une requête refusée en 429 ne crée aucune clé (services/cadence.ts) ; une requête qui finit en 503 (file de
// hachage pleine : aucun mot de passe n'a été essayé) est remboursée.

/** Premiers groupes d'une IPv6, « :: » développé, sous la forme `xxxx:xxxx:…::/bits`. */
function prefixeIpv6(ipv6: string, groupesGardes: number): string {
  const [tete = '', queue] = ipv6.split('%')[0]?.split('::') ?? [''];
  const avant = tete === '' ? [] : tete.split(':');
  const apres = queue === undefined || queue === '' ? [] : queue.split(':');
  const manquants = queue === undefined ? 0 : Math.max(0, 8 - avant.length - apres.length);
  const groupes = [...avant, ...Array<string>(manquants).fill('0'), ...apres];
  return `${groupes.slice(0, groupesGardes).map((g) => g.toLowerCase().padStart(4, '0')).join(':')}::/${String(groupesGardes * 16)}`;
}

function adresseSansPrefixe(req: Request): string {
  return (req.ip ?? 'inconnue').replace(/^::ffff:/i, '');
}

/** Adresse du client, normalisée : IPv4 mappée en IPv6 ramenée à l'IPv4, IPv6 ramenée à son préfixe /64 (un abonné en possède 2^64). */
export function adresseClient(req: Request): string {
  const adresse = adresseSansPrefixe(req);
  return adresse.includes(':') ? prefixeIpv6(adresse, 4) : adresse;
}

/** Préfixe /48 du client s'il est en IPv6 (un abonné y choisit 2^16 préfixes /64), sinon `undefined`. */
export function reseauClient(req: Request): string | undefined {
  const adresse = adresseSansPrefixe(req);
  return adresse.includes(':') ? prefixeIpv6(adresse, 3) : undefined;
}

/** Adresse e-mail telle qu'utilisée comme clé (le corps n'est pas encore validé : tout ce qui n'est pas un texte est ignoré). */
export function emailDuCorps(req: Request): string | undefined {
  const corps: unknown = req.body;
  if (typeof corps !== 'object' || corps === null || !('email' in corps) || typeof corps.email !== 'string') return undefined;
  const email = corps.email.trim().toLowerCase();
  return email === '' ? undefined : email.slice(0, 254);
}

export function cleEmail(nom: NomCadence, email: string): string {
  return `${nom}:email:${email}`;
}

export function cleCouple(nom: NomCadence, email: string, adresse: string): string {
  return `${nom}:couple:${email}|${adresse}`;
}

/** À monter APRÈS la lecture du corps JSON (et, pour `compte`, après la garde de session). Refuse en 429 + `Retry-After` quand une clé est épuisée. */
export function cadence(contexte: Contexte, nom: NomCadence): RequestHandler {
  return (req, res, next) => {
    const regles = contexte.regles[nom];
    const adresse = adresseClient(req);
    const verifs: CleCadence[] = [{ cle: `${nom}:ip:${adresse}`, regle: regles.ip }];
    const reseau = reseauClient(req);
    if (reseau !== undefined) verifs.push({ cle: `${nom}:reseau:${reseau}`, regle: regles.reseau });
    if (regles.couple !== undefined || regles.email !== undefined) {
      const email = emailDuCorps(req);
      if (email !== undefined) {
        if (regles.couple !== undefined) verifs.push({ cle: cleCouple(nom, email, adresse), regle: regles.couple });
        if (regles.email !== undefined) verifs.push({ cle: cleEmail(nom, email), regle: regles.email });
      }
    }
    if (regles.compte !== undefined) {
      const auth = authentification(req);
      if (auth !== undefined) verifs.push({ cle: `${nom}:compte:${auth.portee.userId}`, regle: regles.compte });
    }
    const verdict = contexte.limiteur.tenter(verifs);
    if (verdict.autorise) {
      // 503 : la file de hachage était pleine, aucun essai n'a eu lieu — le légitime ne paie pas la saturation.
      res.once('finish', () => {
        if (res.statusCode === 503) verdict.rembourser();
      });
      next();
      return;
    }
    res.setHeader('Retry-After', String(verdict.retryApresSecondes));
    contexte.journal.warn('cadence.depassee', { route: nom });
    next(new ErreurHttp(429, 'cadence.depassee', verdict.retryApresSecondes));
  };
}
