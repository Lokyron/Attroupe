import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

// Analyse syntaxique (compilateur TypeScript) du verrou n° 5 : seul app/server/db/ parle à la base.
// Contrairement à une expression régulière, on compare le chemin RÉSOLU du module à
// db/connection.ts, donc `db/./connection`, `db//connection` ou un chemin détourné n'y échappent pas.

export const RACINE_APP = join(import.meta.dirname, '..', '..');
export const DOSSIER_DB = join(RACINE_APP, 'server', 'db') + sep;
const CONNECTION_SANS_EXTENSION = join(RACINE_APP, 'server', 'db', 'connection');
/** Seul fichier de test autorisé à importer db/connection (voir eslint.config.js) : il rend la vraie connexion aux tests. */
export const FIXTURE_BRUT = join(RACINE_APP, 'tests', 'fixtures', 'brut.ts');

// --- Pouvoirs de db/ (lot 5) : la résolution de chemin fait foi, pas le texte du spécificateur ---------------------------------------
// La règle ESLint compare le TEXTE (`db/queries/../scope.js` lui échappait). Ce filet compare le chemin RÉSOLU, avec pour chaque module
// puissant la liste NOMINATIVE des fichiers hors de db/ qui ont le droit de s'en servir. Il ne regarde que le code de production : les
// tests amorcent et inspectent la base à la main (eslint.config.js les exempte, sauf connection).
const SERVEUR = join(RACINE_APP, 'server');
const MIDDLEWARE = join(SERVEUR, 'http', 'middleware');
const sansExtension = (chemin: string): string => chemin.replace(EXTENSION, '');
const MODULE_SQL = join(SERVEUR, 'db', 'sql');
const MODULE_MIGRATE = join(SERVEUR, 'db', 'migrate');
const MODULE_SCOPE = join(SERVEUR, 'db', 'scope');
const MODULE_PORTEE = join(SERVEUR, 'db', 'portee-utilisateur');
const TRANSVERSE = join(SERVEUR, 'db', 'queries', 'transverse');
const INTERGICIEL_APPARTENANCE = join(MIDDLEWARE, 'appartenance');
const INTERGICIEL_SESSION = join(MIDDLEWARE, 'session');
const INTERGICIEL_JETON_FLUX = join(MIDDLEWARE, 'jeton-flux');
const INDEX_SERVEUR = join(SERVEUR, 'index');

/** Un module puissant : ce qui en sort est réservé ; `ouvert` : toute l'application y a droit (types, constantes). */
interface Pouvoir {
  readonly module: string;
  /** Noms d'export qui fabriquent une portée ou rendent la base : réservés aux fichiers nommés (hors db/, qui est libre). */
  readonly reserves: ReadonlyArray<{ readonly noms: readonly string[]; readonly fichiers: readonly string[]; readonly dansDbLibre: boolean; readonly raison: string }>;
}

const POUVOIRS: readonly Pouvoir[] = [
  { module: MODULE_SQL, reserves: [{ noms: ['*'], fichiers: [], dansDbLibre: true, raison: 'db/sql (preparer) n’est importable que depuis app/server/db/' }] },
  { module: MODULE_MIGRATE, reserves: [{ noms: ['*'], fichiers: [INDEX_SERVEUR], dansDbLibre: true, raison: 'db/migrate n’est importable que depuis app/server/index.ts' }] },
  {
    module: MODULE_SCOPE,
    reserves: [
      { noms: ['creerScope'], fichiers: [INTERGICIEL_APPARTENANCE, INTERGICIEL_JETON_FLUX], dansDbLibre: true, raison: 'creerScope n’est appelable que depuis les intergiciels appartenance.ts et jeton-flux.ts' },
      { noms: ['baseDeScope'], fichiers: [], dansDbLibre: true, raison: 'baseDeScope est réservé à app/server/db/' },
    ],
  },
  {
    module: MODULE_PORTEE,
    reserves: [
      { noms: ['creerPorteeUtilisateur'], fichiers: [INTERGICIEL_APPARTENANCE, INTERGICIEL_SESSION, INTERGICIEL_JETON_FLUX], dansDbLibre: true, raison: 'creerPorteeUtilisateur n’est appelable que depuis les intergiciels appartenance.ts, session.ts et jeton-flux.ts' },
      { noms: ['baseDe'], fichiers: [], dansDbLibre: true, raison: 'baseDe est réservé à app/server/db/' },
    ],
  },
];

/** `preparerTransverse` (canal transverse) : même dans db/, un seul fichier. */
const NOM_TRANSVERSE = 'preparerTransverse';

/** Noms importés par une déclaration, ou `'*'` (espace de noms, import dynamique, require, `export *`) : tout le module est atteint. */
type Noms = readonly string[];
const TOUT: Noms = ['*'];

const BIBLIOTHEQUES_SQL = /^(better-)?sqlite3?(\/|$)|^node:sqlite$/;
const EXTENSION = /\.(d\.)?[cm]?[jt]sx?$/;

const OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  allowJs: true,
};

/** Chemin de la cible d'un spécificateur, sans extension ; le spécificateur lui-même s'il est « nu ». */
function cible(specificateur: string, fichier: string): string {
  const resolu = ts.resolveModuleName(specificateur, fichier, OPTIONS, ts.sys).resolvedModule;
  if (resolu !== undefined) return resolu.resolvedFileName.replace(EXTENSION, '');
  // Fichier pas encore écrit (connection.ts arrive au lot 1) : on résout le chemin à la main.
  if (specificateur.startsWith('.') || specificateur.startsWith('/')) {
    return resolve(dirname(fichier), specificateur).replace(EXTENSION, '');
  }
  return specificateur;
}

function estBibliothequeSql(specificateur: string, resolu: string): boolean {
  return BIBLIOTHEQUES_SQL.test(specificateur) || /[\\/]node_modules[\\/](better-)?sqlite3?[\\/]/.test(resolu);
}

/** Retourne les violations du verrou dans `code`, vu comme le contenu de `fichier` (chemin absolu). */
export function violationsDuVerrou(code: string, fichier: string): string[] {
  const source = ts.createSourceFile(fichier, code, ts.ScriptTarget.ES2023, true);
  const dansDb = fichier.startsWith(DOSSIER_DB);
  const estConnection = resolve(fichier).replace(EXTENSION, '') === CONNECTION_SANS_EXTENSION;
  const estFixtureBrut = resolve(fichier) === FIXTURE_BRUT;
  const violations: string[] = [];

  const signaler = (noeud: ts.Node, message: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(noeud.getStart(source));
    violations.push(`ligne ${line + 1} : ${message}`);
  };

  const sansExt = sansExtension(resolve(fichier));
  const enProduction = !resolve(fichier).startsWith(join(RACINE_APP, 'tests') + sep);
  const dansLeDossierDb = resolve(fichier).startsWith(DOSSIER_DB);

  /** Les pouvoirs de db/ : le chemin RÉSOLU de la cible décide, quel que soit le texte du spécificateur. */
  const verifierPouvoirs = (noeud: ts.Node, specificateur: string, resolu: string, noms: Noms, reexport: boolean): void => {
    if (!enProduction) return;
    for (const pouvoir of POUVOIRS) {
      if (resolu !== pouvoir.module) continue;
      if (reexport) {
        signaler(noeud, `« ${specificateur} » mène à ${relative(RACINE_APP, pouvoir.module)} : ré-export interdit (fichier-baril)`);
        continue;
      }
      for (const reserve of pouvoir.reserves) {
        const touche = noms.includes('*') || noms.some((n) => reserve.noms.includes(n) || reserve.noms.includes('*'));
        if (!touche) continue;
        const permis = (reserve.dansDbLibre && dansLeDossierDb) || reserve.fichiers.includes(sansExt);
        // Un module entier (espace de noms, import dynamique) atteint aussi les noms des AUTRES réserves : seul un fichier permis pour TOUTES l'obtient.
        if (!permis) signaler(noeud, `« ${specificateur} » mène à ${relative(RACINE_APP, pouvoir.module)} : ${reserve.raison}`);
      }
      // Le canal transverse : le nom, ou tout le module, hors du seul fichier qui le porte.
      if (resolu === MODULE_SQL && (noms.includes('*') || noms.includes(NOM_TRANSVERSE)) && dansLeDossierDb && sansExt !== TRANSVERSE && sansExt !== MODULE_SQL) {
        signaler(noeud, `« ${specificateur} » mène à db/sql : preparerTransverse n’est importable que depuis db/queries/transverse.ts`);
      }
    }
  };

  const verifier = (noeud: ts.Node, specificateur: string, reexport: boolean, noms: Noms = TOUT): void => {
    const resolu = cible(specificateur, fichier);
    verifierPouvoirs(noeud, specificateur, resolu, noms, reexport);
    if (estBibliothequeSql(specificateur, resolu) && !estConnection) {
      signaler(noeud, `bibliothèque SQLite « ${specificateur} » hors de db/connection.ts`);
    }
    if (resolu === CONNECTION_SANS_EXTENSION && (!dansDb || reexport) && !(estFixtureBrut && !reexport)) {
      signaler(noeud, `« ${specificateur} » mène à db/connection${reexport ? ' (ré-export interdit)' : ''}`);
    }
  };

  const litteral = (noeud: ts.Expression | undefined): string | undefined =>
    noeud !== undefined && (ts.isStringLiteral(noeud) || ts.isNoSubstitutionTemplateLiteral(noeud))
      ? noeud.text
      : undefined;

  const parcourir = (noeud: ts.Node): void => {
    if (ts.isImportDeclaration(noeud) && ts.isStringLiteral(noeud.moduleSpecifier)) {
      const clause = noeud.importClause;
      const liaisons = clause?.namedBindings;
      // Import de types seulement : rien n'existe à l'exécution, donc aucun pouvoir n'est pris. Sinon, les noms réellement importés ;
      // un espace de noms (`import * as x`) ou un import par défaut atteint tout le module.
      const noms: Noms =
        clause?.isTypeOnly === true
          ? []
          : liaisons !== undefined && ts.isNamedImports(liaisons)
            ? liaisons.elements.filter((el) => !el.isTypeOnly).map((el) => (el.propertyName ?? el.name).text)
            : TOUT;
      verifier(noeud, noeud.moduleSpecifier.text, false, clause === undefined ? TOUT : noms);
    } else if (ts.isExportDeclaration(noeud) && noeud.moduleSpecifier !== undefined) {
      const spec = litteral(noeud.moduleSpecifier);
      if (spec !== undefined) verifier(noeud, spec, true);
    } else if (
      ts.isImportEqualsDeclaration(noeud) &&
      ts.isExternalModuleReference(noeud.moduleReference)
    ) {
      const spec = litteral(noeud.moduleReference.expression);
      if (spec === undefined) signaler(noeud, 'import = require() non littéral');
      else verifier(noeud, spec, false);
    } else if (ts.isCallExpression(noeud)) {
      const appel = noeud.expression;
      const estImport = appel.kind === ts.SyntaxKind.ImportKeyword;
      const estRequire = ts.isIdentifier(appel) && appel.text === 'require';
      if (estImport || estRequire) {
        const spec = litteral(noeud.arguments[0]);
        if (spec === undefined) signaler(noeud, `${estImport ? 'import()' : 'require'} non littéral`);
        else verifier(noeud, spec, false);
      } else if (
        (ts.isIdentifier(appel) && appel.text === 'createRequire') ||
        (ts.isPropertyAccessExpression(appel) && appel.name.text === 'createRequire')
      ) {
        signaler(noeud, 'createRequire contourne l’analyse des imports');
      }
    }
    ts.forEachChild(noeud, parcourir);
  };

  parcourir(source);
  return violations;
}
