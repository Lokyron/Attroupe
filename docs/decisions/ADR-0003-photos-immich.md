# ADR-0003 — Où vivent les photos (Immich)

- **Date** : 2026-11-15
- **Statut** : Acceptée
- **Décidé par** : Théo

## Contexte

Les photos sont l'un des trois piliers du produit. L'intention est d'utiliser **Immich**
(alternative libre à Google Photos) et que tout soit stocké sur le conteneur du projet, plutôt
que de réécrire une galerie.

Ce qu'Immich implique, et qu'il faut avoir en tête avant de choisir : ce n'est pas une
bibliothèque mais une **application complète**, qui tourne en plusieurs services — serveur,
apprentissage automatique (reconnaissance de scènes et de visages), Redis, et un PostgreSQL
avec l'extension vectorielle. Compter plusieurs gigaoctets d'images et un appétit en mémoire
qui se chiffre en gigaoctets, surtout au premier indexage. Elle expose une API avec clés, qui
permet de créer des albums, d'y verser des photos et de produire des liens de partage.

## Options envisagées

1. **Immich embarqué dans la pile du projet.** Le `docker compose` du dépôt démarre
   l'application *et* Immich. Une seule commande, tout sur le même conteneur, les photos chez
   soi. En contrepartie : le conteneur devient gros (prévoir 8 Go de RAM et un disque
   généreux), l'installation par un tiers hérite de toute la complexité d'Immich, et les mises
   à jour d'Immich deviennent notre problème.
2. **Immich externe, intégration par API.** L'application se connecte à une instance Immich
   existante avec une clé d'API : elle crée un album par événement, y envoie les photos
   déposées et affiche les vignettes servies par Immich. Pile du projet légère, Immich mis à
   jour de son côté. En contrepartie : l'application ne marche pas en photos tant qu'un Immich
   n'est pas branché, et le cloisonnement entre groupes repose sur la rigueur de notre
   couche d'accès.
3. **Galerie maison légère**, avec Immich en option plus tard. Stockage sur disque, vignettes
   générées à l'envoi, aucune dépendance. Simple, mais on réécrit ce qu'Immich fait mieux, et
   on se prive de la recherche, des visages et des applications mobiles d'Immich.

## Décision

**Option 2.** Immich reste **en dehors** du projet : il tourne sur sa ou ses propres instances,
montées à part, et chaque groupe y est raccordé **par API** selon ses besoins. Notre pile reste
légère — un conteneur, une base SQLite — et nous n'héritons pas de l'exploitation d'Immich.

## Conséquences

- L'intégration passe **exclusivement par l'API** d'Immich, jamais par sa base de données.
- La configuration est **par groupe** : une URL d'instance et une clé d'API, stockées
  chiffrées. Deux groupes peuvent donc viser deux instances différentes, ou la même avec des
  clés distinctes.
- **Cloisonnement** : un album appartient à un groupe, et l'application ne sert jamais une
  photo sans avoir vérifié l'appartenance de l'appelant à ce groupe. Les URL servies sont
  signées et expirantes — jamais une URL d'Immich devinable.
- **Les vidéos entrent dans le périmètre** : Immich les gère, nous n'avons pas de transcodage
  à écrire.
- **Sans Immich configuré, l'onglet photos est simplement absent** du groupe. L'application
  doit fonctionner entièrement sans lui.
- La sauvegarde est double et de responsabilités distinctes : notre base d'un côté, la
  bibliothèque Immich de l'autre.
- Une instance Immich indisponible ne doit jamais empêcher le reste de l'application de
  répondre : les appels sont en délai court, et l'échec est affiché, pas propagé.

## Ce qui rendrait cette décision fausse

Vouloir qu'un tiers installe Attroupe avec les photos en une seule commande, sans rien savoir
d'Immich. Le profil Docker optionnel (option 1) redeviendrait alors intéressant, sans rien
changer au code : l'intégration par API reste la même.
