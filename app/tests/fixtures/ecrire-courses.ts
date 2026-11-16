import { fermer, ouvrirEtMigrer } from '../../server/db/migrate.js';
import { creerArticle, definirFait, definirPreneur, deplacerArticle } from '../../server/db/queries/listes.js';
import { creerScope } from '../../server/db/scope.js';

// Un PROCESSUS d'écriture sur la liste de courses, pour le test de concurrence réelle (listes-concurrence.test.ts) : sa propre connexion
// SQLite au même fichier, donc de vraies écritures concurrentes (le verrou d'écriture de SQLite, `busy_timeout`, pas l'ordonnancement d'un
// seul processus). Il annonce « pret » sur la sortie standard, puis attend « go » sur l'entrée standard : le test ne lâche les processus que lorsque TOUS sont prêts, quel que
// soit le temps que met chacun à charger tsx et le code (une barrière horaire fixe ferait partir les lents après les autres, et le test passerait sans rien prouver). Alors, pour chaque article de la liste :
//   1. tente de le PRENDRE (tous les processus se disputent les mêmes articles) ;
//   2. coche les articles qu'il a gagnés ;
// puis AJOUTE des articles et en DÉPLACE (lecture puis écriture dans une même transaction : le cas où un verrou différé échouerait).
// Sortie : une ligne JSON { gagnes, perdus, ajoutes, deplaces, erreurs }. Toute exception est rapportée, jamais avalée.
// `articles` : les articles D'ORIGINE, donnés par le test (un processus plus rapide ajoute déjà les siens : relire la liste ferait disputer
// aussi ces articles-là, ce qui fausserait le décompte des gagnants).
// Usage : node --import tsx ecrire-courses.ts <base.sqlite> <userId> <groupId> <listeId> <ajouts> <article,article,…>
const [chemin, userId, groupId, listeId, ajouts, articles] = process.argv.slice(2);
if (chemin === undefined || userId === undefined || groupId === undefined || listeId === undefined || ajouts === undefined || articles === undefined) {
  console.error('usage : ecrire-courses.ts <base> <userId> <groupId> <listeId> <ajouts> <articles>');
  process.exit(2);
}

const base = ouvrirEtMigrer(chemin);
const scope = creerScope(base, userId, groupId);
const resultat = { gagnes: [] as string[], perdus: [] as string[], ajoutes: [] as string[], deplaces: 0, erreurs: [] as string[] };
const maintenant = '2026-11-15T12:00:00Z';

console.log('pret');
await new Promise<void>((reprendre) => {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (morceau: string) => {
    if (morceau.includes('go')) reprendre();
  });
});
process.stdin.pause();

const tenter = (nom: string, action: () => void): void => {
  try {
    action();
  } catch (erreur) {
    resultat.erreurs.push(`${nom} : ${erreur instanceof Error ? `${erreur.message} (${String((erreur as { code?: unknown }).code)})` : String(erreur)}`);
  }
};

for (const id of articles.split(',')) {
  tenter(`prendre ${id}`, () => {
    const r = definirPreneur(scope, listeId, id, true, maintenant);
    if (r.etat === 'ok' && r.change) resultat.gagnes.push(id);
    else if (r.etat === 'deja_pris') resultat.perdus.push(id);
  });
}
for (const id of resultat.gagnes) tenter(`cocher ${id}`, () => void definirFait(scope, listeId, id, true, maintenant));
for (let i = 0; i < Number(ajouts); i++) {
  tenter(`ajouter ${String(i)}`, () => {
    const id = creerArticle(scope, listeId, { label: `Ajout ${userId.slice(-6)}-${String(i)}`, quantity: null });
    if (id === undefined) throw new Error('liste pleine');
    resultat.ajoutes.push(id);
  });
  tenter(`déplacer ${String(i)}`, () => {
    const dernier = resultat.ajoutes.at(-1);
    if (dernier !== undefined && deplacerArticle(scope, listeId, dernier, null) === 'deplace') resultat.deplaces += 1;
  });
}

fermer(base);
console.log(JSON.stringify(resultat));
