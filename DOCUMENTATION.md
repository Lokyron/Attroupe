# Attroupe

> **Fiche de suivi du projet.**
> Statut : 🟢 **Lots 0 à 12 livrés** (socle, comptes, groupes, agenda, iCal, listes/tâches/SSE, sondages, agenda personnel, notifications, dépenses, discussions, photos Immich, finition PWA/sauvegarde/exploitation).
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
SQL explicite sans ORM. Accès à la base par `better-sqlite3` ^13 (ADR-0008 **Acceptée** au
lot 1 : `node:sqlite` est encore en *release candidate* sur Node 24, même s'il sait désormais
sauvegarder ; binaires fournis pour linux-x64 et linux-arm64), confiné à `app/server/db/connection.ts`.
Migrations SQL dans `app/migrations/` (suivies par checksum, sauvegarde `VACUUM INTO` avant
toute migration sur une base existante). Validation par Zod, tests par Vitest + Supertest, temps réel par
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

**Créés le 2026-11-16** sur le nœud `PVE-TXLHOME` (Proxmox 9.2), aux conventions des autres conteneurs
de ce homelab : Debian 13, **non privilégié**, `features: nesting=1,keyctl=1` (indispensable à Docker
dans un LXC non privilégié), `rootfs` sur `local-zfs`, 2 cœurs, 2 Gio de mémoire, 512 Mio de swap,
16 Gio de disque, `net0` sur `vmbr0` avec IP statique et passerelle `10.1.20.1`, `onboot: 1`.
Docker CE et le greffon Compose y sont installés et actifs, et l'exécution est **vérifiée** dans les
deux (`docker run --rm hello-world`). Accès `root` par la clé `~/.ssh/id_ed25519_pve` ; **aucun mot de
passe root n'est posé**, l'accès se fait par clé.

**Déployé sur le 113 le 2026-11-16.** `/opt/attroupe/` contient le `docker-compose.yml` du dépôt et un
`.env` en `chmod 600` dont les **trois secrets ont été générés sur le serveur** (`openssl rand -base64 32`,
un par usage) et n'en sont jamais sortis. `ATTROUPE_TAG=beta`, `ATTROUPE_BASE_URL=https://beta.attroupe.fr`,
`ATTROUPE_IMMICH_ALLOW_PRIVATE=true` (Immich est sur le même réseau privé), pas de `BREVO_API_KEY` : les
e-mails restent en file et le journal le dit au démarrage (`email.non_configure`).

**Le proxy n'est pas sur la même machine que l'application** (NPM est le CT 100, `10.1.20.100`), donc
`ATTROUPE_BIND=0.0.0.0` et non `127.0.0.1`. Pour que cela ne vide pas la limitation de cadence — avec
`ATTROUPE_TRUST_PROXY=1`, un client direct du réseau local forgerait son `X-Forwarded-For` — le port 3000
n'est joignable **que depuis `10.1.20.100`** : deux règles dans la chaîne `DOCKER-USER` (le trafic vers un
conteneur est DNAT-é et ne traverse pas `INPUT`), posées par
`/usr/local/sbin/attroupe-pare-feu.sh` et réappliquées à chaque démarrage par l'unité systemd
`attroupe-pare-feu.service` (`After=docker.service`).

Vérifié par exécution : `/api/sante` à 200 depuis le conteneur **et** depuis le CT 100, refusé depuis une
autre machine du réseau, l'interface se charge, et **tout survit à un `pct reboot`** (démarrage
automatique du conteneur applicatif, règles réappliquées, état `healthy`).

Pour lever la restriction le temps d'un essai direct depuis le réseau local :
`iptables -D DOCKER-USER -p tcp --dport 3000 -j DROP` dans le CT 113 (elle revient au prochain démarrage).

> Le **112 (production) n'est pas déployé** : il attend le nom de domaine définitif et la bascule du
> lot 12.

**`https://beta.attroupe.fr` est en service depuis le 2026-11-16.** Certificat Let's Encrypt
`*.attroupe.fr` + `attroupe.fr`, obtenu par **défi DNS avec le greffon OVH** (`dns_ovh_endpoint = ovh-eu`,
propagation 120 s) — le défi HTTP-01 ne convenait plus, *Force SSL* renvoyant un 301 sur
`/.well-known/acme-challenge/`. Le même certificat couvrira la production.

Vérifié de bout en bout : certificat valide pour ce nom, `http` → `https` en 301, `/api/sante` à 200 en
HTTPS, interface servie. NPM transmet `X-Forwarded-For` (`$proxy_add_x_forwarded_for`) et `X-Real-IP` ;
comme il est le seul saut en amont, `ATTROUPE_TRUST_PROXY=1` (Express `trust proxy = 1`, qui lit la
dernière entrée) attribue bien l'adresse réelle du client, ce dont dépend la limitation de cadence.

*Restent à cocher dans NPM* : **HTTP/2** (l'hôte est encore en `http2 off`, donc HTTP/1.1) et les deux
lignes de l'onglet *Advanced*, `proxy_buffering off;` et `client_max_body_size 50m;`. Le flux temps réel
fonctionne malgré l'absence de la première, l'application envoyant `X-Accel-Buffering: no` que Nginx
respecte ; la seconde servira au dépôt de photos du lot 11.

**L'instance est inutilisable en HTTP nu, et c'est voulu.** `ATTROUPE_BASE_URL` détermine deux choses :
le cookie de session est marqué `Secure` dès que l'URL est en `https:` (`http/app.ts`, `cookieSecurise`),
et la protection CSRF n'admet **que** l'origine exacte de cette URL (`middleware/csrf.ts`). Avec
`ATTROUPE_BASE_URL=https://beta.attroupe.fr` servi en clair sur le port 80, la page se charge mais toute
requête qui modifie est refusée en **403 `csrf.origine_refusee`** — vérifié : un `POST /api/auth/inscription`
avec `Origin: http://beta.attroupe.fr` donne 403, le même avec `Origin: https://beta.attroupe.fr` passe la
barrière et tombe sur la validation (400). Autrement dit : pas de certificat, pas d'inscription ni de
connexion possibles. Le certificat n'est donc pas un confort, c'est une condition de fonctionnement.

Homelab personnel (pas Cazalia). Accès par Internet derrière le Nginx Proxy Manager, sur un
sous-domaine à définir. Immich tourne **à part**, sur sa ou ses propres instances, et n'est
jamais embarqué dans la pile du projet.

**Flux iCal et journaux du proxy.** Le jeton d'un flux de calendrier est dans l'URL (`/ical/<jeton>.ics`) : il apparaît donc dans les journaux d'accès du Nginx Proxy Manager (le journal applicatif, lui, ne couvre que `/api`). Quiconque lit ces journaux peut s'abonner aux calendriers concernés ; à protéger ou à purger en conséquence, et à révoquer en cas de fuite.

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

**Push navigateur** (facultatif, [`ADR-0012`](docs/decisions/ADR-0012-push-navigateur.md)) :
`ATTROUPE_VAPID_PUBLIC_KEY`, `ATTROUPE_VAPID_PRIVATE_KEY` et `ATTROUPE_VAPID_SUBJECT` (`mailto:` ou
`https:`). Les deux clés vont **ensemble** : une moitié seule fait échouer le démarrage, parce qu'elle
était auparavant ignorée au profit d'une clé générée en base — les navigateurs s'abonnaient alors avec
une clé et les envois étaient signés avec l'autre, donc rejetés en silence. Sans ces variables, une
paire est générée et conservée en base, chiffrée avec `ATTROUPE_ENCRYPTION_KEY` comme la clé Immich ;
si cette clé maîtresse change, la configuration push devient illisible et **n'est pas régénérée
automatiquement**, ce qui désabonnerait tous les appareils sans prévenir. Dans ce cas `GET
/api/moi/push/cle` répond 500 pour tout le monde, et la reprise est manuelle : supprimer la ligne de
`push_config`, redémarrer, puis faire réactiver les notifications sur chaque appareil (une nouvelle
paire est générée au premier usage).
`ATTROUPE_IMMICH_ALLOW_PRIVATE` ne s'applique **pas** au push : la tolérance accordée à Immich en
homelab ne vaut pas pour une URL choisie par le client.

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

**Le dossier de données doit être un disque local.** La base passe en mode WAL au démarrage
(`PRAGMA journal_mode = WAL`, relu et vérifié). Sur un volume réseau (NFS, SMB/CIFS), SQLite ne
sait pas le faire : le serveur **refuse alors de démarrer**, avec un message qui le dit. C'est
volontaire (sans WAL, ni la sauvegarde à chaud ni la concurrence ne tiennent) ; ne contournez pas
l'échec, montez `./data` depuis un disque local. Deux conteneurs qui démarrent ensemble sur le même
volume ne se gênent pas : le passage en WAL est réessayé et chaque migration est relue sous
verrou d'écriture avant d'être jouée.

Le port est publié sur `127.0.0.1` par défaut (`ATTROUPE_BIND`, `ATTROUPE_PORT`) : seul un
proxy inverse local doit joindre le conteneur, car la confiance à `X-Forwarded-For` est
active (`ATTROUPE_TRUST_PROXY=1`). Retour arrière : relancer avec `ATTROUPE_TAG=sha-<court>`
ou `ATTROUPE_TAG=<version>` (étiquettes publiées à chaque construction).

## 6. Scripts & commandes utiles

*À définir.*

## 7. Endpoints & interfaces

Surface d'API de la V1 par domaine :
[`04 - Architecture.md`](Dossier%20de%20conception/04%20-%20Architecture.md) §6. Livré au lot 2
(JSON, préfixe `/api`, cookie `attroupe_session` ; toute requête qui modifie exige l'en-tête
`Origin` de l'instance, sinon 403) :

| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/api/sante` | État et version (sans session). |
| GET | `/api/version` | Nom, version, étiquette (`ATTROUPE_TAG`) et dernière migration SQL appliquée (sans session). |
| POST | `/api/auth/inscription` | `{email, username, password, display_name?}` → 202, toujours la même réponse. 409 `nom_utilisateur.pris` si le nom est pris. |
| POST | `/api/auth/email/verification` | `{token}` : consomme le jeton de vérification (usage unique, 24 h à partir de l'envoi). |
| POST | `/api/auth/connexion` | `{email, password}` → pose le cookie de session. 401 uniforme. |
| POST | `/api/auth/deconnexion` | Révoque la session courante, efface le cookie (idempotent). |
| POST | `/api/auth/mot-de-passe/oubli` | `{email}` → 202, toujours la même réponse (durée minimale fixe). |
| POST | `/api/auth/mot-de-passe/reinitialisation` | `{token, password}` : jeton à usage unique (1 h), révoque toutes les sessions. |
| GET / PATCH | `/api/moi` | Compte courant (`service_email`: `actif` ou `non_configure`) ; modifie `display_name`, `time_zone`, `birthday`. |
| POST | `/api/moi/mot-de-passe` | `{current_password, new_password}` : ancien mot de passe vérifié (400 `mot_de_passe.actuel_invalide`), autres sessions révoquées, jeton de la session courante renouvelé (nouveau cookie). |
| POST | `/api/moi/email/verification` | Renvoie le mail de vérification (202 ; 409 `email.deja_verifie`). |
| GET | `/api/moi/sessions` | Mes appareils (`courante` repère la session de la requête). |
| DELETE | `/api/moi/sessions/:id` | Révoque un appareil (404 si ce n'est pas le mien). |
| DELETE | `/api/moi/sessions` | Révoque toutes mes sessions sauf la courante. |

Lot 3 (groupes, membres, invitations). Tout ce qui est sous `/api/groupes/:groupId/…` passe par
`exigerAppartenance` (posé **une fois** sur le préfixe) : 401 sans session, **404** `groupe.introuvable` pour un groupe
étranger, inexistant, supprimé ou quitté (jamais 403). Les routes *(admin)* ajoutent `exigerAdminGroupe` : **403**
`droit.admin_requis`. Règles d'intégrité : [`ADR-0009`](docs/decisions/ADR-0009-membres-et-invitations.md).

| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/api/groupes` | Mes groupes (sélecteur). `GET /api/moi` les porte aussi (`groupes`) avec `invitations_en_attente`. |
| POST | `/api/groupes` | `{name, default_currency_code?, time_zone?}` → 201 ; le créateur devient administrateur. Cadence 10/compte. |
| GET | `/api/moi/invitations` | Mes invitations reçues par nom d'utilisateur (jamais d'identifiant de groupe). |
| POST | `/api/moi/invitations/:invitationId/acceptation` · `/refus` | Répondre. 404 si l'invitation n'est pas adressée à ce compte. Réintégration : la même ligne `memberships` est réactivée. |
| POST | `/api/invitations/apercu` | Aperçu par lien, `{token}` dans le corps, jamais dans l'URL (*sans session*) : groupe, invitant, rôle. 410 `invitation.revoquee` / `expiree` / `deja_utilisee`. |
| POST | `/api/invitations/acceptation` | Accepter par lien, `{token}` dans le corps : session, adresse **vérifiée** et identique (403 `invitation.adresse_non_verifiee`, 404 sinon). |
| GET / PATCH | `/api/groupes/:groupId` | Détail (avec `mon_role`) ; renommer, devise, fuseau *(admin)*. 409 `groupe.archive` si archivé. |
| GET | `/api/groupes/:groupId/membres` | Actifs d'abord, puis anciens membres. Ni e-mail ni nom d'utilisateur. |
| PATCH | `/api/groupes/:groupId/membres/:membreId` | `{role}` *(admin)*. 409 `groupe.dernier_admin`, `membre.inactif`. |
| DELETE | `/api/groupes/:groupId/membres/:membreId` | Retire *(admin)* : `status = 'removed'`, historique conservé. 409 `membre.retrait_de_soi`. |
| POST | `/api/groupes/:groupId/depart` | Partir (`left`). 409 `groupe.dernier_admin`. |
| GET / POST | `/api/groupes/:groupId/invitations` | Lister ; inviter `{email}` **ou** `{username}` exact, `role?`, `message?` *(admin)*. POST : 202 identique dans tous les cas, cadence 10/compte, 3 par (cible, groupe), 20 par cible. |
| DELETE | `/api/groupes/:groupId/invitations/:invitationId` | Révoquer *(admin)* ; 409 `invitation.non_en_attente`. |

Lot 4 (agenda du groupe). Même préfixe, donc même règle : 404 `groupe.introuvable` pour un groupe étranger.
Les routes *(organisateur)* ajoutent `peutModifierEvenement` — auteur, co-organisateur ou administrateur du groupe —
et répondent **403** `droit.organisateur_requis`. L'existence est toujours résolue **avant** le droit : un événement
d'un autre groupe donne **404** `evenement.introuvable`, jamais 403.

| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/api/groupes/:groupId/evenements?du=&au=` | Fenêtre d'agenda (mois, semaine, liste). `du` est **obligatoire** (`AAAA-MM-JJ`, inclusif) ; `au` optionnel, 400 jours au plus. Les annulés sont inclus. |
| POST | `/api/groupes/:groupId/evenements` | `{title, starts_at, time_zone, ends_at?, all_day?, description?, location_*?, arrival_note?, host_membership_id?, currency_code?, capacity?}` → 201, **avec son fil de discussion** dans la même transaction. |
| GET | `/api/groupes/:groupId/evenements/:evenementId` | Détail : `thread_id`, `auteur`, `organisateurs`, `peut_modifier`, `ma_presence`. |
| PATCH | `/api/groupes/:groupId/evenements/:evenementId` | Modifier *(organisateur)*. Schéma strict : `status`, `group_id`, `created_by_membership_id`, `source_date_poll_id` et les champs de récurrence (réservés V2) sont **refusés** en 400. |
| DELETE | `/api/groupes/:groupId/evenements/:evenementId` | **Annule** *(organisateur)* : `status = 'cancelled'`, idempotent, renvoie le détail. Aucune suppression physique. |
| PUT | `/api/groupes/:groupId/evenements/:evenementId/ma-presence` | `{status: 'yes'\|'maybe'\|'no', guests_count?, comment?}`. Le membre vient du scope (un `membership_id` dans le corps est refusé). 409 `evenement.annule`. `responded_at` garde la première réponse. |
| GET | `/api/groupes/:groupId/evenements/:evenementId/presences` | Réponses, compteurs (`yes`, `maybe`, `no`, `attendus` = les oui + leurs invités) et la liste des membres actifs sans réponse. Calculé en SQL dans la portée du groupe. |
| POST / DELETE | `/api/groupes/:groupId/evenements/:evenementId/organisateurs/:membreId` | Ajouter, retirer un co-organisateur *(organisateur)*, idempotent. 404 `membre.introuvable`, 409 `membre.inactif`. |

`capacity` est **informative** en V1 : un « oui » au-delà n'est pas bloqué.

Lot 5 (flux iCal, [`ADR-0010`](docs/decisions/ADR-0010-flux-ical.md)). `GET /ical/:jeton.ics` est la seule route
métier **hors `/api`** : ni cookie, ni CSRF, ni groupe dans l'URL. Le jeton établit l'identité, puis le flux crée
**un `GroupScope` par appartenance active** et lit les événements groupe par groupe — l'appartenance est relue à
chaque requête, donc le jeton d'un membre retiré ne rend plus rien de son ancien groupe.

| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/api/moi/flux-ical` | Mes abonnements : `label`, groupe éventuel, drapeaux, `last_used_at`, `last_user_agent`. **Jamais le jeton ni aucune adresse** (stocké haché : le lien ne se reconstitue pas, un lien perdu se révoque et se recrée). |
| POST | `/api/moi/flux-ical` | `{label?, group_id?, include_personal?, include_declined?}` → 201 **avec le jeton en clair, une seule fois**, et ses deux adresses : `url` (`https://…/ical/<jeton>.ics`, pour Google Agenda et les clients de bureau) et `url_webcal` (même adresse en `webcal://`, celle qui fait créer un abonnement sur iOS ; base en `http://` en développement local). 404 `groupe.introuvable` si l'appartenance n'est pas active. Plafond de 20 abonnements non révoqués (409 `flux.plafond`) + cadence `abonnement`. |
| DELETE | `/api/moi/flux-ical/:fluxId` | Révoque (`revoked_at`) ; la ligne reste visible 30 jours, puis la tâche d'entretien horaire (`services/taches.ts`) l'efface. 404 si ce n'est pas le mien. |
| GET | `/api/moi/agenda/sources` | Mes agendas externes (ADR-0013). **Jamais l'URL**, ni chiffrée ni en clair : seulement `url_host`, les statuts et les compteurs. L'adresse secrète d'un agenda Google donne le calendrier complet, détails compris. |
| POST | `/api/moi/agenda/sources` | `{url, label?}` → 201 avec la source **et** le bilan de la première synchronisation, faite dans la même requête (jusqu'à 20 s) : c'est le seul moyen de valider l'URL. **Un 201 ne veut pas dire que ça a marché** — lire `synchronisation.statut`. `webcal://` est normalisé en `https://` ; ensuite https seul, port 443 seul, sans identifiants. 400 `source.url_invalide` uniforme pour toute cause de forme, 409 `source.plafond` (5 par compte), 409 `source.deja_presente`. Cadence `import_agenda`. |
| PATCH | `/api/moi/agenda/sources/:id` | `{label?, disabled?}`. Réactiver remet le compteur d'échecs à zéro et replanifie tout de suite. |
| DELETE | `/api/moi/agenda/sources/:id` | Supprime la source **et ses créneaux importés** (cascade). Les créneaux saisis à la main ne bougent pas. |
| POST | `/api/moi/agenda/sources/:id/synchronisation` | Relance à la demande, 1 fois par 5 min et par source (429 + `Retry-After`). Fonctionne sur une source désactivée, et un succès la réactive : c'est la reprise manuelle. |
| GET | `/api/moi/push/cle` | Clé publique VAPID et nombre d'appareils enregistrés. |
| POST | `/api/moi/push/abonnement` | `{endpoint, keys:{p256dh, auth}}` → 201. L'`endpoint` est **contraint** : `https` seul, port 443, sans identifiants, hôte résolvant uniquement vers des adresses publiques (400 `push.endpoint_invalide`, réponse identique quelle que soit la cause). Plafond de 10 appareils par compte : au-delà, le plus ancien est remplacé. Cadence `push`. |
| DELETE | `/api/moi/push/abonnement` | `{endpoint?}` ; sans corps, retire tous mes appareils. |
| POST | `/api/moi/push/test` | **202 `{ok, appareils}`**, jamais le résultat de l'appel sortant : l'envoi part en arrière-plan et un accusé précis serait un oracle de balayage du réseau interne. Cadence `push`. |
| GET | `/ical/:jeton.ics` | **Hors `/api`, sans cookie.** 404 identique pour un jeton inconnu, mal formé ou révoqué. Cadence 60/h par jeton (+ IP et réseau). `Cache-Control: private, max-age=300`, `ETag` et `304`. |

Jeton : 32 octets en base32 minuscule (`^[a-z2-7]{52}$`, forme vérifiée **avant** la base), stocké haché en SHA-256.
`ETag` = empreinte **exacte** du flux (`id|updated_at|nom de l'auteur` de chaque événement servi, trié puis haché),
et non `(max, count)` : deux réponses de présence échangées changent le contenu sans changer le nombre ni le
`max(updated_at)`, et donneraient sinon un `304` qui laisse un agenda faux sur le téléphone. Un `304` ne coûte que
les agrégats, sans lecture d'événement. `DTSTART` en UTC pour les événements horodatés, `VALUE=DATE` pour les
journées entières (écart à §7.1 acté par l'ADR-0010) ; `include_personal` est stocké mais **sans effet** jusqu'au
lot 8.

Lot 6 (listes de courses, tâches, temps réel, [`ADR-0011`](docs/decisions/ADR-0011-temps-reel-listes-taches.md)). Même
préfixe, donc même règle (404 `groupe.introuvable` hors du groupe). Tout membre actif modifie une liste ou une tâche ; les
seuls 403 sont `droit.assignation_requise` (réassigner la tâche de quelqu'un d'autre). Une liste, un article, une tâche ou
un événement d'un autre groupe (ou d'une autre liste) est un **404** (`liste.introuvable`, `article.introuvable`,
`tache.introuvable`, `evenement.introuvable`). Suppressions **logiques** (`deleted_at`) ; supprimer une liste supprime ses
articles. `category` (V2) n'est ni écrite ni exposée.

| Méthode | Chemin | Rôle |
|---|---|---|
| GET / POST | `/api/groupes/:groupId/listes` | Lister avec compteurs (`articles_total`, `articles_faits`), filtrable par `?event_id=` (404 si l'événement n'est pas du groupe) ; créer `{title, event_id?}`. |
| GET / PATCH / DELETE | `/api/groupes/:groupId/listes/:listeId` | Détail (avec `articles`, ordre `position` puis `id`) ; renommer `{title}` ; supprimer. |
| POST | `/api/groupes/:groupId/listes/:listeId/articles` | `{label, quantity?}` → 201, ajouté en fin de liste. 409 `liste.pleine` au-delà de 500 articles. |
| PATCH / DELETE | `/api/groupes/:groupId/listes/:listeId/articles/:articleId` | `{label?, quantity?, after_item_id?}` : `after_item_id` = placer **après** cet article (`null` : en tête), ce doit être un autre article de la même liste (404 sinon). |
| PUT | `…/articles/:articleId/preneur` | `{prend: boolean}`. Toujours **mon** marquage. `UPDATE` conditionnel : le second preneur reçoit **409** `article.deja_pris` avec `pris_par: {membership_id, display_name}` ; retirer le marquage d'un autre : 409 `article.pas_le_votre`. Refaire ce qui est fait : 200 sans changement. Le marquage d'un membre qui a quitté le groupe est libre : tout membre peut le libérer ou le reprendre. |
| PUT | `…/articles/:articleId/fait` | `{fait: boolean}`. `is_done` et `done_at` ensemble ; cocher deux fois garde l'instant du premier. |
| GET / POST | `/api/groupes/:groupId/taches` | Lister (filtrable par `?event_id=`), créer `{title, details?, event_id?, due_at?}` (`todo`, sans assigné). |
| PATCH / DELETE | `/api/groupes/:groupId/taches/:tacheId` | `{title?, details?, event_id?, due_at?, status?}` (`todo`/`doing`/`done`/`dropped`) ; `done_at` se déduit de `status`. |
| PUT | `/api/groupes/:groupId/taches/:tacheId/assignation` | `{assignee_membership_id: id \| null}` : « je m'en occupe » (mon appartenance), désigner un membre **actif de ce groupe** (404 `membre.introuvable`, 409 `membre.inactif`), ou libérer. Tâche déjà à un autre : seuls l'assigné, l'auteur ou un administrateur (403 sinon). |
| GET | `/api/groupes/:groupId/temps-reel` | **Flux SSE** du groupe, descendant seulement. `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`, battement de cœur toutes les 25 s. 429 `flux.trop_de_connexions` au-delà de 8 flux par compte ou de `ATTROUPE_SSE_MAX_CONNECTIONS` (200) flux au total. |

Messages du flux (`data:` JSON, type `message`) : `{type, ressource, id, parent_id, par, at}` — **jamais l'objet métier** ; le client
recharge par les routes ci-dessus. Types : `liste.creee|renommee|supprimee`, `article.ajoute|modifie|pris|libere|coche|decoche|supprime`,
`tache.creee|modifiee|assignee|supprimee` (un changement sans effet — déjà coché, déjà pris par moi — et un refus ne poussent rien).
**Révocation active** : l'appartenance, la session et l'état du compte (ni suspendu ni anonymisé) sont relus en base **avant chaque envoi** (et à chaque battement) ; un membre retiré ne
reçoit rien et son flux se ferme. Pas de reprise par `Last-Event-ID` : le client recharge tout à chaque (re)connexion. Proxy : prévoir un
`proxy_read_timeout` supérieur à 25 s (celui de Nginx Proxy Manager, 60 s par défaut, convient).

Registre de cloisonnement : `app/tests/cloisonnement/registre.ts` recense chaque route et son exigence ; le test de
complétude échoue si une route montée n'y figure pas (les routeurs se montent avec `monter()`, `http/montage.ts`).

Requêtes sortantes : **tout** appel vers un hôte dont l'URL vient de l'extérieur passe par
`app/server/services/requete-epinglee.ts` (`resoudreEtVerifier` puis `envoyerEpingle`) — une seule résolution DNS,
connexion épinglée sur une adresse déjà vérifiée (donc pas de rebinding), refus dès qu'**une** adresse résolue n'est
pas autorisée, aucune redirection suivie. Son paramètre `autoriserPrive` est obligatoire, sans valeur par défaut :
Immich le met à `ATTROUPE_IMMICH_ALLOW_PRIVATE` (l'instance est légitimement privée en homelab), le Web Push le met à
`false` en dur, parce que son URL est choisie par n'importe quel compte. **N'écris pas une seconde implémentation** :
ce module était dupliqué, et c'est par là qu'une SSRF est revenue (voir
[`ADR-0012`](docs/decisions/ADR-0012-push-navigateur.md)).

Cadence (en mémoire, 15 min, report exponentiel au-delà), clés par **couple (e-mail, IP)**, par e-mail
seul (large), par IP (/64 en IPv6) et par réseau /48 IPv6 : connexion 10 / 100 / 30 / 90 ; inscription
5 / 30 / 10 / 30 ; mot de passe oublié 5 / 30 / 20 / 60 ; jeton 30 / 90 par IP / réseau ; changement de
mot de passe 5 par compte ; renvoi de vérification 3 par compte. Un tiers ne bloque donc pas le
propriétaire depuis une autre IP. Une requête refusée en 429 ne crée aucune clé, une clé bloquée n'est
jamais évincée, un 503 ne débite rien. Réponse 429 + `Retry-After`. Les liens des e-mails portent le jeton dans le **fragment**
(`/verification-email#jeton=…`, `/reinitialisation#jeton=…`, `/invitation#jeton=…`), que le navigateur n'envoie
jamais au serveur. Ces trois pages se reconnaissent au **chemin** (`app/client/src/lien.ts`), parce que le routeur
ordinaire du client route sur le fragment, déjà occupé par le jeton ; le serveur sert n'importe quel chemin hors
`/api` avec `index.html`. Les tables des deux côtés sont confrontées par `app/tests/unite/liens-email.test.ts` :
ajouter un gabarit à jeton sans écrire la page du client échoue aux tests.

## 8. Dette technique, TODOs & points d'attention

- Modèle de données et architecture : **écrits** (`03` et `04` du dossier de conception). Le découpage
  est au §10 de `04` : **lots 0 à 12 livrés** (socle, base et cloisonnement, comptes, groupes et
  membres, agenda du groupe, flux iCal, listes de courses / tâches / temps réel, sondages de dates,
  agenda personnel, notifications, dépenses, discussions, albums photos Immich, finition :
  `/api/version`, page `#/exploitation`, PWA installable, option `include_personal` dans l'UI iCal,
  scripts `scripts/sauvegarde.sh` et `scripts/restauration.sh`).
- `ADR-0008` est **Acceptée** (lot 1). À revoir quand `node:sqlite` passera en « Stable ».
- Lot 1 livré, puis corrigé après revue : `app/server/db/` (`base` : connexion opaque, `connection`,
  `migrate`, `moteur`, `scope` : GroupScope, `portee-utilisateur`, `sql` : garde du SQL brut,
  `identifiant` : UUID v7, `queries/transverse`) et `0001_socle.sql`. Les filtres sont des listes
  `{ colonne, operateur, valeur }` (plus de clause SQL en chaîne libre) ; la connexion n'est pas
  utilisable hors de `db/` ; `creerScope(base, userId, groupId)` relit l'appartenance en base.
  Aucune route ne s'en sert encore (lots 2 et 3). Le serveur ouvre et migre
  `$ATTROUPE_DATA_DIR/attroupe.sqlite` au démarrage ; une migration modifiée après coup, ou un
  `PRAGMA foreign_keys` inactif, font échouer le démarrage.
- Lot 2 livré (comptes) : `db/queries/comptes.ts` (comptes, sessions, jetons ; migration
  `0002_verification_email.sql`), file d'e-mails dans `db/queries/transverse.ts` (`email_outbox`),
  `services/` (`mot-de-passe` scrypt, `cadence`, `authentification`, `emails`, `brevo`, `taches`),
  `http/middleware/` (`journal`, `csrf`, `session`, `cadence`, `erreurs`), `http/routes/{auth,moi}.ts`,
  `i18n/fr.json` (textes des e-mails). Ordre sur `/api` : journal → CSRF → corps JSON (16 Ko) → session →
  routes (cadence posée par route) → 404 → erreurs. Brevo est facultatif : sans `BREVO_API_KEY` les
  e-mails restent en file (`email.non_configure` au démarrage, `service_email` dans `/api/moi`). La
  file ne contient **aucun jeton** : elle ne garde que l'identifiant de la ligne de jeton, le jeton naît à
  l'envoi (`services/brevo.ts`, `armerJetonEnvoi`) et sa validité part de l'envoi. Une clé Brevo refusée
  (401/403) ne consomme pas les essais. Une session ne s'ouvre que sur un `CompteProuve`
  (`prouverParMotDePasse`). Ouvert : avatar, inscription sur invitation (lot 3, avec le rattachement
  conditionné à `email_verified_at`), pages du client.
- Lot 4 livré (agenda du groupe) : `domain/evenements.ts` (règles de date), `db/queries/evenements.ts`,
  `services/evenements.ts`, `http/{schemas,routes}/evenements.ts`, et côté client `agenda/dates.ts`,
  `pages/{Agenda,Evenement}.tsx`, `components/FormulaireEvenement.tsx`. Le registre de cloisonnement
  connaît une exigence `organisateur` de plus, et la suite générique une étape 4 ter : une
  co-organisatrice simple membre ne doit pas recevoir 403, et quelqu'un sans droit qui forge une
  ressource d'un autre groupe doit recevoir 404 — c'est ce qui prouve l'ordre « trouver puis
  autoriser ». Sans cette étape, une route déclarée `organisateur` mais réservée à l'admin passait la
  suite sans un bruit (démontré par mutation). **Ouvert** : l'interface n'a jamais été ouverte dans un
  navigateur et il n'existe aucun test de composant React (pas d'outillage client) ; le fuseau horaire
  se saisit en texte libre dans le formulaire, sans liste déroulante ; `PATCH` reste permis sur un
  événement annulé (sans danger : aucun champ `status` au schéma) ; aucun test ne force le retour
  arrière de la transaction de création.
- Lot 5 livré (flux iCal) : `domain/{ical,jetons}.ts`, `db/queries/flux.ts`, `services/flux-ical.ts`,
  `http/middleware/jeton-flux.ts` (**troisième chemin d'entrée** autorisé à fabriquer une portée, après
  `appartenance.ts` et `session.ts`), `http/routes/ical.ts`, et côté client `pages/Compte.tsx`. La garde du SQL brut
  porte une **cinquième exception nommée** (`calendar_feed_tokens` par `token_hash = ?`), plus étroite que celle des
  invitations : `SELECT` seul, une table, aucune jointure, `token_hash` jamais en `SET` — bornes et raisons dans
  l'ADR-0010.
- **Le verrou n° 3 était contournable depuis le lot 1**, et c'est corrigé ici : la règle ESLint comparait le *texte*
  de l'import, si bien que `../../db/queries/../scope.js` et `../../db/.//scope.js` passaient alors que
  `../../db/scope.js` était bloqué. La barrière réelle est désormais le test par **chemin résolu**
  (`app/tests/fixtures/verrou-db.ts`), étendu à `scope`, `portee-utilisateur`, `sql` et `migrate` avec la liste
  nominative des fichiers autorisés ; la règle ESLint est conservée pour le retour immédiat à l'édition. Ré-exports,
  import dynamique, `require` et import d'espace de noms sont refusés.
- **Ouvert sur le lot 5** : aucun test sur un vrai iPhone ou Android — le critère n° 2 de la vision (« une URL collée
  dans le calendrier d'un téléphone fait apparaître les soirées ») reste à valider à la main ; un événement horodaté
  sans `ends_at` n'a pas de `DTEND` et s'affiche comme un point ; troncature silencieuse à 1000 événements par groupe
  et par ensemble ; un événement commencé avant la fenêtre et fini dedans n'est pas servi s'il n'a pas été modifié ;
  les abonnés passant par iCloud ou Google partagent le plafond de cadence par IP.
- **`GET /api/version` livrée au lot 12** : montée dans `app/server/http/app.ts` via `routesVersion`,
  lit la dernière migration dans `schema_migrations`, et alimente le pied de page ainsi que `#/exploitation`.
- **Les abonnements iCal se rafraîchissent à la cadence du client, pas à la nôtre, et Google est lent.**
  Constaté le 2026-11-16 sur la bêta : un abonnement créé dans Google Agenda n'avait toujours provoqué
  **aucune** requête sur `/ical/…` côté serveur (aucun agent Google dans les journaux du proxy), alors que
  le même fichier était servi en 200 à Safari sur iPhone. Google décide seul du moment de sa première
  récupération — souvent plusieurs heures — puis rafraîchit toutes les 8 à 24 h, sans aucun moyen de
  forcer. Conséquence sur le **critère de réussite n° 2** de la vision (« une modification se propage, une
  annulation disparaît ») : sur Google Agenda, la propagation se compte en heures, et ce n'est pas un
  défaut de notre code. Sur iOS, un abonnement enregistré « Sur mon iPhone » se rafraîchit à l'intervalle
  choisi (jusqu'à 5 min) et se force en tirant la liste des calendriers vers le bas — c'est donc le seul
  chemin qui permette d'éprouver la propagation à la main. À dire dans la documentation utilisateur, pour
  que personne ne prenne la lenteur de Google pour une panne de l'application.
- **CORRIGÉ : l'application ne proposait aucun lien `webcal://`, donc l'abonnement iCal échouait en pratique.**
  Trouvé le 2026-11-16 en éprouvant la bêta sur un vrai iPhone : `POST /api/moi/flux-ical` ne renvoyait qu'une
  URL `https://`. Sur iOS, ouvrir un lien `https` vers un `.ics` **télécharge** le fichier (copie unique, jamais
  rafraîchie) ; seul `webcal://` crée un **abonnement**. Le serveur était irréprochable (le transport `webcal://` →
  `http` → 301 → `https` → `200 text/calendar` a été vérifié) : c'était le schéma donné à l'utilisateur qui était
  faux. Correction : `POST` renvoie `url` et `url_webcal` (`domain/jetons.ts` : `urlFlux`, `urlWebcal`), et
  `pages/Compte.tsx` fait de « Ajouter à mon calendrier » (`<a href="webcal://…">`) l'action principale, avec l'URL
  `https` en dessous pour Google Agenda, l'explication abonnement / copie figée et l'avertissement sur la lenteur de
  Google. Le lien complet reste affiché **une seule fois** (le jeton est haché) : un lien perdu se révoque et se
  recrée. Leçon : aucun test automatique n'aurait trouvé ça — il fallait un vrai téléphone.
- Le cloisonnement entre groupes est le risque numéro un du projet : il se traite par des
  tests dédiés, route par route (voir `ADR-0002`).
- L'ajout d'un membre par son nom d'utilisateur ou son e-mail est une surface d'abus : l'ajout
  crée une **invitation à accepter**, jamais une adhésion d'office, et il n'y a pas d'annuaire
  consultable (correspondance exacte seulement).
- Le sous-domaine public n'est pas choisi.
- **Licence AGPL-3.0** retenue avant la première publication : pour une application servie par
  le réseau, c'est elle — et non la GPL — qui oblige celui qui héberge une version modifiée à
  publier ses modifications. Même choix que Glassboard.
- Lot 6 livré (listes de courses, tâches, temps réel) : `db/queries/{listes,taches}.ts`, `services/{listes,taches-evenement,temps-reel}.ts`
  (`services/taches.ts` est déjà le planificateur du processus), `http/{schemas,routes}/{listes,taches}.ts`,
  `http/routes/temps-reel.ts`, et côté client `api/{listes,taches,tempsReel}.ts`, `pages/{Listes,Liste}.tsx`,
  `components/TachesEvenement.tsx` (tâches et listes visibles depuis l'événement). Changements transverses : le scope accepte des
  `conditions` sur `modifier` / `modifierPar` (écriture conditionnelle) ; **`executerEnTransaction` est en `BEGIN IMMEDIATE`** (trouvé par un
  test à plusieurs processus : le `BEGIN` différé échouait en `SQLITE_BUSY`) ; `ErreurHttp` peut porter des `donnees` publiques (le nom du
  preneur d'un 409) ; `index.ts` ferme les flux à l'arrêt. Le registre de cloisonnement connaît `flux: true` et les ressources `liste`,
  `article`, `articleVoisin`, `tache`.
- **Ouvert sur le lot 6** : l'interface n'a jamais été ouverte dans un navigateur, ni sur un vrai téléphone (le critère n° 3 est prouvé côté
  serveur par des tests, pas à la main) ; la reconnexion automatique d'`EventSource` n'est vérifiée que par lecture du code ; un membre retiré
  dont l'onglet reste ouvert réessaie (30 s) indéfiniment (404 muet) ; sur macOS, lancer `npm test` deux fois de suite en moins d'une minute
  peut épuiser les ports éphémères (`EADDRNOTAVAIL`, supertest ouvre un serveur par requête) — attendre 30 s. C'est `connect EADDRNOTAVAIL 127.0.0.1:<port>` : sans gravité, sans rapport avec le code testé ; peu probable sous Linux.
- **Audit UI / UX / frontend du 2026-11-18** :
  [`docs/audits/2026-11-18-ui-ux-frontend.md`](docs/audits/2026-11-18-ui-ux-frontend.md). Note globale
  5/10 : les fonctions de la V1 sont là, la couche d'usage ne l'est pas. Les huit constats critiques,
  tous vérifiés dans le code : les erreurs ne sont ni stylées ni correctement traduites
  (`components/Erreur.tsx:7` et `:11` — la classe `.erreur` n'est référencée par aucun TSX, et
  `messageDe` cherche la clé inexistante `erreur.erreur.interne`) ; 14 chemins d'écriture sans garde de
  double soumission, dont la création d'une dépense et d'un règlement ; des destructions irréversibles
  en un clic sans confirmation (dépense, créneau de sondage et ses votes) alors que
  `PATCH /depenses/:id` n'est pas exposé ; toute erreur non-401 au démarrage bloque sur « Chargement… »
  (`app/client/src/App.tsx:127-137`) ; le premier abonnement iCal détruit l'adresse secrète avant
  qu'elle soit lue (`pages/Compte.tsx:556-583`) ; `input:focus { outline: none }` (`styles.css:665`)
  rend le focus clavier invisible sur les cases et les radios ; douze contrastes sous le seuil WCAG AA,
  calculés, dont les boutons de vote à 3,19:1 et les bordures de champ à 1,26:1 ; et `Liste.tsx`
  efface le message « déjà pris par X » en 150 ms. À noter aussi, **dans l'état audité** : seuls les
  messages de discussion déclenchaient une notification (`app/server/services/fils.ts:57` était le seul
  appelant de `notifierMembresGroupe`, alors que `fr.json` promettait « nouvel événement, message ou
  dépense ») — corrigé depuis, voir la phase 2 ter plus bas ; et dix
  capacités du serveur n'avaient aucune porte d'entrée dans l'interface (mot de passe, sessions, profil et
  fuseau, modification d'une dépense, renommage d'un groupe et d'un album, modification d'un créneau
  personnel). Le plan d'action en trois phases est au chapitre 5 du rapport.
- **Phase 1 de l'audit appliquée (quick wins).** Sont corrigés : les erreurs stylées et la clé de
  repli de `Erreur.tsx` ; le chargement infini au démarrage, qui devient un écran d'erreur avec
  « Réessayer » (sans démonter l'arbre d'un utilisateur déjà connecté, car `recharger` sert aussi
  après une photo changée ou un groupe quitté) ; l'adresse de flux iCal qui n'était plus affichée au
  premier abonnement ; le message « déjà pris par X » effacé en 150 ms dans `Liste.tsx`, et les mises
  à jour optimistes désormais annulées sur échec ; le focus clavier sur les cases et les radios ; les
  douze contrastes sous le seuil AA, via des tokens `--accent-*-texte` distincts des accents de
  remplissage ; `overflow-x: clip` qui rend l'en-tête collant réellement collant ; les cibles
  tactiles sous 44 px ; le codage couleur par groupe du calendrier mensuel ; « Inter », jamais
  chargée, retirée de la pile ; `color-scheme`, `prefers-reduced-motion` et la garde `hover: hover` ;
  une classe `.ligne` inerte distincte de `.ligne-interactive` ; `inputMode="decimal"` et les dates
  calculées en local et non en UTC dans les dépenses ; les `aria-label` qui nomment leur cible ; les
  libellés nus et le vocabulaire unifié ; l'orthotypographie française de `fr.json` (195 valeurs) ;
  environ 130 lignes de CSS mort et 6 clés mortes supprimées, ainsi que `pages/Accueil.tsx`.
- **Phase 2 de l'audit appliquée : trois briques partagées, puis leur diffusion.** Les briques sont
  les points d'entrée à connaître avant d'écrire une vue :
  - `app/client/src/hooks/useSoumission.ts` — garde de double soumission. La garde EST une `ref`
    posée avant l'appel, pas un `useState` : une mise à jour d'état est asynchrone et ne bloque pas
    un second clic survenu dans le même tick. `disabled={enCours}` seul ne protège donc de rien.
    Appliquée aux chemins d'écriture, dont la création d'une dépense, qui créait deux dettes.
  - `app/client/src/hooks/useLecture.ts` — lecture à trois états (`chargement`/`erreur`/`pret`) avec
    garde d'annulation par compteur de génération, en remplacement du schéma recopié 56 fois.
    `recharger()` repart de zéro ; `rafraichir()` relit SANS vider l'écran, et c'est lui qu'il faut
    après une action de l'utilisateur. **Il ne remplace pas `api/rechargement.ts` (`useRechargement`)
    pour le SSE** : chaque message temps réel ferait clignoter le squelette.
  - `app/client/src/components/DialogueConfirmation.tsx` — modale sur l'élément natif `<dialog>` +
    `showModal()`, qui fournit le piège à focus, Échap et `aria-modal`. Le focus arrive sur
    « Annuler », jamais sur le bouton destructeur. Elle remplace les 8 `window.confirm` et le
    `window.prompt`, et couvre les destructions qui n'avaient aucun garde-fou : une dépense, un
    créneau de sondage et ses votes, la conversion d'un sondage, un article de liste, la promotion
    d'un membre en administrateur. Les textes vivent dans `fr.json` sous `confirm.<domaine>.<action>.
    {titre,consequence,action}` : un titre qui pose la question, une conséquence qui dit ce qui sera
    perdu, et un libellé de bouton en verbe + objet.
  - Aussi : traitement central du 401 (`api/client.ts` émet `SESSION_EXPIREE`, la coque écoute et ne
    bascule que si elle se croyait connectée), réponse de présence enregistrée au clic, fusion des
    messages de discussion par `id` au lieu d'un remplacement qui perdait l'historique chargé,
    visionneuse photo sur `<dialog>`, et `loading="lazy"` sur les vignettes.
- **Phase 2 bis de l'audit appliquée : trois chantiers structurants.**
  - **`FournisseurGroupe` et flux SSE unique** (ADR-0014, à lire avant d'y toucher). Quatre points
    d'entrée à connaître : `components/FournisseurGroupe.tsx` (le fournisseur, `useGroupe` et
    `useTempsReelGroupe`), `api/canalGroupe.ts` (le multiplexeur, sans React ni `EventSource`) et
    `hooks/etatsLecture.ts` (`fusionnerEtats`, `premiereErreur`). **La règle : un abonné filtre, il
    n'ouvre pas de connexion.** Onze appels à `lireGroupe` sont devenus un par entrée dans un groupe
    et zéro en navigation interne ; six connexions SSE sont devenues une par onglet, ce qui double la
    marge sous le plafond de 8 par compte. `useTempsReel` est supprimé — volontairement, pour que la
    compilation échoue sur tout site non migré. `EnteteGroupe` est devenu présentationnel et a perdu
    `groupId`, `nomGroupe` et `photosActives` : plus de saut de titre. Deux pages attendent
    nécessairement le groupe à la première entrée (`Albums` pour `fonctionnalites.photos`, `Groupe`
    pour `mon_role`) ; ailleurs les lectures partent en parallèle et `fusionnerEtats` garde un seul
    squelette. Piège à ne pas « corriger » : `onOuvert` est rejoué à **chaque** reconnexion et à un
    abonnement tardif ; le désarmer arrêterait le temps réel en silence après la première coupure
    réseau (test `app/tests/unite/canal-groupe.test.ts`, cas « deux ouvertures »).
  - **`TableauDeBord.tsx` découpé** : 1043 → 232 lignes, en `pages/tableau/` (`selecteurs.ts` pour les
    dérivations pures, `formats.ts`, et un fichier par bloc d'affichage) plus `hooks/useTableauDeBord`
    et `hooks/useFenetreCalendrier`. Lève M2 : les KPI, les événements à venir, les soldes, les photos
    et les groupes ne bougent plus quand on navigue dans le calendrier. **`useTableauDeBord` passe une
    fenêtre explicite bien qu'elle reproduise l'horizon par défaut du serveur** : c'est sa *présence*
    qui lève le plafond de 12 événements de groupe et 8 personnels, tous groupes confondus, à 200
    (`db/queries/tableau-de-bord.ts`, `MAX_EVENEMENTS_FENETRE`). Sans elle, filtrer sur le groupe le
    moins chargé affichait « Aucun événement » alors que la grille du mois montrait l'événement juste
    à côté.
  - **Les écrans de compte qui manquaient** : `components/CarteProfil.tsx` (nom affiché, fuseau en
    `<input list>` alimenté par `Intl.supportedValuesOf`, bandeau d'adresse non confirmée) et
    `components/CarteSecurite.tsx` (mot de passe, liste et révocation des appareils), sur un
    `api/compte.ts` créé de zéro : les six routes `/api/moi` existaient et **aucune** n'était appelée
    par le client. La session courante n'a pas de bouton de révocation (s'en déconnecter depuis cet
    écran serait un piège). Le changement de mot de passe **révoque les autres sessions et pivote la
    courante** (`db/queries/comptes.ts:512-539`) : le message de succès le dit.
  - L'anniversaire n'est pas exposé : l'API accepte aussi la forme `--MM-JJ` (sans année), qu'un
    `<input type="date">` ne sait ni afficher ni renvoyer. Le client n'envoie que les champs modifiés,
    donc une date saisie sans année n'est pas écrasée.
- **Un risque latent figé par un test, pas corrigé** : dans `pages/tableau/selecteurs.ts`, le tri
  compare `starts_at` en chaîne — donc en UTC pour un événement à heure fixe, et en date locale pour
  une journée entière. Entre minuit local et minuit UTC, l'ordre affiché peut être faux (visible pour
  un fuseau à l'est, type Tokyo). Comportement antérieur au découpage, figé par
  `app/tests/unite/tableau-selecteurs.test.ts` plutôt que modifié à l'aveugle.
- **Phase 2 ter appliquée : trois chantiers.**
  - **Gouvernance des tokens du design system** (ADR-0015, à lire avant de toucher à `styles.css`).
    0 couleur littérale hors `:root`, un seul `--c` par élément porteur de couleur, et des échelles
    d'espacement, de rayon, d'ombre, de taille, de z-index, de durée et de flou. **La cible navigateur
    est désormais déclarée** — Chrome 111+, Safari 16.4+, Firefox 113+ — parce que `color-mix()` est
    employé 71 fois ; il n'existait aucun `browserslist` avant. Piège documenté dans l'ADR : nos
    `color-mix()` contiennent tous un `var()`, donc la déclaration est acceptée à l'analyse puis
    devient invalide au calcul et la propriété repasse à `unset` — **une déclaration littérale placée
    juste avant ne sert pas de repli**. Cinq tokens de voile sur photo et de fond de visionneuse ont
    donc une valeur `rgba` dans `:root`, surchargée sous `@supports` ; ombres et effets de verre n'en
    ont pas, volontairement.
  - **Les contrastes, pour de bon.** La passe précédente mesurait sur fond blanc, qui n'existe nulle
    part dans l'application. Sur les fonds réellement composés (dégradé de `body::before`, verre,
    `--primaire-clair` de la case du jour, puis la teinte), le cyan tombait à 3,72:1 et le violet à
    3,80:1 pour du texte de 0,7 rem. Quatre tokens de texte assombris, pire cas remonté entre 4,6 et
    5,3:1, vérifié par deux calculs indépendants. **Un ratio se calcule sur le fond composé.**
  - **Parcours d'invitation réparé** : le jeton survit à la navigation (`invitationEnAttente.ts`,
    `sessionStorage`, tous les accès sous `try`/`catch` y compris l'accesseur), le fragment est retiré
    de l'URL dès l'arrivée — sinon il survivait à la déconnexion sur un poste partagé —,
    « Reprendre l'invitation » après confirmation d'adresse, et le 403 `invitation.adresse_non_verifiee`
    propose de renvoyer le lien. **Il n'existe aucune route serveur pour refuser une invitation par
    jeton** (seul `POST /api/moi/invitations/:id/refus` existe, et il filtre sur `target_user_id`, que
    les invitations par e-mail n'ont pas) : le bouton s'appelle donc « Mettre l'invitation de côté » et
    les textes disent exactement ce qu'il fait.
  - **Les notifications ne couvrent plus que les messages** : `event_created` et `expense_added` sont
    émis, y compris pour un événement né de la conversion d'un sondage. Les deux genres existaient déjà
    dans le `CHECK` SQL, aucune migration n'a été nécessaire. « La dépense me concerne » = le payeur
    plus les porteurs d'une part non nulle, moins l'auteur. Ni montant, ni libellé, ni titre, ni lieu
    n'est exposé dans l'e-mail ou le push — choix plus strict que celui du message. Coût **mesuré** de
    `notifierMembresGroupe` dans la transaction : 17,6 ms médians pour 50 destinataires sous
    `BEGIN IMMEDIATE`, ~3 à 4 ms pour 10 membres.
- **Trois dettes à traiter avant d'ouvrir au groupe réel :**
  - **`notification_preferences.muted_kinds` n'est lue nulle part.** Avec un seul genre émis, sans
    conséquence ; avec trois, un trésorier qui saisit 30 dépenses un dimanche soir envoie 30
    notifications, 30 pushs et 30 e-mails à chaque participant, et le seul levier est tout ou rien.
    La réaction prévisible est de tout couper, messages compris. Minimum utile : lire `muted_kinds`
    dans `notifierMembresGroupe` après le filtre SQL, sans changer de schéma.
  - **Les écritures suivantes ne notifient pas** : `modifierDepenseService`, `supprimerDepenseService`,
    `creerRemboursementService` et `confirmerRemboursementService` font bouger les soldes en silence.
    Une part qui passe de 0 à 50 € par modification ne prévient personne.
  - **La notification de règlement demande une migration** : ni `settlement` dans le `CHECK kind`, ni
    dans `CHECK subject_type`. SQLite ne modifie pas un `CHECK`, et aucune migration du projet n'a
    jamais reconstruit une table (0002 à 0005 ne font que `CREATE TABLE` et `ADD COLUMN`). Il faudrait
    une 0006 par table neuve + `INSERT … SELECT` + `DROP` + `RENAME`, soit ~8 fichiers touchés ; et
    `app/tests/schema/migrations.test.ts:101` liste les versions attendues en dur, il faudra le
    toucher. Risque principal : un `INSERT … SELECT` qui oublie une colonne perd des données en
    silence. `VACUUM INTO` sauvegarde avant migration.
- **Restent la phase 2 ter (fin) et la phase 3** : mode sombre (les tokens le permettent désormais ;
  attention, le bloc `@supports` des voiles doit être redéfini lui aussi, et `theme-color` est figé
  dans `index.html`), validation champ par champ des dépenses, pagination des six listes non bornées,
  suppression de groupe, remboursements actionnables, sortie du type de liste hors du titre,
  accessibilité structurelle et route `introuvable`.
- **Fragilité de test confirmée, et sa signature** : un `npm test` lancé juste après un
  `npm run typecheck` a donné 42 échecs sur 2 fichiers, puis deux runs espacés ont été entièrement
  verts (1659 tests). Rejoué sur la phase 2 bis : `npx vitest run` en un seul bloc donne 49 échecs,
  tous dans `app/tests/cloisonnement/suite-generique.test.ts`, avec
  **`Error: connect EADDRNOTAVAIL 127.0.0.1:<port>`** — c'est la signature à reconnaître. Le même
  répertoire lancé seul passe (458 tests). Et ce n'est pas réglé en
  découpant : les trois répertoires enchaînés dans une **même** commande donnent 63 échecs sur l'intégration, pour
  la même raison, alors que chacun lancé seul passe (562, 458 et 431 tests). Donc : lancer `app/tests/unite`,
  `app/tests/cloisonnement` et `app/tests/integration` séparément **et espacés**, et ne jamais conclure à une
  régression de cloisonnement sur un run en bloc sans avoir regardé la cause de l'échec.
- **Un test de plafond était trop juste sous charge** : `app/tests/unite/ics-entrant.test.ts`,
  « plafond de plages brutes (mémoire) », déroule ~1 million de plages. Deux gardes s'y font la course
  par construction — le plafond mémoire et le budget de temps (`PLAFONDS.tempsMs`, non injectable) —
  et sous charge c'est le budget de temps qui tombe le premier. Exiger `plagesBrutes` rendait le test
  instable deux fois sur trois. Il exige désormais qu'**une** garde coupe, avec un délai explicite de
  20 s. **Dette assumée** : il n'existe plus de test déterministe du seul plafond mémoire ; le budget
  de temps, lui, garde le sien à horloge simulée.
- **Trois tests avaient un délai par défaut trop court, et c'est maintenant explicite.** Le délai de
  5 s de vitest fait échouer un test **avant qu'il asserte** : il « échoue » alors sur sa durée, pas
  sur ce qu'il mesure, et on finit par le classer comme instable et ne plus le lire. Les trois cas :
  - `app/tests/integration/auth-securite.test.ts`, « la durée ne trahit pas l'existence de l'adresse »
    (connexion et inscription) : 30 requêtes scrypt à N=2^14 chacun, avec 27 workers concurrents.
    Antériorité **prouvée par mesure**, en rejouant la suite sur un instantané `git archive` de `HEAD` :
    mêmes deux échecs. L'assertion porte sur l'écart ENTRE deux cas, pas sur une durée absolue :
    allonger le délai ne relâche donc rien.
  - `app/tests/cloisonnement/verrou-db.test.ts`, « aucun fichier ne contourne le verrou » : il résout
    les imports de tout le dépôt, donc il s'allonge à mesure que le projet grossit. C'est un garde-fou
    de sécurité : il doit échouer pour ce qu'il mesure, ou pas du tout.
  - `app/tests/unite/ics-entrant.test.ts`, le plafond de flux iCal (voir ci-dessus).
