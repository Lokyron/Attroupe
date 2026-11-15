# ADR-0008 — Quelle bibliothèque SQLite

- **Date** : 2026-11-15
- **Statut** : Acceptée (2026-11-15, vérification faite au lot 1 : voir « Vérification au lot 1 »)
- **Décidé par** : architecte

## Contexte

L'[`ADR-0001`](ADR-0001-stack-technique.md) fixe Node 24 et SQLite, sans trancher l'accès :
`node:sqlite`, intégré à la plateforme, ou `better-sqlite3`, la bibliothèque native historique.
La règle de projet décourage toute dépendance non justifiée, ce qui plaide pour l'option
intégrée ; F5 (sauvegarde et restauration) plaide pour l'autre.

> *À la rédaction, deux points restaient à vérifier : le statut de `node:sqlite` sur la ligne 24
> et la disponibilité de binaires précompilés de `better-sqlite3`. Ils sont tranchés plus bas.*

## Options envisagées

1. **`node:sqlite`.** Zéro dépendance, zéro compilation, image Docker triviale. En contrepartie :
   API encore en évolution sur cette ligne de Node (une montée de version mineure peut casser
   l'appel), gestion des entiers 64 bits plus limitée, **pas d'API de sauvegarde à chaud**, pas
   de fonction SQL définie par l'application.
2. **`better-sqlite3`.** API synchrone stable depuis des années, `safeIntegers()` par
   instruction, `db.backup()` **et** `VACUUM INTO`, `db.function()`. En contrepartie : une
   dépendance native, donc une étape de compilation (ou un binaire précompilé) dans l'image.

## Décision

**Option 2, `better-sqlite3`**, avec un accès **confiné à `app/server/db/connection.ts`** : c'est
le seul fichier du dépôt autorisé à importer la bibliothèque.

Argument décisif : la **sauvegarde à chaud**. F5 est une exigence V1 et une promesse du produit
(« des souvenirs non sauvegardés sont des souvenirs perdus ») ; avec le mode WAL, une copie de
fichier n'est pas fiable, et `VACUUM INTO` est ce qui rend la sauvegarde cohérente pendant
l'écriture — y compris la sauvegarde automatique avant migration, elle-même ce qui rend le
retour arrière de l'[`ADR-0005`](ADR-0005-deploiement.md) réellement possible. Vient ensuite la
stabilité de l'API : le projet se met à jour à la main et doit pouvoir sauter des versions de
Node sans réécrire sa couche d'accès.

## Conséquences

- Le `Dockerfile` a une étape de construction avec les outils de compilation ; l'image finale ne
  les contient pas. L'étape runtime reste sur une base `bookworm-slim` (glibc) plutôt
  qu'`alpine`, pour pouvoir utiliser les binaires précompilés.
- Les montants, tous entiers, peuvent être lus en `BigInt` là où c'est utile.
- La bascule vers `node:sqlite` reste une journée de travail : une seule importation à changer,
  et l'API des deux bibliothèques est volontairement proche. Le `scope.ts` et les requêtes n'en
  savent rien.
- Aucun ORM n'entre dans la pile, conformément à l'`ADR-0001`.
- Le confinement est réel et non seulement documentaire : hors de `db/`, la connexion est un type
  opaque (`Base`, `db/base.ts`) sans aucune méthode, et ESLint interdit `.prepare`, `.exec` et
  `.pragma` hors de `connection.ts`, `sql.ts` et `migrate.ts` (architecture §4, verrous 2 et 5).

## Vérification au lot 1 (constat du 2026-11-15)

Faite sur l'image `node:24-bookworm-slim` (Node 24.22.3, SQLite 3.54.1) et sur la documentation
officielle de la ligne 24. **Le constat corrige une partie de l'argumentaire ci-dessus.**

- **Stabilité** : la documentation de `node:sqlite` sur Node 24 indique « Stability: 1.2 -
  Release candidate » (ni expérimental ni stable). Le module se charge sans avertissement.
- **Sauvegarde** : l'affirmation « pas d'API de sauvegarde à chaud » est **devenue fausse** :
  `node:sqlite` expose `backup()` et exécute `VACUUM INTO` (essayé). Elle ne départage plus
  les deux options.
- **Fonctions SQL** : `function()` et `aggregate()` existent aussi. Autre écart avec le texte.
- **Entiers 64 bits** : une valeur au-delà de 2^53 lève une `RangeError` tant que la lecture en
  `BigInt` n'est pas demandée (`setReadBigInts`) ; `better-sqlite3` offre le même mécanisme
  (`safeIntegers`). Équivalent en pratique pour des montants en unités mineures.
- **Binaires de `better-sqlite3`** (version 13.2) : le paquet embarque des binaires pour
  `linux-x64`, `linux-arm64`, `linuxmusl-*`, `darwin-*` et `win32-*` ; l'image a été construite
  et le conteneur démarre sur `aarch64` (glibc), sans compilation séparée.

**Conclusion : la décision est maintenue**, mais pour un motif plus étroit qu'annoncé. Il ne
s'agit plus de « seule bibliothèque capable de sauvegarder » : c'est une API **stable** et
éprouvée, contre un module encore au stade de *release candidate* dont la signature peut
bouger d'une version de Node à l'autre, alors que le projet doit pouvoir sauter des versions.
Le surcoût de la dépendance native est nul à l'usage (binaires fournis). Comme l'accès reste
confiné à `db/connection.ts` (règle ESLint et test), **revoir l'ADR quand `node:sqlite` passera
en « Stable »** coûtera une journée, pas une refonte.

## Ce qui rendrait cette décision fausse

`node:sqlite` déclaré **stable** (il dispose désormais d'une API de sauvegarde, voir le constat
du lot 1) : la dépendance native perdrait sa justification. Ou, à l'inverse, des binaires précompilés indisponibles sur l'architecture
cible, qui rendraient chaque construction d'image lente et fragile — l'arbitrage basculerait
alors sur le temps d'intégration continue.
