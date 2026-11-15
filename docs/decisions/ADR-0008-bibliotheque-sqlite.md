# ADR-0008 — Quelle bibliothèque SQLite

- **Date** : 2026-11-15
- **Statut** : Proposée (une vérification reste à faire, voir « Contexte »)
- **Décidé par** : architecte

## Contexte

L'[`ADR-0001`](ADR-0001-stack-technique.md) fixe Node 24 et SQLite, sans trancher l'accès :
`node:sqlite`, intégré à la plateforme, ou `better-sqlite3`, la bibliothèque native historique.
La règle de projet décourage toute dépendance non justifiée, ce qui plaide pour l'option
intégrée ; F5 (sauvegarde et restauration) plaide pour l'autre.

> **À vérifier au lot 0, non confirmé à la date de rédaction** : le statut exact de
> `node:sqlite` sur la ligne 24 (expérimental ou stable) et la disponibilité de binaires
> précompilés de `better-sqlite3` pour Node 24 sur l'architecture du homelab. Cette ADR passe en
> « Acceptée » quand ces deux points sont tranchés.

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

## Ce qui rendrait cette décision fausse

`node:sqlite` déclaré stable **et** doté d'une API de sauvegarde : la dépendance native perdrait
sa justification. Ou, à l'inverse, des binaires précompilés indisponibles sur l'architecture
cible, qui rendraient chaque construction d'image lente et fragile — l'arbitrage basculerait
alors sur le temps d'intégration continue.
