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
| GET | `/api/moi/flux-ical` | Mes abonnements : `label`, groupe éventuel, drapeaux, `last_used_at`, `last_user_agent`. **Jamais le jeton** (stocké haché). |
| POST | `/api/moi/flux-ical` | `{label?, group_id?, include_personal?, include_declined?}` → 201 **avec le jeton en clair, une seule fois**. 404 `groupe.introuvable` si l'appartenance n'est pas active. Plafond de 20 abonnements non révoqués (409 `flux.plafond`) + cadence `abonnement`. |
| DELETE | `/api/moi/flux-ical/:fluxId` | Révoque (`revoked_at`, jamais de suppression). 404 si ce n'est pas le mien. |
| GET | `/ical/:jeton.ics` | **Hors `/api`, sans cookie.** 404 identique pour un jeton inconnu, mal formé ou révoqué. Cadence 60/h par jeton (+ IP et réseau). `Cache-Control: private, max-age=300`, `ETag` et `304`. |

Jeton : 32 octets en base32 minuscule (`^[a-z2-7]{52}$`, forme vérifiée **avant** la base), stocké haché en SHA-256.
`ETag` = empreinte **exacte** du flux (`id|updated_at|nom de l'auteur` de chaque événement servi, trié puis haché),
et non `(max, count)` : deux réponses de présence échangées changent le contenu sans changer le nombre ni le
`max(updated_at)`, et donneraient sinon un `304` qui laisse un agenda faux sur le téléphone. Un `304` ne coûte que
les agrégats, sans lecture d'événement. `DTSTART` en UTC pour les événements horodatés, `VALUE=DATE` pour les
journées entières (écart à §7.1 acté par l'ADR-0010) ; `include_personal` est stocké mais **sans effet** jusqu'au
lot 8.

Registre de cloisonnement : `app/tests/cloisonnement/registre.ts` recense chaque route et son exigence ; le test de
complétude échoue si une route montée n'y figure pas (les routeurs se montent avec `monter()`, `http/montage.ts`).

Cadence (en mémoire, 15 min, report exponentiel au-delà), clés par **couple (e-mail, IP)**, par e-mail
seul (large), par IP (/64 en IPv6) et par réseau /48 IPv6 : connexion 10 / 100 / 30 / 90 ; inscription
5 / 30 / 10 / 30 ; mot de passe oublié 5 / 30 / 20 / 60 ; jeton 30 / 90 par IP / réseau ; changement de
mot de passe 5 par compte ; renvoi de vérification 3 par compte. Un tiers ne bloque donc pas le
propriétaire depuis une autre IP. Une requête refusée en 429 ne crée aucune clé, une clé bloquée n'est
jamais évincée, un 503 ne débite rien. Réponse 429 + `Retry-After`. Les liens des e-mails portent le jeton dans le **fragment**
(`/verification-email#jeton=…`, `/reinitialisation#jeton=…`) : les pages du client restent à écrire.

## 8. Dette technique, TODOs & points d'attention

- Modèle de données et architecture : **écrits** (`03` et `04` du dossier de conception). Le découpage
  est au §10 de `04` : **lots 0 à 5 livrés** (squelette, base et cloisonnement, comptes, groupes et
  membres, agenda du groupe, flux iCal), le prochain est le lot 6 (listes de courses et tâches).
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
- Le cloisonnement entre groupes est le risque numéro un du projet : il se traite par des
  tests dédiés, route par route (voir `ADR-0002`).
- L'ajout d'un membre par son nom d'utilisateur ou son e-mail est une surface d'abus : l'ajout
  crée une **invitation à accepter**, jamais une adhésion d'office, et il n'y a pas d'annuaire
  consultable (correspondance exacte seulement).
- Le sous-domaine public n'est pas choisi.
- **Licence AGPL-3.0** retenue avant la première publication : pour une application servie par
  le réseau, c'est elle — et non la GPL — qui oblige celui qui héberge une version modifiée à
  publier ses modifications. Même choix que Glassboard.
