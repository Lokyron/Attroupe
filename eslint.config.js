import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Verrous n° 2 et 5 du cloisonnement (architecture §4, « garde-fous automatiques ») : seul
// app/server/db/ parle à la base, et ses modules puissants n'ont que quelques clients légitimes.
// Les verrous raisonnent en motifs regex (et non en globs) pour résister aux écritures détournées :
// `db/./connection`, `db//connection`, sous-chemins…
const MESSAGE_VERROU_DB =
  "Interdit : « db/connection » n'est importable que depuis app/server/db/. " +
  'Passez par une fonction de db/queries/ (verrou n° 5, architecture §4).';
const MESSAGE_BIBLIOTHEQUE_SQL =
  "Interdit : la bibliothèque SQLite n'est importable que depuis app/server/db/connection.ts (ADR-0008).";
const MESSAGE_SQL =
  "Interdit : « db/sql » (preparer, preparerTransverse) n'est importable que depuis app/server/db/. " +
  'Hors de db/, une requête passe par le GroupScope ou la PorteeUtilisateur (verrous n° 2 et 5).';
const MESSAGE_MIGRATE =
  "Interdit : « db/migrate » n'est importable que depuis app/server/index.ts (ouverture, migrations, fermeture).";
const MESSAGE_FABRIQUE =
  'Interdit : creerScope n’est appelable que depuis app/server/http/middleware/appartenance.ts, et ' +
  'creerPorteeUtilisateur que depuis appartenance.ts (appartenance au groupe prouvée, verrou n° 3) et ' +
  "session.ts (session valide prouvée, verrou d'identité) : ce sont les intergiciels qui prouvent.";
const MESSAGE_APPEL_BRUT =
  'Interdit : .prepare, .exec et .pragma ne s’appellent que dans db/ (connection, sql, migrate). ' +
  'Une requête passe par le GroupScope ou la PorteeUtilisateur (verrous n° 2 et 5).';
const MESSAGE_BRUT_DANS_DB =
  'Interdit : dans db/, seuls connection.ts, sql.ts et migrate.ts appellent .prepare, .exec ou .pragma. ' +
  'Utilisez preparer() (garde du SQL brut, verrou n° 5).';
const MESSAGE_TRANSVERSE =
  'Interdit : preparerTransverse (canal transverse, textes SQL figés) n’est importable que depuis ' +
  'app/server/db/queries/transverse.ts.';
const MESSAGE_CONNEXION_BRUTE =
  'Interdit : connexionBrute rend la vraie connexion ; seuls db/sql.ts, db/migrate.ts et db/connection.ts l’appellent.';

const MESSAGE_BASE_DE = 'Interdit : baseDe rend la base d’une portée ; réservé à app/server/db/ (canal transverse).';
const MESSAGE_TESTS =
  'Interdit : le code serveur n’importe rien de app/tests/ (fixtures/brut.ts rend la vraie connexion : verrous n° 2 et 5).';

const DB = '(^|/)db/+(\\./)*';
const MODULE_CONNECTION = `${DB}connection`;
const MODULE_SQL = `${DB}sql`;
const MODULE_MIGRATE = `${DB}migrate`;
const MODULE_SCOPE = `${DB}scope`;
const MODULE_PORTEE = `${DB}portee-utilisateur`;
const BIBLIOTHEQUES_SQL = '^(better-)?sqlite3?(/|$)|^node:sqlite$';
// Une source qui se termine par un module puissant (avec ou sans extension) : sert aux ré-exports.
const SOURCE_PUISSANTE = '(^|\\/)(connection|sql|migrate|scope|portee-utilisateur)(\\.[cm]?[jt]s)?$';
// Dans db/, les imports relatifs sont courts : `./sql.js`, `../sql.js`.
const SOURCE_SQL_RELATIVE = '(^|/)sql(\\.[cm]?[jt]s)?$';
const SOURCE_CONNECTION_RELATIVE = '(^|/)connection(\\.[cm]?[jt]s)?$';

// no-restricted-imports ne voit pas import('…') : on le couvre ici, avec les mêmes motifs.
const enSelecteur = (regex) => regex.replaceAll('/', '\\/');
const importDynamique = (regex, message) => ({
  selector: `ImportExpression[source.value=/${enSelecteur(regex)}/]`,
  message,
});

const MODULE_TESTS = '(^|/)tests/';

const PATTERN_BIBLIOTHEQUES = { regex: BIBLIOTHEQUES_SQL, message: MESSAGE_BIBLIOTHEQUE_SQL };
const PATTERN_CONNECTION = { regex: MODULE_CONNECTION, message: MESSAGE_VERROU_DB };
const PATTERN_TESTS = { regex: MODULE_TESTS, message: MESSAGE_TESTS };
const PATTERN_SQL = { regex: MODULE_SQL, message: MESSAGE_SQL };
const PATTERN_MIGRATE = { regex: MODULE_MIGRATE, message: MESSAGE_MIGRATE };
const PATTERN_FABRIQUE_SCOPE = { regex: MODULE_SCOPE, importNames: ['creerScope'], message: MESSAGE_FABRIQUE };
const PATTERN_FABRIQUE_PORTEE = { regex: MODULE_PORTEE, importNames: ['creerPorteeUtilisateur'], message: MESSAGE_FABRIQUE };
const PATTERN_BASE_DE_PORTEE = { regex: MODULE_PORTEE, importNames: ['baseDe'], message: MESSAGE_BASE_DE };
// Dans db/ : les fonctions qui donnent un accès brut ou transverse, par leur nom.
const PATTERN_TRANSVERSE = { regex: SOURCE_SQL_RELATIVE, importNames: ['preparerTransverse'], message: MESSAGE_TRANSVERSE };
const PATTERN_CONNEXION_BRUTE = { regex: SOURCE_CONNECTION_RELATIVE, importNames: ['connexionBrute'], message: MESSAGE_CONNEXION_BRUTE };

const MESSAGE_CHARGEMENT_DYNAMIQUE =
  'Interdit : import() avec un argument non littéral, require et createRequire contournent le verrou de la base.';
const MESSAGE_REEXPORT =
  'Interdit : ré-exporter connection, sql, migrate, scope ou portee-utilisateur (fichier-baril) ferait disparaître les verrous n° 2 et 5 : importez-les là où on s’en sert.';

// Syntaxes interdites partout dans app/ (y compris dans db/ pour le ré-export).
const SYNTAXES_COMMUNES = [
  { selector: "ImportExpression:not([source.type='Literal'])", message: MESSAGE_CHARGEMENT_DYNAMIQUE },
  { selector: "CallExpression[callee.name=/^(require|createRequire)$/]", message: MESSAGE_CHARGEMENT_DYNAMIQUE },
  { selector: "CallExpression[callee.property.name='createRequire']", message: MESSAGE_CHARGEMENT_DYNAMIQUE },
  { selector: "ImportSpecifier[imported.name='createRequire']", message: MESSAGE_CHARGEMENT_DYNAMIQUE },
  { selector: "TSImportEqualsDeclaration[moduleReference.type='TSExternalModuleReference']", message: MESSAGE_CHARGEMENT_DYNAMIQUE },
  { selector: `ExportAllDeclaration[source.value=/${SOURCE_PUISSANTE}/]`, message: MESSAGE_REEXPORT },
  { selector: `ExportNamedDeclaration[source.value=/${SOURCE_PUISSANTE}/]`, message: MESSAGE_REEXPORT },
];
const SYNTAXE_IMPORT_BIBLIOTHEQUE = importDynamique(BIBLIOTHEQUES_SQL, MESSAGE_BIBLIOTHEQUE_SQL);
const SYNTAXE_IMPORT_CONNECTION = importDynamique(MODULE_CONNECTION, MESSAGE_VERROU_DB);
const SYNTAXE_IMPORT_TESTS = importDynamique(MODULE_TESTS, MESSAGE_TESTS);
const SYNTAXES_IMPORT_DYNAMIQUE_DB = [
  SYNTAXE_IMPORT_CONNECTION,
  SYNTAXE_IMPORT_TESTS,
  importDynamique(MODULE_SQL, MESSAGE_SQL),
  importDynamique(MODULE_MIGRATE, MESSAGE_MIGRATE),
  importDynamique(MODULE_SCOPE, MESSAGE_FABRIQUE),
  importDynamique(MODULE_PORTEE, MESSAGE_FABRIQUE),
];
// Appels de méthode bruts, y compris `x['prepare'](…)`.
const appelsBruts = (message) => [
  { selector: 'CallExpression[callee.property.name=/^(prepare|exec|pragma)$/]', message },
  { selector: 'CallExpression[callee.property.value=/^(prepare|exec|pragma)$/]', message },
];

// Hors de db/ : ni la base, ni ses modules puissants, ni les appels bruts.
const SYNTAXES_HORS_DB = [
  ...SYNTAXES_COMMUNES,
  SYNTAXE_IMPORT_BIBLIOTHEQUE,
  ...SYNTAXES_IMPORT_DYNAMIQUE_DB,
  ...appelsBruts(MESSAGE_APPEL_BRUT),
];
const IMPORTS_HORS_DB = [
  PATTERN_BIBLIOTHEQUES,
  PATTERN_TESTS,
  PATTERN_BASE_DE_PORTEE,
  PATTERN_CONNECTION,
  PATTERN_SQL,
  PATTERN_MIGRATE,
  PATTERN_FABRIQUE_SCOPE,
  PATTERN_FABRIQUE_PORTEE,
];

const regles = (patterns, syntaxes) => ({
  'no-restricted-imports': ['error', { patterns }],
  'no-restricted-syntax': ['error', ...syntaxes],
});

export default tseslint.config(
  // dist/ = sorties de compilation à la racine de chaque paquet ; un dossier dist/ plus profond reste contrôlé.
  { ignores: ['app/*/dist/**', '**/node_modules/**', 'data/**'] },

  js.configs.recommended,
  tseslint.configs.strict,

  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },

  // Le verrou : s'applique à tout le dépôt, sauf aux exceptions ci-dessous.
  {
    files: ['app/**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    rules: regles(IMPORTS_HORS_DB, SYNTAXES_HORS_DB),
  },
  // Clients légitimes : index.ts ouvre, migre et ferme ; l'intergiciel d'appartenance fabrique les scopes.
  {
    files: ['app/server/index.ts'],
    rules: regles(
      IMPORTS_HORS_DB.filter((p) => p !== PATTERN_MIGRATE),
      SYNTAXES_HORS_DB.filter((s) => s.message !== MESSAGE_MIGRATE),
    ),
  },
  {
    files: ['app/server/http/middleware/appartenance.ts'],
    rules: regles(
      IMPORTS_HORS_DB.filter((p) => p !== PATTERN_FABRIQUE_SCOPE && p !== PATTERN_FABRIQUE_PORTEE),
      SYNTAXES_HORS_DB.filter((s) => s.message !== MESSAGE_FABRIQUE),
    ),
  },
  // L'intergiciel de session fabrique la PorteeUtilisateur du compte de la session (lot 2) ; il ne fabrique JAMAIS de GroupScope.
  {
    files: ['app/server/http/middleware/session.ts'],
    rules: regles(
      IMPORTS_HORS_DB.filter((p) => p !== PATTERN_FABRIQUE_PORTEE),
      SYNTAXES_HORS_DB,
    ),
  },
  // Dans db/ : la bibliothèque est interdite, les appels bruts aussi, sauf dans trois fichiers ;
  // la vraie connexion et le canal transverse se nomment pour être importés.
  {
    files: ['app/server/db/**/*.{ts,mts,cts,js,mjs,cjs}'],
    rules: regles(
      [PATTERN_BIBLIOTHEQUES, PATTERN_TESTS, PATTERN_TRANSVERSE, PATTERN_CONNEXION_BRUTE],
      [...SYNTAXES_COMMUNES, SYNTAXE_IMPORT_BIBLIOTHEQUE, SYNTAXE_IMPORT_TESTS, ...appelsBruts(MESSAGE_BRUT_DANS_DB)],
    ),
  },
  {
    files: ['app/server/db/queries/transverse.ts'],
    rules: regles(
      [PATTERN_BIBLIOTHEQUES, PATTERN_TESTS, PATTERN_CONNEXION_BRUTE],
      [...SYNTAXES_COMMUNES, SYNTAXE_IMPORT_BIBLIOTHEQUE, SYNTAXE_IMPORT_TESTS, ...appelsBruts(MESSAGE_BRUT_DANS_DB)],
    ),
  },
  {
    files: ['app/server/db/sql.ts', 'app/server/db/migrate.ts'],
    rules: regles([PATTERN_BIBLIOTHEQUES, PATTERN_TESTS, PATTERN_TRANSVERSE], [...SYNTAXES_COMMUNES, SYNTAXE_IMPORT_BIBLIOTHEQUE, SYNTAXE_IMPORT_TESTS]),
  },
  // Le seul fichier autorisé à ouvrir la base.
  {
    files: ['app/server/db/connection.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': ['error', ...SYNTAXES_COMMUNES],
    },
  },
  // Tests : ils amorcent et inspectent la base à la main, mais n'importent ni la bibliothèque ni connection…
  {
    files: ['app/tests/**/*.{ts,mts,cts}'],
    rules: regles(
      [PATTERN_BIBLIOTHEQUES, PATTERN_CONNECTION],
      [...SYNTAXES_COMMUNES, SYNTAXE_IMPORT_BIBLIOTHEQUE, SYNTAXE_IMPORT_CONNECTION],
    ),
  },
  // … sauf ce fichier, qui rend la vraie connexion aux seuls tests (amorçage, constats hors scope).
  {
    files: ['app/tests/fixtures/brut.ts'],
    rules: regles([PATTERN_BIBLIOTHEQUES], [...SYNTAXES_COMMUNES, SYNTAXE_IMPORT_BIBLIOTHEQUE]),
  },

  // Client : navigateur, et aucun texte visible en dur (tout passe par t() et fr.json).
  {
    files: ['app/client/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['app/client/src/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...SYNTAXES_HORS_DB,
        {
          selector: 'JSXText[value=/\\S/]',
          message: 'Texte en dur interdit dans le JSX : ajoutez une clé dans src/i18n/fr.json et utilisez t().',
        },
        {
          // <p>{'Bonjour'}</p> : un littéral dans une accolade, enfant d'un élément.
          selector: 'JSXElement > JSXExpressionContainer > Literal[value=/\\S/]',
          message: 'Texte en dur interdit dans le JSX : ajoutez une clé dans src/i18n/fr.json et utilisez t().',
        },
        {
          selector:
            'JSXAttribute[name.name=/^(alt|title|placeholder|aria-label|aria-description)$/] > Literal',
          message: 'Texte en dur interdit dans un attribut : utilisez t() et src/i18n/fr.json.',
        },
      ],
    },
  },
);
