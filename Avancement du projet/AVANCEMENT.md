# Avancement — Attroupe

> Un bloc par jalon. Le plus récent en haut. On y note ce qui est **fait et vérifié**,
> pas ce qui est prévu (le prévu vit dans le dossier de conception).

## 2026-11-16 — Lot 4 : l'agenda du groupe

Neuf routes sous `/api/groupes/:groupId/evenements` : fenêtre d'agenda, création, détail, modification, annulation
(`status = 'cancelled'`, jamais de suppression physique), présences avec invités, compteurs, co-organisateurs.
L'événement et son fil de discussion (`threads.kind = 'event'`) naissent dans **la même transaction**. L'autorisation fine
(`peutModifierEvenement` : auteur, co-organisateur ou admin) est une **seconde** vérification, après le cloisonnement :
403 `droit.organisateur_requis` pour un droit manquant, 404 `evenement.introuvable` pour un groupe étranger, jamais l'un
à la place de l'autre. Les compteurs se calculent en SQL dans la portée du groupe. Client : vues mois / semaine / liste,
formulaire de création et de modification, détail avec les trois réponses et les compteurs. Aucune migration — les tables
`events`, `event_organizers` et `event_attendances` existaient depuis `0001_socle.sql`.

**Vérifié par exécution de ma part** : `lint`, `typecheck`, `build` verts, **881 tests** passés (1 ignoré, antérieur au lot),
`git diff app/server/db/sql.ts` vide (ni `TEXTES_TRANSVERSES` ni `ACCES_ALTERNATIFS` n'ont grossi). Le critère de « terminé »
du lot tient : trois comptes répondent (oui + 2 invités, peut-être + 4 invités, non) et les compteurs donnent
`{yes: 1, maybe: 1, no: 1, attendus: 3, sans_reponse: 1}`.

**Le défaut trouvé en revue, et confirmé par mutation.** Le lot a introduit une exigence `organisateur` dans le registre de
cloisonnement — donc modifié le harnais qui protège *toutes* les routes du projet. En réduisant `peutModifierEvenement` à
`return scope.role === 'admin'`, la suite de cloisonnement restait **entièrement verte** (318 tests) : les deux attaquantes
et la personne de contrôle étaient toutes administratrices, si bien qu'une route future déclarée `organisateur` mais
réservée en fait à l'admin aurait passé la suite sans un bruit. Corrigé : Carole, simple membre, est co-organisatrice de
l'événement de A (étape 4 ter : elle ne doit pas recevoir 403), Erin forge l'événement de B et doit recevoir **404** et non
403 (c'est ce qui prouve l'ordre « trouver puis autoriser » avec quelqu'un qui n'a aucun droit), et `registre.test.ts` exige
qu'une entrée `organisateur` déclare bien sa ressource `evenement`. La même mutation rejouée après correction fait échouer
les **4** routes `organisateur`, chacune nommée.

**Autres corrections après revue** : `PATCH` déclare enfin `host_membership_id` dans `ressourcesCorps` (il le lisait sans
que la suite ne le forge jamais) ; `du` devient obligatoire sur la fenêtre d'agenda, parce que sans lui la route renvoyait
les 1000 événements **les plus anciens** et escamotait silencieusement les soirées à venir ; l'auteur de l'événement est
exposé et affiché comme organisateur principal (la page annonçait « aucun organisateur ») ; la vue d'agenda ignore la
réponse d'une fenêtre abandonnée (deux clics rapides affichaient un mois vide) ; le fuseau est nettoyé au même endroit
pour la conversion des heures et pour `time_zone`.

**Non vérifié** : l'interface n'a jamais été ouverte dans un navigateur (typecheck, lint, build et tests des calculs de
dates seulement) ; il n'existe aucun test de composant React, faute d'outillage client dans le dépôt. Assumé : `capacity`
reste informative (un « oui » au-delà n'est pas bloqué), `responded_at` garde la première réponse, et `PATCH` reste permis
sur un événement annulé — sans danger, le schéma n'accepte aucun champ `status`, donc rien ne peut être « désannulé ».

## 2026-11-16 — Lot 3 : groupes, membres, invitations

Création de groupe, verrou 3 (`exigerAppartenance`, `exigerAdminGroupe`), membres, rôles, retrait, départ, invitations par e-mail
(lien à jeton, adresse vérifiée exigée) et par nom d'utilisateur exact (à accepter), règles d'intégrité (`ADR-0009`), registre de
cloisonnement + test de complétude + suite générique, client (connexion, sélecteur, groupe, invitations). La garde du SQL brut est
complétée de trois exceptions nommées (architecture §4 verrou 5) ; le canal transverse n'a pas grossi. Aucune migration.

**Corrections après revue** : une exception de la garde du SQL brut (reconnaître `invitations` par `target_user_id` ou
`token_hash`) s'était transformée en clé maîtresse, parce que la couverture se propageait par les jointures
`group_id = group_id`. Cinq requêtes admises à tort ont été rejouées et sont désormais refusées, dont
`UPDATE memberships SET role = 'admin'` et la réattribution d'une invitation. Règle posée : une couverture obtenue par une
colonne de preuve ne couvre que `invitations` et **ne se propage jamais** ; les colonnes de preuve sont interdites en `SET`.

## 2026-11-15 — Lot 2 : les comptes (écrit, en attente de revue)

Inscription, vérification d'e-mail, connexion par session opaque hachée, sessions multiples et
révocation, mot de passe oublié, `/api/moi`, cadence, CSRF par `Origin`, file `email_outbox` et
service Brevo. Migration `0002_verification_email.sql` (34 tables). Vérifié par exécution : parcours
complet en `curl` contre le serveur lancé, cadence, CSRF, file contre un faux Brevo (panne puis
rétablissement), `docker build` et `/api/sante` à 200. **Non vérifié** : un envoi réel (pas de clé
Brevo). Détail et écarts avec l'architecture §5 : voir le rapport de lot.

**Corrections après revue** : cadence rétablie par couple (e-mail, IP) + clé e-mail large + /48 IPv6
(la spécification §5 avait été réécrite pour coller au code : le texte d'origine est rétabli et précisé),
table de clés qui n'évince plus un blocage en cours, `POST /api/moi/mot-de-passe` et renvoi du mail de
vérification, jetons d'e-mail fabriqués à l'envoi (plus aucun jeton dans la file), `CompteProuve`
exigé pour ouvrir une session, 401/403 de Brevo sans consommation d'essais.

## 2026-11-15 — Lot 1 : la base et le cloisonnement

33 tables, le `GroupScope`, la `PorteeUtilisateur`, le moteur de filtres et la garde du SQL brut.
**488 tests** (102 au lot 0). Trois passes ont été nécessaires : la première a été refusée par la
revue sur une **fuite de lecture entre groupes**.

### Ce qui a été trouvé, et fermé

| Défaut | Comment il a été trouvé | État |
|---|---|---|
| **Fuite entre groupes** : la clause de filtrage était une chaîne libre, filtrée par liste noire ; les identifiants entre crochets de SQLite (`[(]`) déséquilibrent le compteur de parenthèses. `CAST(1 AS [(]) = 1) OR 1=1 OR (CAST(1 AS [)]) = 1` lisait l'événement d'un autre groupe | revue, rejouée par l'orchestrateur | fermé : plus de chaîne libre, filtres `{colonne, operateur, valeur}`, colonne vérifiée contre `pragma_table_info`, opérateurs fermés, valeurs liées |
| **`creerScope` croyait l'appartenance qu'on lui passait** : affirmer « je suis membre de B » donnait accès à tout B | revue, rejouée | fermé : `creerScope(base, userId, groupId)` lit l'appartenance **active** en base |
| **La connexion brute sortait de `db/`** par le type de retour de `ouvrirEtMigrer`, redonnant `prepare()` sans garde — contraire à l'ADR-0008 | revue, rejouée | fermé : connexion **opaque à l'exécution** (`base.exec` n'existe plus hors de `db/`) |
| **Garde naïve** : elle exigeait la *mention* de `group_id`. `SELECT *, NULL AS group_id FROM events WHERE id = ?` lisait l'autre groupe | revue, rejouée | fermé : analyse par jetons, filtre lié exigé |
| **Six formes encore admises** par la garde réécrite, dont `ON CONFLICT … DO UPDATE` sans clause de portée (l'upsert écrit à la main réécrivait la ligne d'un autre groupe) et `id = ?` non qualifié qui couvrait `groups` | deuxième revue, les six rejouées par l'orchestrateur | fermé : sous-requêtes, alias réutilisés, `BETWEEN` et filtres non conjoints refusés ; `TEXTES_TRANSVERSES` gelé |
| **Jeton de flux iCal vers un groupe étranger** : un non-membre pouvait créer un jeton visant un autre groupe — un jeton de flux est un secret d'accès | deuxième revue, rejouée | fermé : appartenance active exigée à l'insertion ; le lot 5 devra la revérifier à chaque service du flux (§3.12) |
| **IDOR en puissance** : `mesGroupes(base, userId)` prenait un identifiant nu et était importable de partout | deuxième revue | fermé : `mesGroupes(portee)` |
| Rappel `async` dans `transaction` validé à moitié ; un membre pouvait répondre à une présence à la place d'un autre ; `app/tests/**` importable depuis `app/server/**` | deuxième revue | fermés |

### Corrections apportées à la migration `0001`, avant tout déploiement

Trois défauts de conception, corrigés tant que la reconstruction de table restait gratuite (en
SQLite, changer une contrainte après déploiement l'exige, et le moteur de migrations ne le
permet pas) :
- `personal_event_shares` pointait vers `groups` : on pouvait partager son agenda vers un groupe
  dont on n'est pas membre. Devenu `(membership_id, group_id)` avec clé étrangère composite.
- `personal_events` et `date_poll_options` n'avaient pas le contrôle de format de date de
  `events` (`'2026-12-01T20:00:00+'` était accepté).
- `date_polls.resulting_event_id` n'avait pas de clé étrangère : un sondage de A pouvait pointer
  vers un événement de B. La justification du §5.2 était fausse — SQLite accepte une référence
  vers une table créée plus loin.

### Vérifications de l'orchestrateur, indépendantes du rapport des agents

- `lint`, `typecheck`, `build` verts ; **488 tests** passés, 1 ignoré.
- Migration **identique** au §5 du modèle de données (`diff` vide), rejouée sur base neuve :
  33 tables, 33 `STRICT`, 40 index, intégrité correcte.
- **Preuve par mutation** : en rendant la marque du `GroupScope` facultative, `typecheck` échoue
  (`TS2578`). Le garde-fou est donc exécutoire, pas décoratif.
- **Charges rejouées à la main** : la fuite d'origine et trois variantes, les **six** formes
  admises par la garde, le scope forgé, le jeton iCal étranger, la lecture d'un identifiant de
  l'autre groupe — **toutes refusées**. Les cas légitimes passent (lecture du groupe,
  `scope.groupe()`, jeton sur son propre groupe).
- Image Docker reconstruite, conteneur répondant 200 sur `/api/sante`.

### Faux positifs assumés de la garde

`OR`, `BETWEEN`, `NOT EXISTS`, les sous-requêtes et `WITH` sont refusés ; la voie de
remplacement est écrite dans `04 - Architecture.md` §4 verrou 5 (`IN (?, ?)`, `>= ? AND <= ?`,
jointure, ou deux requêtes assemblées en TypeScript). **Ajouter un texte transverse pour
contourner un refus est explicitement interdit** : c'était la porte dérobée la plus probable.

### Reste ouvert

- `notifications.group_id` non contrôlé (une invitation précède l'appartenance).
- `email_outbox` sans portée : tout accès passera par le canal transverse.
- ADR-0008 passée en **Acceptée** : `node:sqlite` sait désormais faire `backup()` et
  `VACUUM INTO`, mais reste en « release candidate » ; `better-sqlite3` maintenu, à revoir.

## 2026-11-15 — Lot 0 : le squelette du dépôt

- Domaine **attroupe.fr acheté**.
- Premier code du projet : espaces de travail npm (`app/server`, `app/client`), TypeScript
  strict, ESLint en configuration plate, Vitest, `Dockerfile` multi-étapes,
  `docker-compose.yml`, `.env.example`, et les deux workflows (`ci.yml`, `image.yml`).
- **Vérifié par l'orchestrateur, en exécutant** : `lint`, `typecheck`, `build` et `test`
  (5 fichiers, 23 tests) passent ; le serveur démarre et `/api/sante` renvoie
  `200 {"status":"ok","version":"0.1.0"}` ; `/` sert le client ; `/api/inexistant` renvoie un
  404 en JSON ; la validation de l'environnement refuse de démarrer sans clé et liste tous les
  problèmes d'un coup, en français. `npm audit --omit=dev` : **0 vulnérabilité en production**
  (les 7 « moderate » sont dans l'outillage de développement).
- **Verrou n° 4 du cloisonnement en place** : une règle ESLint interdit d'importer
  `db/connection` — et les bibliothèques SQLite, par l'ADR-0008 — ailleurs que dans
  `app/server/db/`. Le `dev` l'a prouvée en la faisant mordre sur un fichier d'essai, supprimé
  depuis.
- **Conteneur vérifié** (Docker installé en cours de séance) : image construite
  (`docker build`, 376 Mo), conteneur démarré, `/api/sante` répond `200` depuis l'hôte, la page
  d'accueil est servie, le processus tourne bien en **non root** (`uid=1000(node)`) et le
  `HEALTHCHECK` passe à **healthy**. Construction multi-étapes conforme : `node:24-bookworm`
  pour la construction, `npm prune --omit=dev`, `node:24-bookworm-slim` à l'exécution,
  22 Mo d'application et de dépendances de production dans l'image finale.
- **Publié** : premier commit (69 fichiers, 10 674 lignes) poussé sur
  <https://github.com/Lokyron/Attroupe>, branches `main` et `beta` créées. Licence **AGPL-3.0**
  posée avant la publication.
- **Les quatre exécutions d'intégration continue sont vertes** (lint, types, tests et
  construction, sur `main` comme sur `beta`), et l'image est publiée sur GHCR : son manifeste se
  lit **sans authentification**, donc le paquet est bien public et l'installation par un tiers
  tient en une commande.
- **Le lot 0 est donc terminé**, critère de fin compris.
- À savoir : l'image publiée est **`linux/amd64` seulement** (les exécuteurs GitHub sont x86).
  C'est l'architecture des conteneurs 112 et 113, donc sans conséquence en production ; mais
  elle ne tourne pas telle quelle sur un Mac Apple Silicon — en local, `docker build` suffit.
  Ajouter `arm64` demanderait `buildx` et QEMU, et doublerait le temps de construction.
- `.claude/settings.json` : l'interdiction `Bash(git push:*)` a été levée sur accord explicite,
  en gardant une barrière sur `git push --force` et `-f` — on ne réécrit pas l'historique d'un
  dépôt public sans le demander.
### Revue du lot 0 : verdict **bloquant**, puis corrigé

Le `reviewer` (Opus 5.5) a rendu trois bloquants et seize points secondaires. Trois trouvailles
ont été re-vérifiées par l'orchestrateur avant correction, et tout a été re-vérifié après.

| Trouvaille | État |
|---|---|
| **Verrou ESLint contournable de onze façons** — dont un simple fichier-baril `db/index.ts` qui ré-exporte `connection.js`, écrit par réflexe au lot 1, faisait disparaître le verrou en silence | corrigé : motifs `regex`, extensions `mts`/`cts`/`js`/`mjs`/`cjs`, `no-restricted-syntax` contre les `import()` non littéraux, `require`, `createRequire` et **tout ré-export de `connection`, y compris dans `db/`** |
| **Validation acceptant des secrets factices** (`aaaa…`, trois secrets identiques, 32 octets nuls, valeurs contenant « remplacer ») | corrigé : base64 canonique, au moins 16 octets distincts sur 32, trois secrets deux à deux différents, mots interdits |
| **Jeton GHCR en écriture exposé** au job qui lance `npm ci` et les tests, et écrit dans `.git/config` par `actions/checkout` : un `postinstall` malveillant aurait pu publier une image piégée sur `:latest` | corrigé : `contents: read` au niveau du workflow, `packages: write` sur le seul job de publication, `persist-credentials: false` |
| **URL de base acceptant n'importe quel schéma** : `localhost:3000` et `javascript:alert(1)` passaient, alors qu'elle sert à fabriquer les liens des e-mails | corrigé : `http(s)` seulement, `https` imposé en production, ni chemin ni requête ni fragment |
| **Erreur d'écoute avalée** : port occupé → « à l'écoute » affiché puis sortie avec le code **0** | corrigé : message explicite et code 1 |
| Retour arrière impossible (seules `latest` et `beta` publiées) | corrigé : étiquettes `sha-<court>` et version, plus `concurrency` |
| Dossier de données non inscriptible au lot 1 | corrigé : refus au démarrage avec le `chown` à faire, documenté en section 5 |
| Test anti-bancaire trompable (`\b` traite `_` comme une lettre) | corrigé : sous-chaînes, `card`, `payment`, `account_number`, parcours des migrations |
| Pas d'en-têtes de sécurité, `HEALTHCHECK` codé en dur sur 3000, statuts écrasés en 500, messages Zod en anglais, texte en dur possible dans le JSX, `react` en dépendance de production, `.dockerignore` incomplet, liaison sur `0.0.0.0` | tous corrigés |

**Vérifications indépendantes de l'orchestrateur après correction** :
- `lint`, `typecheck`, `build` et `test` passent — **102 tests** (23 avant la revue).
- **Huit contournements du verrou écrits à la main** sont tous bloqués par ESLint, fichier-baril
  compris ; et les deux cas légitimes (`better-sqlite3` dans `db/connection.ts`, un import
  ordinaire) passent — un verrou qui crie au loup serait désactivé au premier agacement.
- **Onze configurations piégées** se comportent toutes comme attendu, dont la nuance
  `http://` refusé en production mais accepté en développement.
- **`.env.example` copié tel quel ne démarre pas** : trois refus « doit être du base64 canonique
  (openssl rand -base64 32) », code de sortie 1. Le défaut est clos de bout en bout.
- Port déjà occupé : « Impossible d'écouter : le port 3999 est déjà utilisé. », code 1.
- Image reconstruite, conteneur lancé avec `PORT=4000` : `/api/sante` répond 200, les trois
  en-têtes de sécurité sont là (`frame-ancestors 'none'`), et le `HEALTHCHECK` suit bien le port.

- `.claude/settings.json` : la règle de refus `Read(./.env.*)`, trop large, bloquait
  `.env.example` — un fichier public. Restreinte, sur accord explicite, aux fichiers qui portent
  de vrais secrets (`.env`, `.env.local`, `.env.production`, `app/server/.env`) : la protection
  est désormais plus étroite **et** plus complète, le joker ne couvrant même pas
  `app/server/.env`.
- **Limite connue** : un ré-export indirect en deux temps (`import {db} from './connection'`
  puis `export {db}`) dans `db/` échappe encore à ESLint. À surveiller en revue au lot 1.
- Versions retenues : TypeScript 6.0 (contrainte de `typescript-eslint`), Express 5.3, Zod 4.6,
  Vite 8.3, Vitest 5.1, React 19.3, ESLint 10. Node 24 dans l'image et l'intégration continue,
  conformément à l'ADR-0001 (la machine de développement tourne en Node 26).

## 2026-11-15 — Conception de la V1 écrite

- **Modèle de données complet** : `Dossier de conception/03 - Modele de donnees.md`, 33 tables,
  40 index, toutes en `STRICT`. **Migration initiale rejouée et vérifiée indépendamment** sur
  SQLite 3.54 : elle passe sur une base neuve.
- **Architecture** : `Dossier de conception/04 - Architecture.md` — structure du dépôt, surface
  d'API de la V1, les trois intégrations (iCal, Immich, Brevo), stratégie de tests, conteneur,
  et découpage de l'implémentation en lots.
- Trois ADR de plus : `ADR-0006` cloisonnement structurel (cinq verrous), `ADR-0007`
  authentification (session opaque hachée, `scrypt`, Google purement additif en V2),
  `ADR-0008` bibliothèque SQLite (`better-sqlite3`, **encore à l'état de proposition**).
- **Cloisonnement vérifié dans les faits** : les clés étrangères composites `(id, group_id)`
  font refuser l'écriture croisée par la base elle-même. Trois essais joués à la main sur la
  base de test : un article du groupe B greffé sur une liste du groupe A → rejeté ; un membre
  du groupe B qui réclame un article du groupe A → rejeté ; l'écriture légitime → acceptée.
- **Le projet s'appelle désormais Attroupe.** « Rameute » a été abandonné : `rameute.fr` sert
  déjà un site intitulé « Rameute » (enregistré le 22 octobre 2026) et `rameute.com` a été pris
  le 12 novembre 2026. Quatre candidats ont été vérifiés (domaines, site vivant, dépôts
  GitHub) ; **Attroupe** est le seul libre partout — `.fr`, `.com`, `.io`, aucun dépôt, aucun
  compte GitHub, aucun site. Dossier renommé, documentation reprise (53 remplacements).
- Restent ouverts : le nom et donc le sous-domaine (bloquant avant le lot 2), GPL ou AGPL,
  le journal d'audit en V1 ou en V2, et le statut de `node:sqlite` sur Node 24.

## 2026-11-15 — Cadrage terminé

- Nom retenu ce jour-là : « Rameute », remplacé depuis par **Attroupe** (voir l'entrée du
  dessus). *ACB* reste le nom de code interne et le clin d'œil dans l'interface.
- Décisions actées : Immich **hors de la pile**, branché par API et configuré par groupe
  (`ADR-0003`) ; dépenses **multi-devises sans aucun flux bancaire** (`ADR-0004`) ;
  déploiement en **deux conteneurs LXC 112 (prod) et 113 (beta)** sur images GHCR, mise à jour
  à la main (`ADR-0005`).
- Inscription ouverte, ajout d'un membre existant par nom d'utilisateur ou e-mail exact via une
  invitation à accepter. E-mails par Brevo (compte personnel à créer). Interface en français.
- Licence posée à la racine (`LICENSE`) : GPL-3.0 d'abord, **remplacée par l'AGPL-3.0** avant la
  première publication — c'est l'AGPL qui couvre une application servie par le réseau.
- Restent ouverts : sous-domaine, disponibilité du nom, ressources des conteneurs, liste finale
  des devises.
- **Prochaine étape : modèle de données et architecture de la V1.**

## 2026-11-15 — Amorçage du projet

- Arborescence créée : `app/`, `docs/`, `Dossier de conception/`, `Avancement du projet/`.
- Système d'agents mis en place : six sous-agents dans `.claude/agents/`
  (`explorateur`, `scraper`, `utilitaire`, `dev`, `reviewer`, `architecte`),
  règles de routage dans `docs/AGENTS.md`, règles de travail dans `CLAUDE.md`.
- Dépôt git propre initialisé sur `main` (le dossier dépendait jusque-là du dépôt
  « Projet DEV », d'où la branche `sna-refonte-maquettes` affichée par erreur).
- Premier brief recueilli : organisateur pour un groupe d'amis (planning, soirées, listes de
  courses, albums photos par e-mail), auto-hébergé, Docker en une commande, mise à jour depuis
  l'interface, dépôt GitHub public.
- Rédigé : `Dossier de conception/00 - Vision.md` et `01 - Fonctionnalites proposees.md`
  (43 fonctionnalités proposées, à trier par jalon).
- Cadrage tranché : stack Node 24 + Express + SQLite + React/Vite en mono-conteneur
  (`ADR-0001`), plusieurs groupes étanches sur une instance (`ADR-0002`), périmètre de la V1
  arrêté dans `Dossier de conception/02 - Perimetre et jalons.md`. Les photos passeront par
  Immich, le mode d'intégration restant à arbitrer (`ADR-0003`).
- Mise à jour depuis l'interface **abandonnée** : images construites par l'intégration
  continue, `docker compose pull` lancé à la main, deux canaux (`main` et `beta`).
- Restent ouverts : nom du produit, intégration Immich, politique d'inscription, service SMTP,
  numéro du conteneur LXC, licence.
