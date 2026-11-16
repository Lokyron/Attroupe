import type { Request, RequestHandler } from 'express';
import { noterUsage, jetonParEmpreinte, type JetonResolu } from '../../db/queries/flux.js';
import { creerPorteeUtilisateur, ErreurCompte, type PorteeUtilisateur } from '../../db/portee-utilisateur.js';
import { mesGroupes } from '../../db/queries/transverse.js';
import { creerScope, ErreurAppartenance, type GroupScope } from '../../db/scope.js';
import { versInstant } from '../../domain/instant.js';
import { empreinteJeton, FORME_JETON_FLUX } from '../../domain/jetons.js';
import type { CleCadence } from '../../services/cadence.js';
import type { Contexte } from '../contexte.js';
import { ErreurHttp } from '../erreurs.js';
import { declarerIntergiciel } from '../montage.js';
import { adresseClient, reseauClient } from './cadence.js';

// Verrou n° 3, TROISIÈME chemin d'entrée (architecture §4 et §7.1) : le flux iCal n'a ni cookie ni groupe dans l'URL, et il sert les
// événements de PLUSIEURS groupes. La règle ne change pas pour autant : aucune lecture de données métier sans `GroupScope`. Cet
// intergiciel est donc, avec appartenance.ts et session.ts, le seul fichier qui fabrique une portée ; il fabrique les deux :
//  - la `PorteeUtilisateur` du compte désigné par le jeton ;
//  - UN `GroupScope` par groupe où ce compte a une appartenance ACTIVE, relue en base à CHAQUE requête (`creerScope` ne croit rien) :
//    le jeton d'un membre retiré ne donne donc plus rien du groupe quitté.
// Le jeton ne désigne que le compte et une restriction éventuelle : il n'accorde aucun groupe.
//
// Toute erreur d'accès — jeton mal formé, inconnu, révoqué, compte suspendu — est la MÊME réponse (404 `flux.introuvable`) : rien
// ne dit lequel des cas s'est produit.

export interface AccesFlux {
  readonly jeton: JetonResolu;
  readonly portee: PorteeUtilisateur;
  /** Un scope par groupe lisible par ce jeton (vide : l'appartenance a pris fin). */
  readonly scopes: readonly GroupScope[];
  readonly maintenant: Date;
  /** `sha256` du jeton : entre dans l'`ETag` sans révéler le secret. */
  readonly empreinte: string;
}

const ACCES = new WeakMap<Request, AccesFlux>();

/** L'accès prouvé de la requête ; erreur de programmation si l'intergiciel n'a pas été monté. */
export function accesFlux(req: Request): AccesFlux {
  const acces = ACCES.get(req);
  if (acces === undefined) throw new Error('Aucun accès de flux sur la requête : jetonFlux doit être monté sur /ical.');
  return acces;
}

function introuvable(): ErreurHttp {
  return new ErreurHttp(404, 'flux.introuvable');
}

/** En-tête User-Agent réduit à du texte imprimable et borné : il est écrit en base (`last_user_agent`). */
export function agentNormalise(entete: string | undefined): string | null {
  if (entete === undefined) return null;
  const propre = [...entete].filter((c) => (c.codePointAt(0) ?? 0) >= 0x20 && c.codePointAt(0) !== 0x7f).join('').trim().slice(0, 255);
  return propre === '' ? null : propre;
}

/** Scopes des groupes lisibles : tous ceux où l'appartenance est active, ou le seul groupe du jeton s'il est restreint et toujours actif. */
function scopesDe(contexte: Contexte, portee: PorteeUtilisateur, jeton: JetonResolu): GroupScope[] {
  const ids = jeton.group_id === null ? mesGroupes(portee).map((g) => g.group_id) : [jeton.group_id];
  const scopes: GroupScope[] = [];
  for (const groupId of ids) {
    try {
      const scope = creerScope(contexte.base, portee.userId, groupId);
      // Groupe supprimé (marquage) : il n'existe plus pour personne.
      if (scope.groupe() !== undefined) scopes.push(scope);
    } catch (erreur) {
      if (!(erreur instanceof ErreurAppartenance)) throw erreur;
    }
  }
  return scopes;
}

/** À monter sur le routeur de `/ical`. Pose l'`AccesFlux`, ou répond 404 (jeton refusé) / 429 (cadence). */
export function jetonFlux(contexte: Contexte): RequestHandler {
  return declarerIntergiciel('garde', (req, _res, next) => {
    try {
      const brut = req.params['jeton'];
      const maintenant = contexte.horloge();
      const regles = contexte.regles.flux;

      // L'IP d'abord : elle borne le balayage de jetons inconnus, qui ne créent aucune clé de jeton.
      const verifs: CleCadence[] = [{ cle: `flux:ip:${adresseClient(req)}`, regle: regles.ip }];
      const reseau = reseauClient(req);
      if (reseau !== undefined) verifs.push({ cle: `flux:reseau:${reseau}`, regle: regles.reseau });
      const parIp = contexte.limiteur.tenter(verifs);
      if (!parIp.autorise) throw new ErreurHttp(429, 'cadence.depassee', parIp.retryApresSecondes);

      if (typeof brut !== 'string' || !FORME_JETON_FLUX.test(brut)) throw introuvable();
      const empreinte = empreinteJeton(brut);
      const jeton = jetonParEmpreinte(contexte.base, empreinte);
      if (jeton === undefined || jeton.revoked_at !== null) throw introuvable();
      let portee: PorteeUtilisateur;
      try {
        portee = creerPorteeUtilisateur(contexte.base, jeton.user_id);
      } catch (erreur) {
        if (erreur instanceof ErreurCompte) throw introuvable(); // compte suspendu ou anonymisé depuis
        throw erreur;
      }

      // La cadence du jeton, une fois celui-ci prouvé (sinon un inconnu créerait une clé par tentative).
      if (regles.jeton !== undefined) {
        const parJeton = contexte.limiteur.tenter([{ cle: `flux:jeton:${jeton.id}`, regle: regles.jeton }]);
        if (!parJeton.autorise) {
          contexte.journal.warn('cadence.depassee', { route: 'flux' });
          throw new ErreurHttp(429, 'cadence.depassee', parJeton.retryApresSecondes);
        }
      }

      noterUsage(portee, jeton.id, versInstant(maintenant), agentNormalise(req.get('user-agent')));
      ACCES.set(req, { jeton, portee, scopes: scopesDe(contexte, portee, jeton), maintenant, empreinte });
      next();
    } catch (erreur) {
      next(erreur);
    }
  });
}
