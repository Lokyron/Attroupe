# Attroupe

> **Fiche de reprise — à remplir au fur et à mesure du cadrage.**
> Statut : 🔵 Cadrage terminé — **modèle de données et architecture écrits**, rien d'implémenté.
> Nom de code interne : **ACB**.

## 1. Vue d'ensemble

*Attroupe* — « attrouper les potes ». Organisateur auto-hébergé pour **groupes d'amis** : planning commun et agendas personnels,
soirées et sorties planifiées à plusieurs avec leur liste de courses « qui apporte quoi », et
albums photos alimentés par e-mail. L'esprit de FamilyWall / OpenFamily, mais pour une bande de
potes plutôt qu'un foyer.

Principe directeur : **ne pas perturber les habitudes** — abonnement iCal dans le calendrier
natif du téléphone, dépôt de photos par e-mail (IMAP), PWA sans passage par un store.

- Vision détaillée : [`Dossier de conception/00 - Vision.md`](Dossier%20de%20conception/00%20-%20Vision.md)
- Fonctionnalités proposées (à trier) : [`Dossier de conception/01 - Fonctionnalites proposees.md`](Dossier%20de%20conception/01%20-%20Fonctionnalites%20proposees.md)

Exigences non négociables du brief : installation **en une seule commande Docker**, dépôt
**GitHub public**, auto-hébergement sur le serveur personnel. La mise à jour depuis l'interface
a été **écartée** au profit d'un `docker compose pull` manuel (voir
[`ADR-0005`](docs/decisions/ADR-0005-deploiement.md)).

- Modèle de données V1 : [`Dossier de conception/03 - Modele de donnees.md`](Dossier%20de%20conception/03%20-%20Modele%20de%20donnees.md)
- Architecture : [`Dossier de conception/04 - Architecture.md`](Dossier%20de%20conception/04%20-%20Architecture.md)

## 2. Stack technique & dépendances

Node 24, Express, SQLite (`better-sqlite3`, voir
[`ADR-0008`](docs/decisions/ADR-0008-bibliotheque-sqlite.md)), React + Vite, TypeScript strict,
SQL explicite sans ORM. Validation par Zod, tests par Vitest + Supertest, temps réel par
événements serveur (SSE). Un seul conteneur
([`ADR-0001`](docs/decisions/ADR-0001-stack-technique.md)).

## 3. Architecture & arborescence

Détail complet : [`Dossier de conception/04 - Architecture.md`](Dossier%20de%20conception/04%20-%20Architecture.md).
En une phrase : un processus Node sert `/api/*`, `/ical/:jeton.ics` et les fichiers statiques du
client ; la base est un fichier dans `/data`. Le cloisonnement entre groupes repose sur cinq
verrous dont deux font échouer la compilation et un l'écriture en base
([`ADR-0006`](docs/decisions/ADR-0006-cloisonnement-structurel.md)).

## 3 bis. Hébergement

| Canal | Conteneur LXC | IP | Image |
|---|---|---|---|
| Production | **112** | `10.1.20.112` | `ghcr.io/lokyron/attroupe:latest` (branche `main`) |
| Pré-production | **113** | `10.1.20.113` | `ghcr.io/lokyron/attroupe:beta` (branche `beta`) |

Les deux conteneurs ont les mêmes spécifications ; seule l'étiquette d'image diffère.
Homelab personnel (pas Cazalia). Accès par Internet derrière le Nginx Proxy Manager, sur un
sous-domaine à définir. Immich tourne **à part**, sur sa ou ses propres instances, et n'est
jamais embarqué dans la pile du projet.

Image publiée sur GHCR, **paquet public** et **`linux/amd64`** uniquement.

Mise à jour, sur le conteneur concerné :

```bash
docker compose pull && docker compose up -d
```

## 4. Prérequis & environnement

*Variables d'environnement : liste complète au §9 de
[`04 - Architecture.md`](Dossier%20de%20conception/04%20-%20Architecture.md), à reporter dans
`.env.example` au lot 0.* Les trois secrets obligatoires (`ATTROUPE_SESSION_SECRET`,
`ATTROUPE_ENCRYPTION_KEY`, `ATTROUPE_SIGNED_URL_SECRET`) font 32 octets et le démarrage échoue
sans eux. Ils doivent être en base64 canonique, réellement aléatoires (au moins 16 octets
distincts), différents entre eux et sans mot d'exemple (`remplacer`, `exemple`, `secret`…) :
`openssl rand -base64 32`, trois fois. `ATTROUPE_BASE_URL` est une origine seule
(`https://attroupe.fr`, sans chemin), en `https` obligatoirement en production.

Déjà connues : envoi d'e-mails par **Brevo** (compte personnel dédié), et par groupe une URL
d'instance **Immich** avec sa clé d'API.

Licence du dépôt : **AGPL-3.0**. Dépôt public : <https://github.com/Lokyron/Attroupe>.

## 5. Guide d'installation & démarrage local

Déploiement Docker (ADR-0005) : préparer le dossier de données **avant** le premier
démarrage. Docker crée sinon `./data` en `root:root`, et l'utilisateur `node` (uid 1000) de
l'image n'y écrit pas : le serveur refuse alors de démarrer, avec un message qui le dit.

```sh
mkdir data && chown 1000:1000 data
cp .env.example .env   # puis remplir les clés (trois secrets : openssl rand -base64 32)
docker compose pull && docker compose up -d
```

Le port est publié sur `127.0.0.1` par défaut (`ATTROUPE_BIND`, `ATTROUPE_PORT`) : seul un
proxy inverse local doit joindre le conteneur, car la confiance à `X-Forwarded-For` est
active (`ATTROUPE_TRUST_PROXY=1`). Retour arrière : relancer avec `ATTROUPE_TAG=sha-<court>`
ou `ATTROUPE_TAG=<version>` (étiquettes publiées à chaque construction).

## 6. Scripts & commandes utiles

*À définir.*

## 7. Endpoints & interfaces

Surface d'API de la V1 par domaine :
[`04 - Architecture.md`](Dossier%20de%20conception/04%20-%20Architecture.md) §6. À recopier ici
au fur et à mesure de l'implémentation, une ligne par endpoint réellement livré.

## 8. Dette technique, TODOs & points d'attention

- Modèle de données et architecture : **écrits** (`03` et `04` du dossier de conception) ;
  l'implémentation n'a pas commencé. Le découpage en 13 lots est au §10 de `04`.
- `ADR-0008` est en statut **Proposée** : le statut de `node:sqlite` sur Node 24 et les binaires
  précompilés de `better-sqlite3` restent à vérifier au premier lot.
- Le cloisonnement entre groupes est le risque numéro un du projet : il se traite par des
  tests dédiés, route par route (voir `ADR-0002`).
- L'ajout d'un membre par son nom d'utilisateur ou son e-mail est une surface d'abus : l'ajout
  crée une **invitation à accepter**, jamais une adhésion d'office, et il n'y a pas d'annuaire
  consultable (correspondance exacte seulement).
- Le sous-domaine public n'est pas choisi.
- **Licence AGPL-3.0** retenue avant la première publication : pour une application servie par
  le réseau, c'est elle — et non la GPL — qui oblige celui qui héberge une version modifiée à
  publier ses modifications. Même choix que Glassboard.
