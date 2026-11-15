# ADR-0002 — Plusieurs groupes étanches sur une instance

- **Date** : 2026-11-15
- **Statut** : Acceptée
- **Décidé par** : Théo

## Contexte

Première intention : une instance = un groupe, le plus simple. Intention révisée : n'importe
qui doit pouvoir créer son compte sur l'instance, créer **son** groupe, y inviter ses amis, et
ne jamais croiser les autres groupes. Une même personne peut avoir plusieurs cercles.

## Options envisagées

1. **Mono-groupe.** Modèle de données minimal, mais chaque bande doit héberger sa propre
   instance. Rend l'application inutilisable pour qui ne sait pas auto-héberger.
2. **Multi-groupes étanches** (retenue). Un compte, N groupes, cloisonnement strict.

## Décision

**Option 2**, dès la V1 : la cloison est structurante, la rajouter après voudrait dire
reprendre chaque requête de l'application.

## Conséquences

- **Chaque table métier porte le groupe auquel la ligne appartient**, et **chaque** requête
  filtre dessus. C'est la règle numéro un du projet : un oubli de filtre est une fuite de
  données entre groupes, pas un bug d'affichage.
- Le cloisonnement se vérifie par des **tests automatiques dédiés** : pour chaque route, un
  test prouve qu'un membre du groupe A ne peut pas lire ni écrire une ressource du groupe B,
  même en forgeant l'identifiant.
- Deux niveaux d'administration distincts : administrateur **du groupe** (membres, contenu) et
  administrateur **de l'instance** (exploitation, quotas, sauvegardes). Le second n'a pas à
  accéder au contenu des groupes.
- Un sélecteur de groupe est nécessaire dans l'interface, et les notifications doivent dire de
  quel groupe elles parlent.
- L'inscription devient une question de sécurité à part entière (ouverte, ou sur invitation) :
  point encore ouvert.
- Les albums photos doivent être cloisonnés eux aussi, ce qui contraint l'intégration Immich.

## Ce qui rendrait cette décision fausse

Rien de prévisible : on ne revient pas en arrière sur un cloisonnement. En revanche, si
l'instance devait rester strictement privée, le travail de cloisonnement resterait du travail
utile — c'est de la défense en profondeur.
