import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Verrou n° 5 du cloisonnement (architecture §4, « garde-fous automatiques ») :
// seul app/server/db/ parle à la base. Le verrou raisonne en motifs regex (et non en globs)
// pour résister aux écritures détournées : `db/./connection`, `db//connection`, sous-chemins…
const MESSAGE_VERROU_DB =
  "Interdit : « db/connection » n'est importable que depuis app/server/db/. " +
  'Passez par une fonction de db/queries/ (verrou n° 5, architecture §4).';
const MESSAGE_BIBLIOTHEQUE_SQL =
  "Interdit : la bibliothèque SQLite n'est importable que depuis app/server/db/connection.ts (ADR-0008).";

const MODULE_CONNECTION = '(^|/)db/+(\\./)*connection';
const BIBLIOTHEQUES_SQL = '^(better-)?sqlite3?(/|$)|^node:sqlite$';
// Une source qui se termine par « connection » (avec ou sans extension) : sert aux ré-exports.
const SOURCE_CONNECTION = '(^|\\/)connection(\\.[cm]?[jt]s)?$';

// no-restricted-imports ne voit pas import('…') : on le couvre ici, avec les mêmes motifs.
const enSelecteur = (regex) => regex.replaceAll('/', '\\/');
const SYNTAXE_IMPORT_CONNECTION = {
  selector: `ImportExpression[source.value=/${enSelecteur(MODULE_CONNECTION)}/]`,
  message: MESSAGE_VERROU_DB,
};
const SYNTAXE_IMPORT_BIBLIOTHEQUE = {
  selector: `ImportExpression[source.value=/${enSelecteur(BIBLIOTHEQUES_SQL)}/]`,
  message: MESSAGE_BIBLIOTHEQUE_SQL,
};

const PATTERN_BIBLIOTHEQUES = { regex: BIBLIOTHEQUES_SQL, message: MESSAGE_BIBLIOTHEQUE_SQL };
const PATTERN_CONNECTION = { regex: MODULE_CONNECTION, message: MESSAGE_VERROU_DB };

const MESSAGE_CHARGEMENT_DYNAMIQUE =
  'Interdit : import() avec un argument non littéral, require et createRequire contournent le verrou de la base.';
const MESSAGE_REEXPORT =
  "Interdit : ré-exporter « connection » (fichier-baril) ferait disparaître le verrou n° 5 : importez-la là où on s'en sert.";

// Syntaxes interdites partout dans app/ (y compris dans db/ pour le ré-export).
const SYNTAXES_COMMUNES = [
  { selector: "ImportExpression:not([source.type='Literal'])", message: MESSAGE_CHARGEMENT_DYNAMIQUE },
  { selector: "CallExpression[callee.name=/^(require|createRequire)$/]", message: MESSAGE_CHARGEMENT_DYNAMIQUE },
  { selector: "CallExpression[callee.property.name='createRequire']", message: MESSAGE_CHARGEMENT_DYNAMIQUE },
  { selector: "ImportSpecifier[imported.name='createRequire']", message: MESSAGE_CHARGEMENT_DYNAMIQUE },
  { selector: "TSImportEqualsDeclaration[moduleReference.type='TSExternalModuleReference']", message: MESSAGE_CHARGEMENT_DYNAMIQUE },
  { selector: `ExportAllDeclaration[source.value=/${SOURCE_CONNECTION}/]`, message: MESSAGE_REEXPORT },
  { selector: `ExportNamedDeclaration[source.value=/${SOURCE_CONNECTION}/]`, message: MESSAGE_REEXPORT },
];
// Hors de db/ : ni connection, ni bibliothèque. Dans db/ : la bibliothèque seulement.
const SYNTAXES_VERROU_DB = [...SYNTAXES_COMMUNES, SYNTAXE_IMPORT_CONNECTION, SYNTAXE_IMPORT_BIBLIOTHEQUE];

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

  // Le verrou : s'applique à tout le dépôt, sauf à db/ (ci-dessous).
  {
    files: ['app/**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [PATTERN_BIBLIOTHEQUES, PATTERN_CONNECTION] }],
      'no-restricted-syntax': ['error', ...SYNTAXES_VERROU_DB],
    },
  },
  // Dans db/, on peut importer connection, mais pas la bibliothèque SQLite.
  {
    files: ['app/server/db/**/*.{ts,mts,cts,js,mjs,cjs}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [PATTERN_BIBLIOTHEQUES] }],
      'no-restricted-syntax': ['error', ...SYNTAXES_COMMUNES, SYNTAXE_IMPORT_BIBLIOTHEQUE],
    },
  },
  // Le seul fichier autorisé à ouvrir la base.
  {
    files: ['app/server/db/connection.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': ['error', ...SYNTAXES_COMMUNES],
    },
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
        ...SYNTAXES_VERROU_DB,
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
