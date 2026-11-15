import type { Express, Router } from 'express';
import { genreDIntergiciel, prefixeDeMontage } from '../../server/http/montage.js';

// Extrait de l'application Express la liste RÉELLE de ses routes (méthode + chemin complet), sans rien demander à
// l'auteur de la route. Sert au test de complétude du registre de cloisonnement (architecture §8) : ajouter une
// route sans la déclarer au registre doit casser l'intégration continue.
//
// Express 5 ne retient pas le chemin d'un `use()` dans sa pile : les préfixes viennent de `monter` (http/montage.ts).
// Un routeur monté autrement est signalé, jamais ignoré : il cacherait des routes.
// Même exigence pour un `use()` qui n'est PAS un routeur (mandataire de médias, gestionnaire quelconque) : c'est un point d'entrée
// hors registre. Il est signalé, sauf s'il a été déclaré (`declarerIntergiciel`) : sous `/api/groupes`, seule une GARDE l'est ;
// ailleurs, un intergiciel transversal (journal, CSRF, JSON, session, repli 404…) l'est aussi.

type Couche = Router['stack'][number];

export interface RoutesExtraites {
  /** `GET /api/groupes/:groupId/membres`, triées. */
  readonly routes: readonly string[];
  /** Routeurs montés sans `monter`, et `use()` non-routeurs non déclarés : leurs routes ne sont pas visibles, donc la complétude ne peut pas être garantie. */
  readonly anomalies: readonly string[];
}

function joindre(prefixe: string, chemin: string): string {
  const complet = `${prefixe}/${chemin}`.replace(/\/+/g, '/');
  return complet.length > 1 ? complet.replace(/\/$/, '') : complet;
}

function estRouteur(handle: unknown): handle is Router {
  return typeof handle === 'function' && 'stack' in handle && Array.isArray(handle.stack);
}

/** Couches que la pile d'Express pose elle-même (analyse de la requête, enrichissement `req`/`res`). */
const COUCHES_EXPRESS = new Set(['query', 'expressInit']);

const SOUS_GROUPES = /^\/api\/groupes(\/|$)/;

export function extraireRoutes(app: Express): RoutesExtraites {
  const routes = new Set<string>();
  const anomalies: string[] = [];

  const parcourir = (pile: readonly Couche[], prefixe: string): void => {
    for (const couche of pile) {
      if (couche.route !== undefined) {
        const chemin = joindre(prefixe, String(couche.route.path));
        for (const sous of couche.route.stack) {
          // `app.all()` n'a pas de méthode propre : on le dit tel quel, le registre doit alors le déclarer.
          routes.add(`${sous.method === '' || sous.method === undefined ? 'ALL' : sous.method.toUpperCase()} ${chemin}`);
        }
      } else if (!estRouteur(couche.handle)) {
        const genre = genreDIntergiciel(couche.handle);
        const admis = genre === 'garde' || (genre === 'transversal' && !SOUS_GROUPES.test(prefixe)) || COUCHES_EXPRESS.has(couche.name);
        if (!admis) anomalies.push(`use() non routeur « ${couche.name} » ${genre === undefined ? 'non déclaré' : `déclaré « ${genre} » mais monté sous ${prefixe}`} (sous ${prefixe || '/'})`);
      } else {
        const montage = prefixeDeMontage(couche.handle);
        if (montage === undefined) {
          anomalies.push(`routeur « ${couche.name} » monté sans passer par monter() (sous ${prefixe || '/'})`);
        } else {
          parcourir(couche.handle.stack, joindre(prefixe, montage));
        }
      }
    }
  };

  parcourir(app.router.stack, '');
  return { routes: [...routes].sort(), anomalies };
}
