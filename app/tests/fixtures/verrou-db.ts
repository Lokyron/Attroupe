import { dirname, join, resolve, sep } from 'node:path';
import ts from 'typescript';

// Analyse syntaxique (compilateur TypeScript) du verrou n° 5 : seul app/server/db/ parle à la base.
// Contrairement à une expression régulière, on compare le chemin RÉSOLU du module à
// db/connection.ts, donc `db/./connection`, `db//connection` ou un chemin détourné n'y échappent pas.

export const RACINE_APP = join(import.meta.dirname, '..', '..');
export const DOSSIER_DB = join(RACINE_APP, 'server', 'db') + sep;
const CONNECTION_SANS_EXTENSION = join(RACINE_APP, 'server', 'db', 'connection');
/** Seul fichier de test autorisé à importer db/connection (voir eslint.config.js) : il rend la vraie connexion aux tests. */
export const FIXTURE_BRUT = join(RACINE_APP, 'tests', 'fixtures', 'brut.ts');
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

  const verifier = (noeud: ts.Node, specificateur: string, reexport: boolean): void => {
    const resolu = cible(specificateur, fichier);
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
      verifier(noeud, noeud.moduleSpecifier.text, false);
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
