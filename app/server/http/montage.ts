import type { Express, RequestHandler, Router } from 'express';

// Montage des routeurs. Toute sous-application passe par `monter` : il retient le préfixe de chaque routeur, ce qui
// permet au test de complétude du registre de cloisonnement (tests/cloisonnement/registre.test.ts) de reconstituer le
// chemin complet de CHAQUE route à partir de la pile d'Express — qui, elle, ne garde pas les chemins de `use()`.
// Un routeur monté sans passer par ici est repéré par ce même test et fait échouer l'intégration continue.

const PREFIXES = new WeakMap<object, string>();

// Même principe pour les intergiciels : un `use()` qui n'est pas un routeur (un mandataire de médias, un gestionnaire quelconque)
// est un point d'entrée que le registre ne voit pas. Seuls ceux DÉCLARÉS ici sont connus ; le test de complétude signale tout autre.
//  - `transversal` : journal, CSRF, corps JSON, session, repli 404… — jamais sous `/api/groupes` ;
//  - `garde`       : refuse ou laisse passer une requête (session requise, appartenance au groupe) — admis partout.
export type GenreIntergiciel = 'transversal' | 'garde';
const INTERGICIELS = new WeakMap<object, GenreIntergiciel>();

/** Déclare `intergiciel` comme connu du registre, et le renvoie tel quel. */
export function declarerIntergiciel<T extends (...args: never[]) => unknown>(genre: GenreIntergiciel, intergiciel: T): T {
  INTERGICIELS.set(intergiciel, genre);
  return intergiciel;
}

/** Genre sous lequel cet intergiciel a été déclaré, ou `undefined` s'il ne l'a pas été. */
export function genreDIntergiciel(intergiciel: object): GenreIntergiciel | undefined {
  return INTERGICIELS.get(intergiciel);
}

/** Monte `routeur` sur `prefixe` de `parent`, derrière les gardes `avant` (dans l'ordre ; déclarées par ce montage). */
export function monter(parent: Express | Router, prefixe: string, routeur: Router, ...avant: RequestHandler[]): void {
  PREFIXES.set(routeur, prefixe);
  for (const garde of avant) declarerIntergiciel('garde', garde);
  // Express et Router n'ont pas la même signature de `use` : on lève l'ambiguïté sans conversion de type.
  if ('listen' in parent) parent.use(prefixe, ...avant, routeur);
  else parent.use(prefixe, ...avant, routeur);
}

/** Préfixe sous lequel ce routeur a été monté par `monter`, ou `undefined` s'il l'a été autrement. */
export function prefixeDeMontage(routeur: object): string | undefined {
  return PREFIXES.get(routeur);
}
