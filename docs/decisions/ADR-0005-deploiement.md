# ADR-0005 — Déploiement : deux conteneurs, images publiées, mise à jour à la main

- **Date** : 2026-11-15
- **Statut** : Acceptée
- **Décidé par** : Théo

## Contexte

Première intention : un bouton de mise à jour dans l'application, comme sur Glassboard. Ce
modèle repose sur une installation native et une unité systemd privilégiée ; en Docker, un
conteneur ne peut pas se remplacer lui-même sans qu'on lui donne accès au démon Docker — ce
qui revient à lui donner la machine. L'intention a donc été abandonnée au profit d'une mise à
jour lancée à la main.

## Décision

- **Deux conteneurs LXC identiques** sur le homelab personnel :

  | Canal | LXC | IP | Image |
  |---|---|---|---|
  | Production | **112** | `10.1.20.112` | `ghcr.io/lokyron/attroupe:latest` ← branche `main` |
  | Pré-production | **113** | `10.1.20.113` | `ghcr.io/lokyron/attroupe:beta` ← branche `beta` |

- **Les images sont construites par l'intégration continue** (GitHub Actions) à chaque poussée
  et publiées sur **GHCR**, le registre d'images de GitHub, gratuit pour les images publiques.
  Le serveur ne compile rien : il télécharge une image déjà prête.
- **Installation et mise à jour** en une commande, sur le conteneur concerné :

  ```bash
  docker compose pull && docker compose up -d
  ```

- **Aucune mise à jour automatique** et aucun bouton dans l'interface : le moment de la mise à
  jour appartient à l'administrateur.

## Conséquences

- Le `docker-compose.yml` du dépôt est paramétré par l'étiquette d'image : le même fichier sert
  les deux canaux, seule la variable de version change.
- Une migration de base doit être **idempotente et jouée au démarrage** : la mise à jour n'a
  pas d'étape manuelle entre le `pull` et le `up`.
- Le canal `beta` sert à éprouver une migration avant la production. Il doit donc avoir ses
  **propres données**, jamais la base de production.
- Un retour arrière consiste à repointer l'étiquette d'image sur la version précédente ; les
  images anciennes ne sont donc pas supprimées du registre.
- L'application n'a aucun privilège sur son hôte : elle ne connaît ni Docker, ni systemd.
