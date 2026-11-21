# 04 — Architecture — Attroupe

> Décidé le 2026-11-15 par l'architecte. Traduit le périmètre V1
> ([`02 - Perimetre et jalons.md`](02%20-%20Perimetre%20et%20jalons.md)) et les ADR 0001 à 0005
> en structure exécutable. Le schéma est dans
> [`03 - Modele de donnees.md`](03%20-%20Modele%20de%20donnees.md).
>
> Trois décisions prises dans ce document ont leur propre ADR :
> [`ADR-0006`](../docs/decisions/ADR-0006-cloisonnement-structurel.md) (cloisonnement),
> [`ADR-0007`](../docs/decisions/ADR-0007-authentification.md) (authentification),
> [`ADR-0008`](../docs/decisions/ADR-0008-bibliotheque-sqlite.md) (bibliothèque SQLite).

## 1. Vue d'ensemble

Un seul processus Node 24 dans un seul conteneur. Express sert trois choses sur le même port :

1. `/api/*` — l'API JSON, protégée par cookie de session ;
2. `/ical/:jeton.ics` — le flux de calendrier, **sans cookie**, authentifié par le jeton seul ;
3. tout le reste — les fichiers statiques du client React déjà compilés par Vite, avec repli
   sur `index.html` pour le routage côté navigateur.

Pas de reverse proxy interne, pas de second service : TLS et nom de domaine sont la
responsabilité du Nginx Proxy Manager déjà en place. Le conteneur écoute en clair sur `3000`.

```
Navigateur / calendrier du téléphone
            │  HTTPS
      Nginx Proxy Manager  (hors du dépôt)
            │  HTTP :3000
┌───────────┴─────────────────────────────────────────┐
│ conteneur attroupe (Node 24)                         │
│   Express ── routes ── couche d'accès cloisonnée ──► SQLite  /data/attroupe.db (WAL)
│                    ├── service Immich  ──────────────► API Immich (externe, par groupe)
│                    ├── service Brevo   ──────────────► API Brevo
│                    └── fichiers        ──────────────► /data/fichiers (avatars, tickets)
└─────────────────────────────────────────────────────┘
```

Les trois dépendances externes sont **facultatives au démarrage** : sans Brevo configuré, les
e-mails restent en file d'attente et l'application le signale ; sans Immich, l'onglet photos
est absent du groupe ([`ADR-0003`](../docs/decisions/ADR-0003-photos-immich.md)). Aucune des
deux ne doit empêcher le serveur de répondre.

## 2. Structure du dépôt

```
Attroupe/
├── Dockerfile                      construction multi-étapes (client + serveur)
├── docker-compose.yml              la « commande unique » (ADR-0005)
├── .env.example                    toutes les clés, valeurs factices
├── package.json                    espaces de travail npm : app/server, app/client
├── tsconfig.base.json              TypeScript strict, partagé
├── .github/workflows/
│   ├── ci.yml                      lint, types, tests, construction
│   └── image.yml                   publication GHCR : main→latest, beta→beta
├── app/
│   ├── server/
│   │   ├── index.ts                amorçage : env → base → migrations → routes → écoute
│   │   ├── config/
│   │   │   └── env.ts              lecture et validation ; le démarrage échoue si une clé manque
│   │   ├── db/                     ← SEUL dossier autorisé à parler SQL
│   │   │   ├── connection.ts       ouverture, PRAGMA, vérification de foreign_keys
│   │   │   ├── migrate.ts          exécution ordonnée et idempotente des migrations
│   │   │   ├── scope.ts            GroupScope : le contexte de groupe obligatoire (§4)
│   │   │   ├── sql.ts              garde de développement sur le SQL brut (§4, niveau 4)
│   │   │   └── queries/            un fichier par domaine : evenements.ts, depenses.ts…
│   │   ├── domain/                 ← logique PURE, sans base, sans Express, 100 % testable
│   │   │   ├── argent.ts           Montant { minor, devise }, addition refusée entre devises
│   │   │   ├── repartition.ts      plus grands restes, reliquat déterministe (§4.5 du modèle)
│   │   │   ├── soldes.ts           soldes et liste minimale de remboursements
│   │   │   ├── temps.ts            fuseaux, journées entières, fenêtres d'agenda
│   │   │   └── ical.ts             génération du VCALENDAR
│   │   ├── http/
│   │   │   ├── app.ts              assemblage Express, ordre des intergiciels
│   │   │   ├── middleware/         session, appartenance, erreurs, cadence, CSRF, journal
│   │   │   ├── routes/             un fichier par domaine, miroir de queries/
│   │   │   ├── schemas/            validation des entrées et sérialisation des sorties
│   │   │   └── erreurs.ts          ErreurHttp typée : code, statut, clé de traduction
│   │   ├── services/
│   │   │   ├── immich.ts           client API, délai court, échec non propagé
│   │   │   ├── brevo.ts            remise de la file email_outbox
│   │   │   ├── notifications.ts    création des lignes + mise en file des e-mails
│   │   │   ├── signature.ts        URL signées expirantes (photos)
│   │   │   ├── temps-reel.ts       événements serveur (SSE) par groupe
│   │   │   └── taches.ts           tâches périodiques : file e-mails, purges, synchro albums
│   │   └── i18n/fr.json            textes des e-mails et des erreurs côté serveur
│   ├── client/
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── src/
│   │       ├── main.tsx, App.tsx, routes.tsx
│   │       ├── pages/              agenda, evenement, listes, depenses, photos, groupe, moi
│   │       ├── composants/         briques d'interface, mobile d'abord
│   │       ├── api/                client typé, un module par domaine
│   │       ├── etat/               groupe courant (sélecteur), session, cache de requêtes
│   │       ├── i18n/fr.json        ← TOUS les textes de l'interface, sans exception
│   │       └── pwa/                manifeste, service worker, icônes
│   ├── migrations/
│   │   └── 0001_socle.sql          §5 du modèle de données
│   └── tests/
│       ├── unite/                  le dossier domain/, sans base
│       ├── integration/            routes sur une base temporaire
│       ├── cloisonnement/          ← la suite dédiée (§7)
│       ├── schema/                 contrôles sur la structure elle-même
│       └── fixtures/               deuxGroupes(), jeux de dépenses, faux Immich
├── scripts/
│   ├── sauvegarde.sh               VACUUM INTO + archive de /data/fichiers
│   └── restauration.sh
├── docs/decisions/                 les ADR
├── Dossier de conception/          vision, périmètre, modèle, architecture
└── Avancement du projet/
```

**Trois principes de rangement**, qui sont aussi des règles de revue :

1. `domain/` **ne connaît ni la base ni HTTP**. C'est là que vit l'arithmétique de l'argent, et
   c'est pour ça qu'elle est testable exhaustivement sans monter un serveur.
2. `db/` est le **seul** endroit où le mot `SELECT` apparaît. Une règle ESLint
   (`no-restricted-imports` sur `db/connection`) le fait échouer ailleurs.
3. Un domaine métier a le même nom dans `queries/`, `routes/`, `api/` et `pages/`. Chercher
   « dépenses » doit donner quatre fichiers, pas une chasse au trésor.

## 3. Choix techniques à l'intérieur du cadre de l'ADR-0001

### 3.1 Bibliothèque SQLite : `better-sqlite3`

**Recommandation : `better-sqlite3`** pour la V1, avec un accès confiné à `db/connection.ts`
pour que la bascule reste une journée de travail
([`ADR-0008`](../docs/decisions/ADR-0008-bibliotheque-sqlite.md)).

| Critère | `node:sqlite` (intégré) | `better-sqlite3` |
|---|---|---|
| Dépendance | **aucune** | une, native, avec binaires précompilés |
| Stabilité de l'API | encore annoncée comme en évolution sur la ligne 24 ; une montée de version de Node peut changer la signature | stable depuis des années, sémantique de version respectée |
| Entiers 64 bits | gestion des `BigInt` plus limitée | `safeIntegers()` par instruction — utile quand **tout l'argent est un entier** |
| Sauvegarde à chaud | pas d'API de sauvegarde | `db.backup()` **et** `VACUUM INTO` — F5 en dépend |
| Fonctions SQL maison | limitées | `db.function()` : utile pour normaliser un `lower()` accentué |
| Construction de l'image | triviale | une étape de compilation dans le `Dockerfile`, ou un binaire précompilé |

Le point décisif n'est pas la performance (les deux appellent la même bibliothèque C) mais
**l'API de sauvegarde** et la stabilité : la sauvegarde est une exigence V1 (F5) et une
promesse du produit (« des souvenirs non sauvegardés sont des souvenirs perdus »).

> **À vérifier avant d'écrire le lot 1** — hypothèse de ma part, non confirmée : le statut exact
> de `node:sqlite` sur Node 24 (expérimental ou stable) et la disponibilité des binaires
> précompilés de `better-sqlite3` pour Node 24 sur l'architecture du homelab. Si les deux
> penchent dans l'autre sens, la décision se renverse sans conséquence sur le reste, et c'est
> précisément pourquoi `db/connection.ts` est le seul fichier à importer la bibliothèque.

### 3.2 Les autres choix, en une ligne chacun

| Sujet | Choix | Raison |
|---|---|---|
| Validation des entrées | **Zod** | Un schéma par route, qui sert à la fois de garde d'exécution et de type TypeScript. Sans lui, « typage strict » s'arrête à la frontière HTTP, là où les données sont inconnues. |
| Tests | **Vitest** + **Supertest** | Vitest est déjà là via Vite ; Supertest permet d'attaquer l'application sans ouvrir de port. |
| Temps réel (C2) | **événements serveur (SSE)** | Un flux descendant par groupe suffit pour « la case vient d'être cochée ». Pas de WebSocket : pas de second protocole à faire passer dans le proxy. |
| Hachage de mot de passe | **`scrypt` de `node:crypto`** | Aucune dépendance native supplémentaire, paramètres explicites, résistance mémoire. Argon2id serait marginalement préférable et ne justifie pas une dépendance compilée de plus. |
| Journalisation | module maison, JSON sur la sortie standard | Docker collecte, le proxy archive. Aucune donnée personnelle dans les journaux : on journalise des identifiants, jamais un titre d'événement ni une adresse. |
| État côté client | **TanStack Query** + un contexte de groupe | Le cache par clé de requête règle gratuitement l'invalidation après une action, et la clé **commence toujours par l'identifiant du groupe** : changer de groupe vide le bon cache, pas celui du voisin. |
| Internationalisation | fichier `fr.json` plat + fonction `t()` | Exigence du brief. Un test échoue si une chaîne littérale non technique apparaît dans un composant. |

## 4. Le cloisonnement : cinq verrous, pas une bonne intention

C'est **le** sujet du projet ([`ADR-0002`](../docs/decisions/ADR-0002-multi-groupes.md)). Le
dispositif tient en une phrase : **il doit être impossible d'écrire une requête métier sans
avoir prouvé l'appartenance**, et non simplement déconseillé de l'oublier. Cinq verrous
indépendants, du plus haut au plus bas.

### Verrou 1 — Le groupe est dans l'URL, et il n'y a pas d'autre chemin

Toute route métier est montée sous `/api/groupes/:groupId/…`. Il n'existe **aucune** route
`/api/evenements/:id` : un identifiant seul n'est jamais une adresse valide. Conséquence :
l'intergiciel d'appartenance ne peut pas être « oublié » sur une route, puisqu'il est monté sur
le préfixe commun.

### Verrou 2 — Le `GroupScope`, un objet qu'on ne peut pas fabriquer soi-même

```ts
// app/server/db/scope.ts
const MARQUE = Symbol('GroupScope');

export interface GroupScope {
  readonly [MARQUE]: true;             // non fabricable hors de ce module
  readonly groupId: string;
  readonly membershipId: string;
  readonly role: 'admin' | 'member';
  readonly groupe: <T>() => T | undefined;           // SA ligne `groups`, et aucune autre
  readonly tous: <T>(table: TableMetier, filtres?: readonly Condition[], options?: OptionsLecture) => T[];
  readonly un: <T>(table: TableAvecId, id: string) => T | undefined;
  readonly inserer: (table, valeurs) => string;      // pose group_id, auteur, horodatages, id (UUID v7)
  readonly modifier / modifierPar / upsert / supprimerDoux / supprimer / transaction;
}

/** Lit l'appartenance ACTIVE en base ; lève ErreurAppartenance sinon. Seul l'intergiciel l'appelle. */
export function creerScope(base: Base, userId: string, groupId: string): GroupScope { /* … */ }
```

Le dispositif tient en six points :

1. **Le symbole de marque** rend l'objet non falsifiable : `{ groupId: 'gB' }` n'est pas un
   `GroupScope` pour le compilateur.
2. **`creerScope` ne croit rien.** Elle reçoit `(userId, groupId)`, lit `memberships` avec
   `status = 'active'` et refuse (`ErreurAppartenance`, que l'intergiciel traduit en 404) si la
   ligne n'existe pas. Aucun appelant ne peut affirmer une appartenance.
3. **Il n'y a pas de clause SQL libre.** Un filtre est une liste de `{ colonne, operateur,
   valeur }`, combinée par ET : la colonne est vérifiée contre `pragma_table_info` de la table
   visée (liste blanche dérivée du schéma), l'opérateur vient d'un ensemble fermé (`=`, `<>`, `<`,
   `<=`, `>`, `>=`, `IN`, `IS NULL`, `IS NOT NULL`, `LIKE`), les valeurs sont **toujours liées**.
   Aucun identifiant entre `[ ]`, `" "` ou accents graves, aucun appel de fonction, aucun mot-clé
   ne peut entrer. Le texte généré est plat (`SELECT * FROM t WHERE group_id = ? AND deleted_at IS
   NULL AND …`, le filtre de groupe en premier) : la garde du SQL brut refuse les sous-requêtes.
4. **Le scope est assez riche pour qu'on n'ait jamais besoin de SQL brut** : lecture, insertion,
   modification par `id` ou par clé composite, upsert (la clause de conflit est bornée au groupe :
   une clé forgée vers un autre groupe ne touche pas sa ligne), suppression douce, suppression
   réelle des lignes d'association (§4.4 du modèle), transaction, valeurs `Buffer`, ligne `groups`
   du groupe, créneaux d'agenda partagés en projection « occupé ». L'`id` est généré dans `db/`.
5. **La connexion est opaque hors de `db/`.** `ouvrirEtMigrer` renvoie un `Base` : un type marqué
   sans aucune méthode (`db/base.ts`), la vraie connexion restant dans `connection.ts`
   (`connexionBrute`, réservée par ESLint à `sql.ts` et `migrate.ts`). `base.prepare(…)` ne
   compile pas, et `.prepare`, `.exec`, `.pragma` sont de toute façon interdits par ESLint hors de
   `connection.ts`, `sql.ts` et `migrate.ts`.
6. **Les tables d'un compte** (`notifications`, `calendar_feed_tokens`, `notification_preferences`,
   `personal_events`) ont leur `PorteeUtilisateur`, fabriquée par `creerPorteeUtilisateur(base,
   userId)` avec le même moteur et le filtre `user_id = ?` posé par la portée. `email_outbox`,
   sans colonne de compte, n'est accessible par aucune portée.

> **Aucune fonction de `db/queries/` ne prend de paramètre `groupId: string`.** Elles prennent
> `scope: GroupScope` en premier argument. En TypeScript strict, écrire une requête sans
> contexte de groupe **ne compile pas**. C'est le cœur du dispositif : la discipline est
> déplacée du relecteur vers le compilateur.

### Verrou 3 — L'intergiciel de résolution d'appartenance

```ts
// app/server/http/middleware/appartenance.ts
export const exigerAppartenance: RequestHandler = (req, res, next) => {
  const appartenance = lireAppartenanceActive(req.auth.userId, req.params.groupId);
  //   SELECT … FROM memberships WHERE user_id = ? AND group_id = ? AND status = 'active'
  if (!appartenance) {
    // 404, pas 403 : on ne révèle pas l'existence d'un groupe dont on n'est pas membre
    return next(new ErreurHttp(404, 'groupe.introuvable'));
  }
  if (estArchive(appartenance.group_id) && req.method !== 'GET') {
    return next(new ErreurHttp(409, 'groupe.archive'));
  }
  req.scope = creerScope(base, req.auth.userId, req.params.groupId); // relit l'appartenance, lève ErreurAppartenance sinon
  next();
};
```

Deux détails qui comptent : la réponse pour un groupe étranger est **404 et non 403** (un 403
confirmerait l'existence du groupe), et le drapeau `users.is_instance_admin` **n'est pas lu
ici** — l'administrateur de l'instance n'a aucun accès au contenu des groupes, conformément à
l'`ADR-0002`.

### Verrou 4 — La base refuse l'incohérence (§4.1 du modèle de données)

Les clés étrangères composites `(id, group_id)` font échouer l'écriture d'un enfant dont le
groupe diffère de celui de son parent. **Vérifié** : les sept tentatives du §5.1 du modèle de
données ont toutes été refusées par SQLite. Ce verrou rattrape les erreurs que les trois
premiers laisseraient passer, y compris dans un script d'exploitation écrit à la main.

### Verrou 5 — Les garde-fous automatiques

- **Garde sur le SQL brut** : `db/sql.ts` enveloppe `prepare()` et **refuse** (partout, production
  comprise : le texte est statique, aucune branche ne lit `NODE_ENV`) toute requête qui touche une
  table métier sans **filtre lié** : `group_id = ?`, `user_id = ?` pour les tables d'un compte et
  pour `personal_events`, `g.id = ?` pour `groups` (qualifié par sa propre référence). La garde est
  **fermée** : elle analyse des jetons et n'admet que ce qu'elle sait prouver ; le reste est refusé,
  même s'il est légitime. Un filtre n'est admis que comme **conjoint direct** d'un `WHERE` ou d'un
  `ON` (parenthèses de simple groupement seulement, suivies d'une fin de conjoint) ; un lien
  `a.group_id = b.group_id` suit la même règle. Une insertion est couverte par la colonne de portée,
  et un `ON CONFLICT … DO UPDATE` exige `WHERE <table>.group_id = excluded.group_id`.
  **Refusés** : sous-requêtes (un seul `select`), alias ou nom de table réutilisé, `OR`, `UNION`,
  `WITH`, `BETWEEN`, `NOT EXISTS`, `NOT` hors de `IS NOT`/`NOT IN`/`NOT LIKE`, `CASE` hors liste de
  sélection ou `ORDER BY`, `RIGHT`/`FULL`/`CROSS`/`NATURAL`, commentaires, identifiants entre
  crochets, guillemets ou accents graves, `;`, non-ASCII, modification de `group_id`.
  **Admis** : `JOIN` interne, `LEFT [OUTER] JOIN` (la table jointe hérite du groupe par son propre
  `ON … AND b.group_id = a.group_id`, la table de gauche est filtrée dans le `WHERE`), `CASE` dans le
  `SELECT`, `NOT IN`, `NOT LIKE`. **À la place du refusé** : `OR` → `IN (?, ?)` ou deux requêtes ;
  `BETWEEN` → `x >= ? AND x <= ?` ; sous-requête, `EXISTS`/`NOT EXISTS`, `WITH` → jointure
  interne/externe, ou deux requêtes assemblées en TypeScript dans `db/queries/` ; `groups` → 
  `scope.groupe()`. **Jamais** : ajouter un texte à `TEXTES_TRANSVERSES` pour contourner un refus ;
  ce canal est réservé aux lectures qui traversent les groupes par nature. Un refus que la liste
  ci-dessus ne résout pas se signale : on étend la garde (et ses tests), on ne la contourne pas.
  La garde prouve qu'un filtre lié existe, pas quelle valeur on lie : c'est le rôle du scope.
  `personal_events` n'est lisible que par `user_id = ?` ou par une jointure avec
  `personal_event_shares` filtrée par `group_id = ?`. Depuis l'ADR-0017, cette jointure doit en outre porter le plafond
  de compte `users.personal_agenda_visibility = ?` et le rapprochement `users.id = memberships.user_id` : c'est la
  sous-règle n° 6 de cette garde, refusée au `preparer` si elle manque.
  **Trois exceptions raisonnées (lot 3), et aucune autre.** Elles complètent la garde ; elles n'élargissent pas le canal
  transverse, qui reste une liste figée de *lectures* :
  1. `INSERT INTO groups (colonnes) VALUES (…)` : `groups` est la table racine, sans `group_id` à filtrer, et l'unique
     point d'entrée de création d'un groupe. Ni `SELECT`, ni `ON CONFLICT`, ni insertion sans liste de colonnes ;
  2. `invitations` filtrée par **`target_user_id = ?`** : une invitation est par nature inter-groupes (son destinataire
     n'est pas encore membre), la preuve d'accès est le destinataire ;
  3. `invitations` filtrée par **`token_hash = ?`** : la preuve d'accès est le secret du lien (empreinte SHA-256).
  La valeur doit être **liée** (jamais littérale) et le filtre suit les règles d'un conjoint direct de `WHERE` / `ON`.
  `SELECT * FROM invitations WHERE id = ?` reste refusé.
  **Bornes (revue du lot 3).** Une couverture par `target_user_id` / `token_hash` ne couvre **que** `invitations` et ne se
  propage **jamais** par `group_id = group_id` : sinon une jointure sur une invitation (même refusée, révoquée ou échue)
  ouvrirait en lecture et en écriture toutes les tables du groupe invitant. Seule dérivation admise, nommée : en `SELECT`,
  `memberships ON m.id = i.invited_by_membership_id AND m.group_id = i.group_id` (l'inviteur), qui ne propage rien.
  La colonne de preuve est immuable : `target_user_id` jamais en `SET`, `token_hash` seulement sous un vrai `group_id = ?`
  (armement du jeton à l'envoi). Tests : `tests/schema/garde-sql.test.ts` (chaque admission et son
  voisin dangereux). Les écritures qui en découlent ne lient jamais qu'un `group_id` relu dans une invitation prouvée.
- **Canal transverse** : les lectures qui traversent les groupes par nature (« mes groupes » :
  `memberships WHERE user_id = ?`) passent par `preparerTransverse`, fonction **non exportée hors
  de `db/`**, appelée seulement par `db/queries/transverse.ts`, dont les textes SQL sont **figés
  en dur** dans `TEXTES_TRANSVERSES` (`Object.freeze`). Chaque fonction transverse prend une
  `PorteeUtilisateur` (`mesGroupes(portee)`), jamais un identifiant nu. Un test compare cette liste aux appels réels ; il n'existe
  aucune option sur `preparer` pour y échapper.
- **ESLint** (`eslint.config.js`, prouvé par `ESLint.lintText`) : la bibliothèque SQLite n'est
  importable que depuis `connection.ts` ; `db/connection`, `db/sql` et `db/migrate` ne le sont que
  depuis `db/` (et `migrate` depuis `index.ts`) ; `creerScope` et `creerPorteeUtilisateur`
  uniquement depuis `http/middleware/appartenance.ts` ; `.prepare`, `.exec`, `.pragma` interdits
  hors de `connection.ts`, `sql.ts` et `migrate.ts`.
- **Test de schéma** : la liste des tables métier est dérivée de `sqlite_master`, et le test
  exige `group_id` sur chacune ; chaque table est rangée dans exactement une portée (groupe ou
  compte) et chaque description du scope est comparée aux colonnes réelles. La seule exception
  admise est inscrite en dur dans le test — `personal_events` — avec un commentaire qui renvoie
  au §3.6 du modèle. Ajouter une exception demande donc de modifier le test, ce qui se voit en revue.
- **Test des clés étrangères** : dérivé de `pragma_foreign_key_list`, il exige que toute clé
  étrangère vers un parent portant `group_id` soit composite et inclue `group_id`.
- **Test anti-bancaire** : aucune colonne ne doit correspondre à `%iban%`, `%bic%`, `%card%`,
  `%payment%`, `%account_number%`.
- **Suite de cloisonnement** : §7.

### Une route type, de bout en bout

```ts
// app/server/http/routes/listes.ts  — monté sur /api/groupes/:groupId/listes
const routeur = Router();
routeur.use(exigerSession, exigerAppartenance);   // posé une fois, pas par route

// POST /api/groupes/:groupId/listes/:listeId/articles
routeur.post('/:listeId/articles', valider(CorpsNouvelArticle), (req, res) => {
  const article = articles.creer(req.scope, req.params.listeId, req.corps);
  temsReel.diffuser(req.scope, 'article.cree', { listeId: req.params.listeId });
  res.status(201).json(serialiserArticle(article));
});

// PUT …/articles/:articleId/preneur   « je le prends » / « finalement non »
routeur.put('/:listeId/articles/:articleId/preneur', valider(CorpsPreneur), (req, res) => {
  // Le preneur est TOUJOURS l'appelant : aucune route ne permet de désigner quelqu'un d'autre,
  // donc aucun identifiant d'appartenance ne transite par le corps de la requête.
  const article = articles.definirPreneur(req.scope, req.params.articleId, req.corps.prend);
  res.json(serialiserArticle(article));
});
```

```ts
// app/server/db/queries/articles.ts
export function creer(scope: GroupScope, listeId: string, corps: NouvelArticle): Article {
  const liste = scope.un<ListeRow>('shopping_lists', listeId);     // group_id injecté
  if (!liste) throw new ErreurHttp(404, 'liste.introuvable');      // liste d'un autre groupe → 404
  return scope.inserer('shopping_items', {
    id: nouvelId(),
    shopping_list_id: listeId,          // la FK composite confirmerait le groupe de toute façon
    label: corps.label,
    position: prochainePosition(scope, listeId),
    created_by_membership_id: scope.membershipId,   // l'auteur vient du contexte, pas du client
  });
}
```

Trois choses à retenir de cet exemple : **aucun `groupId` en paramètre**, **aucun identifiant
d'acteur venant du client**, et un `404` pour ce qui appartient à un autre groupe.

### Les autorisations fines, au-dessus du cloisonnement

Le cloisonnement répond à « est-ce mon groupe ? ». Les rôles répondent à « ai-je le droit ? »,
et c'est une **seconde** vérification, jamais confondue avec la première :

```ts
// une seule fonction, utilisée partout
peutModifierEvenement(scope, evenement)   // auteur, co-organisateur, ou admin du groupe
exigerAdminGroupe(scope)                  // renommer, inviter, retirer, configurer Immich
```

Un échec d'autorisation renvoie **403** (la ressource existe, dans mon groupe, mais le droit
manque) ; un échec de cloisonnement renvoie **404**. Les deux codes ne se croisent jamais, ce
qui rend les tests lisibles.

## 5. Authentification

**Recommandation** : session opaque en base + cookie, mot de passe haché par `scrypt`, et un
emplacement déjà prévu pour la connexion Google de la V2
([`ADR-0007`](../docs/decisions/ADR-0007-authentification.md)).

| Sujet | Décision |
|---|---|
| Transport | Cookie `attroupe_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, durée 30 jours glissante, plafond absolu 90 jours. |
| Stockage | Table `sessions`, **jeton haché en SHA-256** : une copie de la base ne donne pas de session utilisable. |
| Pourquoi pas de JWT | Un jeton autoporté ne se révoque pas. Avec un seul processus et une base locale, l'argument « sans état » n'achète rien et coûte la révocation immédiate — indispensable quand on retire quelqu'un d'un groupe ou qu'un téléphone est perdu. |
| Mot de passe | `scrypt` (N=2^15, r=8, p=1), sel de 16 octets, format `scrypt$N$r$p$sel$empreinte` pour pouvoir durcir les paramètres plus tard sans invalider les comptes. Minimum 10 caractères, et refus des mots de passe les plus courants (liste embarquée courte). |
| CSRF | `SameSite=Lax` + vérification de l'en-tête `Origin` sur toute requête non-`GET`. Pas de jeton CSRF : il n'y a pas de formulaire inter-site, et `Origin` est fiable sur les navigateurs visés. *Lot 2 : une requête non-`GET` **sans** `Origin` est refusée (403), cookie ou non, pour fermer aussi le « login CSRF ».* |
| Cadence | Limitation par couple (adresse IP, identifiant) sur `/api/auth/connexion`, `/api/auth/mot-de-passe/oubli` et l'acceptation d'invitation : 10 tentatives / 15 min, puis report exponentiel. Compteurs en mémoire — un seul processus. *Lot 2, précisions (corrigées après revue) : la clé de base est bien le **couple (adresse e-mail, IP)** — 10 tentatives / 15 min — de sorte qu'un tiers qui martèle une adresse depuis son IP ne bloque que lui-même, jamais le propriétaire qui se connecte d'ailleurs. S'y ajoutent, plus larges : une clé par **adresse e-mail seule** (100 / 15 min toutes IP confondues : elle ne retient qu'une attaque répartie), une clé par **IP** (30, IPv6 ramenée à son /64) et une clé par **/48 IPv6** (90). Report exponentiel 15 min × 2^n (12 h max). Une requête refusée en 429 **ne crée aucune clé** ; au plafond de clés suivies, une clé dont le blocage court n'est **jamais** évincée (la requête est refusée plutôt qu'un blocage oublié) ; une requête qui finit en 503 (file de hachage pleine) ne débite rien. L'IP vient de `ATTROUPE_TRUST_PROXY`. Limite assumée : un attaquant disposant de nombreuses adresses peut épuiser la clé e-mail large d'un compte (déni de connexion temporaire, d'où le report exponentiel et non un blocage définitif) ; un cookie « appareil connu » qui exempterait le propriétaire reste possible plus tard.* |
| Inscription | Ouverte par défaut, commutable par `ATTROUPE_REGISTRATION=open|invite` : une instance privée peut se fermer sans changer de code. Répond au point ouvert de l'`ADR-0002`. |
| Vérification d'e-mail | Envoyée, non bloquante en V1 ; `email_verified_at` est tracé car la V2 en aura besoin pour lier un compte Google. |
| Énumération | « Mot de passe oublié » et la recherche d'un membre par e-mail répondent **toujours** la même chose, succès ou non. La recherche de membre est une correspondance exacte et ne renvoie jamais de liste. |

**La V2 et Google, préparés dès maintenant.** Le choix d'une session opaque rend l'ajout
d'OIDC purement additif : deux routes (`GET /api/auth/google`,
`GET /api/auth/google/retour`), le flux *authorization code* avec PKCE, une ligne dans
`user_identities`, puis **la même session, le même cookie, le même intergiciel**. Rien du
cloisonnement ni des routes métier ne bouge.

> **Le piège à ne pas tomber dedans en V2** : lier automatiquement une identité Google à un
> compte existant sur la seule base de l'égalité des adresses e-mail est une prise de contrôle
> de compte si l'adresse n'est pas vérifiée des deux côtés. La règle sera : liaison
> automatique **seulement** si Google atteste `email_verified` **et** que notre
> `email_verified_at` est non nul ; sinon, on demande le mot de passe existant. C'est écrit ici
> pour que la V2 n'ait pas à le redécouvrir.

## 6. Surface d'API de la V1

Conventions : préfixe `/api`, JSON, cookie de session obligatoire sauf mention contraire.
`:g` abrège `:groupId`. **Toute** route listée sous `/api/groupes/:g/` passe par
`exigerAppartenance`. Pas de contrat détaillé ici : les schémas Zod de `http/schemas/` font foi.

### Comptes et session
| Méthode | Chemin | Rôle |
|---|---|---|
| POST | `/auth/inscription` | Créer un compte (ouverte ou sur invitation). *Sans session.* |
| POST | `/auth/connexion` | Ouvrir une session. *Sans session.* |
| POST | `/auth/deconnexion` | Révoquer la session courante. |
| POST | `/auth/mot-de-passe/oubli` | Mettre un e-mail de réinitialisation en file. *Sans session.* |
| POST | `/auth/mot-de-passe/reinitialisation` | Consommer le jeton et changer le mot de passe. |
| GET | `/moi` | Mon compte, mes groupes, le nombre d'invitations en attente. |
| PATCH | `/moi` | Nom affiché, avatar, fuseau, anniversaire, langue, visibilité de l'agenda personnel (`personal_agenda_visibility`). |
| POST | `/moi/mot-de-passe` | Changer de mot de passe : `{current_password, new_password}`. Ancien mot de passe vérifié, **autres sessions révoquées**, jeton de la session courante **renouvelé** (nouveau cookie), le tout en une transaction. *(lot 2)* |
| POST | `/moi/email/verification` | Renvoyer le mail de vérification d'adresse (409 si déjà vérifiée) : un lien expiré se rattrape. *(ajoutée au lot 2)* |
| GET / DELETE | `/moi/sessions`, `/moi/sessions/:id` | Lister et révoquer mes appareils ; `DELETE /moi/sessions` révoque tout sauf la session courante. |
| POST | `/auth/email/verification` | Consommer le jeton de vérification d'e-mail. *Sans session.* *(ajoutée au lot 2)* |

### Invitations (vues du destinataire)
| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/moi/invitations` | Mes invitations en attente. |
| POST | `/moi/invitations/:id/acceptation` | Accepter : crée l'appartenance. |
| POST | `/moi/invitations/:id/refus` | Refuser. |
| POST | `/invitations/apercu` | Aperçu d'une invitation par lien (nom du groupe, qui invite). *Sans session.* Jeton dans le **corps** `{ token }`, jamais dans l'URL (le journal d'accès enregistre l'URL). |
| POST | `/invitations/acceptation` | Accepter par lien (`{ token }`), après inscription ou connexion. |

> **Écart au lot 3** : `GET /moi/invitations` ne liste que les invitations adressées à ce compte par **nom d'utilisateur**. Les invitations
> par e-mail s'acceptent par le lien seul (`POST /invitations/acceptation`), qui exige une adresse vérifiée et identique : la
> garde du SQL brut n'admet que `target_user_id = ?` et `token_hash = ?` (§4 verrou 5), pas un filtre sur l'adresse. L'émission
> (`POST /groupes/:g/invitations`) répond 202 identique dans tous les cas (pas d'annuaire). Voir `ADR-0009`.

### Groupes et membres
| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/groupes` | Mes groupes (le sélecteur). |
| POST | `/groupes` | Créer un groupe ; me rend administrateur. |
| GET / PATCH | `/groupes/:g` | Détail ; renommer, devise, fuseau *(admin)*. |
| DELETE | `/groupes/:g` | Supprimer *(admin)* : marquage, purge à 30 jours. |
| GET | `/groupes/:g/membres` | Membres actifs et anciens membres. |
| PATCH | `/groupes/:g/membres/:m` | Changer un rôle, poser un surnom *(admin)*. |
| DELETE | `/groupes/:g/membres/:m` | Retirer *(admin)* : `status = 'removed'`, historique conservé. |
| POST | `/groupes/:g/depart` | Partir de moi-même. |
| GET / POST | `/groupes/:g/invitations` | Lister ; inviter par e-mail **ou** par nom d'utilisateur exact *(admin)*. |
| DELETE | `/groupes/:g/invitations/:id` | Révoquer *(admin)*. |

### Agenda du groupe
| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/groupes/:g/evenements?du=&au=` | Fenêtre d'agenda (mois, semaine, liste). |
| POST | `/groupes/:g/evenements` | Créer. |
| GET / PATCH / DELETE | `/groupes/:g/evenements/:e` | Détail ; modifier, annuler *(organisateur)*. |
| PUT | `/groupes/:g/evenements/:e/ma-presence` | Je viens / peut-être / pas là, + invités. |
| GET | `/groupes/:g/evenements/:e/presences` | Réponses et compteurs. |
| POST / DELETE | `/groupes/:g/evenements/:e/organisateurs/:m` | Ajouter, retirer un co-organisateur. |
| GET | `/groupes/:g/apercu` | Page d'accueil : prochaine sortie, ce que je dois apporter, mon solde, non-lus. |

### Agenda personnel
| Méthode | Chemin | Rôle |
|---|---|---|
| GET / POST | `/moi/agenda` | Mes créneaux personnels (sans champ `partages`). |
| GET | `/moi/agenda/:creneauId` | Un créneau de mon agenda. 404 `agenda.introuvable` hors de mon compte. |
| PATCH / DELETE | `/moi/agenda/:id` | Modifier, supprimer. |
| GET | `/groupes/:g/disponibilites?du=&au=` | Les créneaux des membres, **projetés** : « occupé » sans titre si la visibilité effective l'impose (plafond de compte, ADR-0017). |

La visibilité de l'agenda personnel se règle sur `PATCH /moi` (`personal_agenda_visibility`), une fois par compte.
Les routes `PUT /moi/agenda/:id/partages` et `PUT /groupes/:g/ma-visibilite` ont été supprimées (ADR-0017).

### Sondages de dates
| Méthode | Chemin | Rôle |
|---|---|---|
| GET / POST | `/groupes/:g/sondages` | Lister, créer avec ses créneaux. |
| GET / PATCH / DELETE | `/groupes/:g/sondages/:s` | Détail et dépouillement ; modifier, annuler. |
| POST / DELETE | `/groupes/:g/sondages/:s/options`, `…/options/:o` | Ajouter, retirer un créneau. |
| PUT | `/groupes/:g/sondages/:s/options/:o/mon-vote` | Oui / peut-être / non. |
| POST | `/groupes/:g/sondages/:s/conversion` | Le créneau gagnant devient un événement. |

### Listes de courses et tâches
| Méthode | Chemin | Rôle |
|---|---|---|
| GET / POST | `/groupes/:g/listes` | Lister (filtrable par événement), créer. |
| GET / PATCH / DELETE | `/groupes/:g/listes/:l` | Détail, renommer, supprimer. |
| POST | `/groupes/:g/listes/:l/articles` | Ajouter un article. |
| PATCH / DELETE | `/groupes/:g/listes/:l/articles/:i` | Modifier, retirer, réordonner. |
| PUT | `/groupes/:g/listes/:l/articles/:i/preneur` | « Je le prends » / « finalement non ». |
| PUT | `/groupes/:g/listes/:l/articles/:i/fait` | Acheté. |
| GET / POST | `/groupes/:g/taches` | Lister, créer. |
| PATCH / DELETE | `/groupes/:g/taches/:t` | Modifier, supprimer. |
| PUT | `/groupes/:g/taches/:t/assignation` | « Je m'en occupe » ou désigner quelqu'un. |

### Fils de discussion
| Méthode | Chemin | Rôle |
|---|---|---|
| GET / POST | `/groupes/:g/fils` | Fils du groupe (événements + libres), créer un fil libre. |
| GET | `/groupes/:g/fils/:f/messages?avant=` | Pagination par curseur. |
| POST | `/groupes/:g/fils/:f/messages` | Écrire. |
| PATCH / DELETE | `/groupes/:g/fils/:f/messages/:m` | Modifier, supprimer (auteur, ou admin). |
| GET | `/groupes/:g/temps-reel` | Flux SSE du groupe : articles cochés, nouveaux messages. |

### Dépenses
| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/devises` | Devises activées et leur exposant. |
| GET / POST | `/groupes/:g/depenses` | Lister (filtres événement, payeur, période), créer avec ses parts. |
| GET / PATCH / DELETE | `/groupes/:g/depenses/:d` | Détail ; modifier, supprimer *(auteur, payeur ou organisateur)*. |
| GET | `/groupes/:g/soldes?evenement=` | Soldes par membre **et par devise de calcul**, + remboursements suggérés. |
| GET / POST | `/groupes/:g/remboursements` | Lister, déclarer un remboursement fait **hors de l'application**. |
| POST | `/groupes/:g/remboursements/:r/confirmation` | Le bénéficiaire confirme. |
| POST / DELETE | `/groupes/:g/evenements/:e/cloture` | Clôturer les comptes, rouvrir *(organisateur)*. |

### Photos
| Méthode | Chemin | Rôle |
|---|---|---|
| GET / PUT / DELETE | `/groupes/:g/immich` | Lire l'état (jamais la clé), configurer, débrancher *(admin)*. |
| POST | `/groupes/:g/immich/test` | Tester l'URL et la clé, met `status` à jour. |
| GET / POST | `/groupes/:g/albums` | Lister, créer (et créer l'album côté Immich). |
| GET / PATCH / DELETE | `/groupes/:g/albums/:a` | Détail, renommer, détacher. |
| POST | `/groupes/:g/albums/:a/photos` | Dépôt direct, multi-fichiers ; relayé vers Immich. |
| GET | `/groupes/:g/albums/:a/photos` | Vignettes : identifiants **à nous** + URL signées. |
| GET | `/media/:albumId/:assetId/:taille?exp=&sig=` | Contenu relayé depuis Immich. URL signée, expirante, non devinable. |
| DELETE | `/groupes/:g/albums/:a/photos/:p` | Retirer de l'album *(déposant ou organisateur)*. |

### Notifications, calendrier, exploitation
| Méthode | Chemin | Rôle |
|---|---|---|
| GET | `/moi/notifications` | Les miennes, tous groupes, avec le nom du groupe. Paramètres `filtre` (`non_lues` / `toutes`), `limite` (1 à 200, 50 par défaut) et `avant` (curseur `<created_at>\|<id>`, pagination). |
| POST | `/moi/notifications/lecture` | Marquer lu (une, ou tout). |
| GET / PUT | `/moi/preferences-notifications` | Par groupe : e-mail immédiat, résumé quotidien, coupé. |
| GET / POST | `/moi/flux-ical` | Mes abonnements ; créer un jeton (**affiché une seule fois**). |
| DELETE | `/moi/flux-ical/:id` | Révoquer. |
| GET | `/ical/:jeton.ics` | **Hors `/api`, sans cookie.** Le flux de calendrier. |
| GET | `/api/sante` | Vivacité : base accessible, migrations à jour. Pour Docker et le proxy. |
| GET | `/api/version` | Étiquette d'image et numéro de migration, affichés en pied de page. |

## 7. Les trois intégrations

### 7.1 Flux iCal (B3)

- **Un ou plusieurs jetons par membre**, créés depuis `/moi/flux-ical`, stockés **hachés**
  (§3.12 du modèle). Le jeton en clair n'est affiché qu'à la création : on ne peut pas le
  retrouver, seulement en créer un autre et révoquer l'ancien.
- **URL** : `https://domaine/ical/<32 octets en base32url>.ics`. L'extension `.ics` est dans le
  chemin parce que certains clients de calendrier refusent une URL sans extension.
- **Contenu servi** : les événements `published` et `cancelled` (en `STATUS:CANCELLED`, pour
  que l'annulation **disparaisse** du calendrier du téléphone au lieu d'y rester) de **tous les
  groupes où l'appartenance est active**, ou d'un seul si le jeton est restreint ; plus mes
  créneaux personnels si `include_personal`. Fenêtre : 3 mois en arrière, 12 mois en avant, et
  l'intégralité des événements modifiés depuis.
- **Mise en forme** : un `VEVENT` par événement, `UID = <event.id>@attroupe`, `SEQUENCE` dérivé
  de `updated_at`, `DTSTART;TZID=` + `VTIMEZONE` pour les événements à l'heure,
  `DTSTART;VALUE=DATE` pour les journées entières (§4.2 du modèle), `LOCATION`, `DESCRIPTION`
  (lieu, consignes, lien vers l'événement), `ORGANIZER` et le préfixe du nom du groupe dans
  `SUMMARY` — « [La bande] Soirée raclette » — pour qu'on sache de quoi il s'agit dans un
  calendrier qui en agrège cinq.
- **Authentification** : le jeton **seul**, pas de cookie — un client de calendrier n'en a pas.
  En conséquence : cadence par jeton (60 requêtes/heure), `last_used_at` renseigné,
  `Cache-Control: private, max-age=300`, et aucune donnée d'un autre groupe dans la réponse
  même si le jeton d'un membre retiré est rejoué (la jointure sur `memberships.status` le
  filtre naturellement — **le cas est testé**).
- **Mise en cache** : `ETag` = empreinte de `(jeton, max(updated_at), nombre d'événements)` et
  réponse `304` si `If-None-Match` correspond. Les clients iOS et Android interrogent souvent
  et à heure fixe : un `304` coûte une requête d'agrégat, pas une génération.
> **Amendement du 2026-11-16 (n° 2, éprouvé sur un vrai iPhone).** La phrase ci-dessus « en `STATUS:CANCELLED`,
> pour que l'annulation **disparaisse** du calendrier du téléphone au lieu d'y rester » est **fausse**, et le texte
> est conservé tel quel pour que l'erreur reste visible. Vérifié sur un abonnement iOS réel (agent
> `dataaccessd`) : un événement servi en `STATUS:CANCELLED` **reste affiché**, barré. C'est l'omission d'un
> événement du fichier qui le fait disparaître, un abonnement iCal étant un remplacement complet par le contenu du
> flux. Le comportement actuel est donc **conservé par choix et non par hypothèse** : pour un groupe d'amis, « la
> soirée est annulée, barrée » vaut mieux qu'une soirée qui s'évapore sans explication. Les clients ne se
> comportent pas tous pareil (Google Agenda a tendance à masquer les annulés) : c'est une limite à documenter, pas
> à corriger.

> **Amendement du 2026-11-16 ([`ADR-0010`](../docs/decisions/ADR-0010-flux-ical.md), lot 5).** Deux points de
> cette section ont été tranchés autrement à l'implémentation, et le texte ci-dessus est conservé tel quel pour que
> l'écart reste visible :
> 1. les `DTSTART` des événements horodatés sont émis **en UTC** (`…Z`) et non `TZID=` + `VTIMEZONE` : la base stocke
>    déjà un instant, et écrire à la main les règles de changement d'heure serait une source de défauts pour un gain
>    nul. `TZID` redeviendra nécessaire avec la récurrence (V2) ;
> 2. la résolution du jeton exige une **exception nommée** de la garde du SQL brut
>    (`calendar_feed_tokens` filtrée par `token_hash = ?`), parce qu'un flux établit l'identité par son jeton et ne
>    peut donc pas fournir le `user_id` que la garde réclame. L'ADR en fixe les quatre bornes. La règle de fond est
>    intacte : le flux crée **un `GroupScope` par appartenance active** et lit les événements groupe par groupe.

- **Pas de CalDAV en V1.** L'abonnement iCal est en lecture seule et couvre le besoin (« les
  soirées apparaissent dans l'agenda »). CalDAV supposerait d'implémenter un serveur
  d'écriture : hors périmètre, et non demandé.

### 7.2 Immich (D11, `ADR-0003`)

- **Configuration par groupe** : URL + clé d'API, saisies par un administrateur du groupe, clé
  **chiffrée** en AES-256-GCM avec `ATTROUPE_ENCRYPTION_KEY`. L'API ne renvoie **jamais** la
  clé, seulement son empreinte courte et l'état de la dernière vérification.
- **Sans configuration, pas d'onglet.** `GET /groupes/:g` renvoie
  `fonctionnalites: { photos: false }` et le client ne propose rien. Aucune route photo ne
  renvoie 500 : elles répondent `409 immich.non_configure`.
- **Appels sortants** : délai de 4 s par appel, 2 tentatives sur erreur réseau, jamais de
  nouvelle tentative sur un 4xx. Un échec se traduit par `status = 'unreachable'` sur la
  configuration et un message dans l'interface — **jamais** par une erreur qui casse la page
  de l'événement.
- **Validation de l'URL** à l'enregistrement, parce qu'une URL fournie par un utilisateur et
  appelée par le serveur est une porte ouverte (SSRF) : schéma `http`/`https` uniquement, pas
  de redirection suivie, résolution DNS vérifiée, et **adresses privées autorisées
  explicitement** par `ATTROUPE_IMMICH_ALLOW_PRIVATE=true` (le cas normal dans un homelab, mais
  à assumer et non à deviner).
- **URL signées et expirantes** — le point dur de l'`ADR-0003`. Aucune URL d'Immich n'atteint
  jamais le navigateur :

  ```
  GET /media/:albumId/:assetId/:taille?exp=1763212800&sig=<HMAC-SHA256 tronqué>
  signature = HMAC(ATTROUPE_SIGNED_URL_SECRET, albumId|assetId|taille|userId|exp)
  ```

  La signature **inclut l'identifiant de l'utilisateur** : une URL partagée hors de
  l'application ne fonctionne pas pour quelqu'un d'autre, puisque le serveur recalcule la
  signature avec l'identité de l'appelant. Durée de vie : 15 minutes pour une vignette, 5
  minutes pour un original. À réception, le serveur vérifie la signature, **puis** l'existence
  de la ligne `album_assets` **dans le groupe**, **puis** l'appartenance active — et seulement
  alors relaie le flux d'Immich avec sa clé. Le partage public d'album (D7) est en V2 et
  passera par un jeton distinct, révocable.
- **Synchronisation** : à l'ouverture d'un album si `last_synced_at` a plus de 5 minutes, et
  par une tâche périodique quotidienne. Immich reste maître : nos lignes `album_assets` sont un
  cache, et une divergence se résout toujours en faveur d'Immich (`removed_at`, `orphan`).

### 7.3 E-mails par Brevo (F2)

- **Rien n'est envoyé dans le cycle d'une requête HTTP.** Une action crée une ligne
  `notifications` et, si les préférences le demandent, une ligne `email_outbox`. Une tâche
  périodique (toutes les 30 s) remet la file à l'API transactionnelle de Brevo. Conséquence :
  une invitation n'est jamais perdue parce que Brevo était en panne ou que le conteneur a
  redémarré, et la création d'un événement reste instantanée pour l'utilisateur.
- **Report exponentiel** (1 min, 5, 25, 2 h, 12 h), `abandoned` au bout de 6 échecs, erreur
  visible dans la page d'exploitation.
- **Gabarits locaux**, pas des gabarits Brevo : le texte vit dans `server/i18n/fr.json` et
  passe en revue avec le code. Brevo n'est qu'un transporteur, remplaçable par SMTP si le
  compte disparaît.
- **Résumé quotidien** (`digest = 'daily'`) : un e-mail par groupe et par jour regroupant les
  notifications non lues, envoyé à 19 h dans le fuseau du groupe.
- **Contenu minimal** : un e-mail dit « il y a du nouveau sur *telle soirée* dans *tel
  groupe* » et renvoie un lien. Il ne recopie ni le contenu des messages, ni les montants : les
  e-mails traversent des serveurs qui ne nous appartiennent pas.

## 8. Stratégie de tests

Quatre niveaux, et un cinquième qui n'est pas négociable.

| Niveau | Dossier | Ce qu'on y met | Ce qu'on n'y met pas |
|---|---|---|---|
| **Unité** | `tests/unite/` | Tout `domain/` : répartition et reliquat, soldes qui se bouclent à zéro, conversions de devise, fuseaux et journées entières, génération iCal. Rapide, sans base. | Rien qui touche à Express ou à SQLite. |
| **Intégration** | `tests/integration/` | Une route de bout en bout sur une base de fichier temporaire, migrations jouées : codes de retour, effets en base, transactions. Un fichier par domaine. | Les appels réseau réels : Immich et Brevo sont remplacés par des doubles. |
| **Cloisonnement** | `tests/cloisonnement/` | **Voir ci-dessous.** | — |
| **Schéma** | `tests/schema/` | `group_id` sur toute table métier, absence de colonne bancaire, `PRAGMA foreign_keys = 1`, migrations idempotentes (jouées deux fois), somme des parts = total sur un jeu de données généré. | — |
| **Client** | `app/client` | Les composants à logique réelle (saisie d'un montant, grille d'agenda) et un parcours complet au navigateur sur le chemin critique : sondage → événement → iCal. | Des tests de rendu sur chaque bouton. |

### La suite de cloisonnement

L'`ADR-0002` exige « pour chaque route, un test ». Écrit route par route à la main, cela se
dégrade dès la dixième. Le dispositif retenu est donc **un registre et une boucle** :

```ts
// tests/cloisonnement/registre.ts — une entrée par route métier
export const ROUTES: EntreeRoute[] = [
  { methode: 'GET',    chemin: '/api/groupes/:g/evenements/:e',          ressource: 'evenement' },
  { methode: 'PATCH',  chemin: '/api/groupes/:g/evenements/:e',          ressource: 'evenement', corps: { title: 'pirate' } },
  { methode: 'PUT',    chemin: '/api/groupes/:g/listes/:l/articles/:i/preneur', ressource: 'article', corps: { prend: true } },
  // …
];
```

Et un seul fichier de test qui, pour **chaque** entrée, monte le décor `deuxGroupes()` (groupe A
avec Alice, groupe B avec Bob, et un exemplaire de chaque ressource dans chacun) puis exécute
quatre attaques :

1. **Identifiant forgé** : Alice appelle la route avec `:g` = son groupe et l'identifiant de la
   ressource **de B** → attendu **404**, et aucune écriture en base.
2. **Groupe forgé** : Alice appelle avec `:g` = le groupe **B** et un identifiant de B →
   attendu **404** (pas 403 : on ne confirme pas l'existence de B).
3. **Sans session** → **401**.
4. **Membre retiré** : Alice, dont l'appartenance est passée à `removed`, rappelle une route de
   son ancien groupe → **404**, alors que son historique est toujours là.

Puis **un test de complétude** : la liste des routes réellement montées par Express est extraite
du routeur, et le test **échoue si une route métier n'a pas d'entrée dans le registre**. C'est
ce test qui fait tenir la promesse de l'`ADR-0002` dans le temps : ajouter une route sans la
déclarer casse la construction, donc l'intégration continue, donc la publication de l'image.

Deux cas particuliers à couvrir à la main, parce qu'ils sortent du schéma général :

- **Le flux iCal** : un jeton d'un membre de A ne doit jamais contenir un événement de B ; un
  jeton révoqué renvoie 404 ; un jeton d'un membre retiré ne renvoie plus les événements du
  groupe quitté.
- **Les médias Immich** : une URL signée pour Alice rejouée par Bob échoue ; une signature
  valide dont l'`assetId` appartient à un album de B échoue ; une URL expirée échoue.

### Intégration continue (`ci.yml`)

`npm ci` → `lint` → `tsc --noEmit` → `vitest run` (les cinq niveaux) → `vite build` →
construction de l'image. **Aucune image n'est publiée si un test de cloisonnement échoue** :
c'est le seul couplage voulu entre les tests et la publication.

## 9. Conteneur et déploiement

Cohérent avec l'[`ADR-0005`](../docs/decisions/ADR-0005-deploiement.md) : images construites
par l'intégration continue, publiées sur GHCR en `latest` (branche `main`) et `beta` (branche
`beta`), migrations jouées au démarrage, **aucun privilège sur l'hôte**.

### Image

Construction en trois étapes, pour que l'image finale ne contienne ni compilateur ni source :

1. `node:24-bookworm` — installation des dépendances et **compilation de `better-sqlite3`** ;
2. la même étape compile le client (`vite build`) et le serveur (`tsc`) ;
3. `node:24-bookworm-slim` — on copie `node_modules` de production, `dist/` du serveur, les
   fichiers statiques du client et `migrations/`.

Points de l'image qui ne sont pas des détails :

- `tzdata` **installé** : sans la base de fuseaux, tout le §4.2 du modèle de données est faux ;
- exécution en **`USER node`** (non-root), `WORKDIR /app`, `/data` possédé par `node` ;
- `EXPOSE 3000`, `HEALTHCHECK` sur `/api/sante` ;
- `NODE_ENV=production`, `--enable-source-maps` pour des traces lisibles ;
- **aucun accès** à `/var/run/docker.sock`, aucune capacité ajoutée : l'application ne sait pas
  qu'elle tourne dans Docker, et ne peut donc pas se mettre à jour elle-même — c'est la
  conclusion de l'`ADR-0005`, et elle se lit dans le `Dockerfile`.

### `docker-compose.yml` (principe)

```yaml
services:
  attroupe:
    image: ghcr.io/lokyron/attroupe:${ATTROUPE_TAG:-latest}   # 'beta' sur le LXC 113
    container_name: attroupe
    restart: unless-stopped
    ports: ["${ATTROUPE_PORT:-3000}:3000"]
    env_file: .env
    volumes:
      - ./data:/data          # base SQLite (+ -wal, -shm) et fichiers déposés
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/sante').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      start_period: 20s
    security_opt: ["no-new-privileges:true"]
    read_only: false          # /data doit rester inscriptible
```

Un seul service, un seul volume, un seul port : la « commande unique » de l'`ADR-0001` reste
vraie, et la mise à jour est `docker compose pull && docker compose up -d`.

### Variables d'environnement attendues (`.env.example`)

| Clé | Obligatoire | Rôle |
|---|---|---|
| `ATTROUPE_TAG` | non (`latest`) | Étiquette d'image : `latest` en production, `beta` en pré-production. Le seul écart entre les deux piles. |
| `ATTROUPE_PORT` | non (`3000`) | Port publié sur l'hôte. |
| `ATTROUPE_BASE_URL` | **oui** | URL publique. Sert aux liens des e-mails et aux URL de flux iCal. Sans elle, une invitation renvoie vers nulle part. |
| `ATTROUPE_DATA_DIR` | non (`/data`) | Base et fichiers. |
| `ATTROUPE_SESSION_SECRET` | **oui** | 32 octets en base64. Signature des cookies. |
| `ATTROUPE_ENCRYPTION_KEY` | **oui** | 32 octets en base64. Chiffre les clés d'API Immich. **Sa perte rend les configurations Immich illisibles** (elles se ressaisissent). |
| `ATTROUPE_SIGNED_URL_SECRET` | **oui** | 32 octets en base64. Signe les URL de médias. |
| `BREVO_API_KEY` | non | Sans elle, les e-mails restent en file et l'interface le signale. |
| `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME` | si Brevo | Expéditeur. |
| `ATTROUPE_REGISTRATION` | non (`open`) | `open` ou `invite`. |
| `ATTROUPE_IMMICH_ALLOW_PRIVATE` | non (`false`) | Autorise des URL Immich sur adresses privées (cas normal en homelab). |
| `ATTROUPE_TRUST_PROXY` | non (`1`) | Nombre de proxys de confiance en amont, pour l'adresse réelle du client. |
| `ATTROUPE_LOG_LEVEL` | non (`info`) | |
| `ATTROUPE_SSE_MAX_CONNECTIONS` | non (`200`) | plafond global de flux temps réel (lot 6) |
| `TZ` | non (`Europe/Paris`) | Fuseau du conteneur, pour les journaux et les tâches quotidiennes. |

Le démarrage **échoue bruyamment** si une clé obligatoire manque ou si un secret fait moins de
32 octets. Un secret par défaut en dur n'existe pas : mieux vaut un conteneur qui refuse de
démarrer qu'une instance signée avec `changeme`.

### Démarrage, migrations et sauvegarde

1. Lecture et validation de l'environnement ;
2. ouverture de la base, `PRAGMA` posés, **vérification que `foreign_keys` vaut 1** ;
3. migrations : les fichiers de `migrations/` non présents dans `schema_migrations` sont joués
   dans l'ordre, **chacun dans une transaction**, et un échec arrête le démarrage sans servir
   une seule requête. Le `checksum` d'une migration déjà jouée est comparé : une divergence est
   une erreur fatale (quelqu'un a modifié une migration publiée) ;
4. **sauvegarde automatique avant migration** : si des migrations sont à jouer,
   `VACUUM INTO /data/sauvegardes/avant-0003-<horodatage>.db` d'abord. C'est ce qui rend le
   retour arrière de l'`ADR-0005` réellement possible — repointer l'étiquette ne suffit pas si
   le schéma a changé ;
5. écoute, puis démarrage des tâches périodiques.

Sauvegarde courante (F5) : `scripts/sauvegarde.sh` fait un `VACUUM INTO` (cohérent même pendant
l'écriture, contrairement à une copie de fichier en WAL) plus une archive de `/data/fichiers`.
La bibliothèque Immich est sauvegardée **ailleurs, par Immich** (`ADR-0003`).

## 10. Découpage de l'implémentation en lots

Chaque lot est livrable : il se termine par une fusion dans `beta`, une image publiée, et une
mise en service sur le LXC 113. L'ordre est contraint par les dépendances, et les trois premiers
lots ne produisent **rien de visible** — c'est assumé, ils installent ce qui rend le reste sûr.

| # | Lot | « Terminé » veut dire |
|---|---|---|
| **0** | **Squelette** : espaces de travail npm, TypeScript strict, ESLint (dont la règle d'interdiction d'importer `db/connection`), Vitest, `Dockerfile`, `docker-compose.yml`, `ci.yml`, `.env.example`. | `docker compose up` sert une page blanche et `/api/sante` répond `200`. L'intégration continue est verte et publie une image `beta`. |
| **1** | **Base et cloisonnement** : `0001_socle.sql`, `connection.ts` (+ vérification des `PRAGMA`), `migrate.ts` (idempotence, checksum, sauvegarde avant migration), `scope.ts`, la garde sur le SQL brut, les tests de schéma. | Les migrations se jouent deux fois sans erreur ; le test de schéma passe ; **le `GroupScope` existe et aucune requête ne compile sans lui**. |
| **2** | **Comptes** : inscription, connexion, sessions, mot de passe oublié, `/moi`, cadence, CSRF, file `email_outbox` + service Brevo. | On crée un compte, on reçoit un vrai e-mail, on se reconnecte, on révoque un appareil. Un e-mail en panne de Brevo part après rétablissement. |
| **3** | **Groupes, membres, invitations** : création de groupe, sélecteur dans l'interface, rôles, invitation par e-mail **et** par nom d'utilisateur exact (**le rattachement d'une invitation par e-mail à un compte exige `email_verified_at` non nul** : sinon quelqu'un qui inscrit `victime@x` avant la victime récupère ses invitations, une fuite entre groupes), retrait, départ. **Le registre de cloisonnement et sa boucle de test sont mis en place ici**, avec les routes existantes. | Deux comptes, deux groupes, et la suite de cloisonnement passe sur toutes les routes déjà écrites. Le test de complétude du registre est actif. |
| **4** | **Agenda du groupe** : événements (création, modification, annulation), vues mois/semaine/liste, présences et compteurs, co-organisateurs, fil de discussion de l'événement créé avec lui. | Un événement se crée depuis un téléphone, trois comptes répondent, les compteurs sont justes, et le cloisonnement passe. |
| **5** | **Flux iCal** : jetons, génération du `VCALENDAR`, `ETag`/`304`, cadence. | Une URL collée dans le calendrier d'un iPhone **et** d'un Android fait apparaître les soirées, une modification se propage, une annulation disparaît. C'est le critère de réussite n° 2 de la vision. |
| **6** | **Listes de courses et tâches** : articles, preneur, case à cocher, tâches, flux SSE. | Trois personnes cochent en même temps sur trois téléphones et voient les changements sans recharger. Critère de réussite n° 3. |
| **7** | **Sondages de dates** : créneaux, votes, dépouillement, conversion en événement. | Un sondage se décide et produit un événement, avec la trace dans les deux sens. Critère de réussite n° 1. |
| **8** | **Agenda personnel** : créneaux personnels, partage par groupe (rien / occupé / détail), vue des disponibilités, inclusion dans l'iCal. | Un créneau en « occupé » n'expose **aucun** titre : vérifié par un test sur la charge utile renvoyée, pas sur l'affichage. |
| **9** | **Dépenses** : `domain/argent.ts`, `repartition.ts`, `soldes.ts` **écrits et testés d'abord**, puis les routes, les remboursements déclarés, la clôture, le multi-devises. | Le test de propriétés passe : toute suite de dépenses se solde à zéro, les parts somment au total, la répartition est reproductible, un cas en JPY est couvert. **Aucune colonne bancaire** (test). |
| **10** | **Fils libres et notifications** : fils de groupe, messages, notifications en base, e-mails immédiats et résumé quotidien, préférences. | Une action dans le groupe A ne notifie jamais quelqu'un qui n'y est pas, et chaque notification dit de quel groupe elle parle. |
| **11** | **Photos / Immich** : configuration par groupe (clé chiffrée, test de connexion, validation anti-SSRF), albums liés aux événements, dépôt direct, vignettes, visionneuse, URL signées. | Avec Immich branché : les photos arrivent dans le bon album. **Sans Immich : l'onglet est absent et tout le reste fonctionne** — testé explicitement. Les attaques sur les URL signées échouent. |
| **12** | **Finition** : PWA installable (manifeste, service worker, icônes), passe mobile sur chaque écran, `scripts/sauvegarde.sh` et `restauration.sh`, page d'exploitation, `DOCUMENTATION.md` à jour, bascule `main` → `latest` sur le LXC 112. | L'application s'installe depuis un téléphone, une sauvegarde se restaure dans un conteneur vierge et retrouve l'état, et la production tourne. |

**Deux règles de séquencement qui ne se négocient pas** : le lot 1 précède tout code métier
(après, le cloisonnement se rattrape route par route), et dans le lot 9 le domaine pur de
l'argent est écrit et testé **avant** la première route de dépense.

## 11. Points ouverts et risques

| # | Sujet | État |
|---|---|---|
| 1 | **Statut de `node:sqlite` sur Node 24** et binaires précompilés de `better-sqlite3` | À vérifier au lot 0. Renverse éventuellement l'`ADR-0008`, sans autre conséquence. |
| 2 | **Sous-domaine public** (point ouvert n° 1 du périmètre) | Bloquant pour `ATTROUPE_BASE_URL`, donc pour les liens d'invitation et l'iCal. À trancher avant le lot 2. |
| 3 | **GPL ou AGPL** (point ouvert n° 4) | À figer avant la première poussée publique, donc avant le lot 0. |
| 4 | **Quotas** (taille des dépôts, nombre de membres) | Aucun en V1. Si l'instance est réellement ouverte à des inconnus, c'est le prochain sujet de sécurité après le cloisonnement. |
| 5 | **Journal d'audit** (F7) | En V2 au périmètre. Mon avis : les cinq actions sensibles (retrait de membre, suppression de groupe, suppression d'album, clôture des comptes, changement de configuration Immich) mériteraient d'être tracées dès le lot 3, pour quelques dizaines de lignes. |
| 6 | **Écritures concurrentes** | SQLite sérialise ; `busy_timeout` à 5 s. Le risque réel est le flux SSE combiné aux cases cochées en rafale par huit personnes dans un magasin : à éprouver au lot 6, c'est le seul endroit où la charge est en pointe. |
|   | *Amendement du 2026-11-16 (lot 6)* | Éprouvé : requêtes simultanées (huit comptes) **et** quatre processus sur le même fichier (`tests/integration/listes-concurrence.test.ts`). Ce dernier a montré qu'avec le `BEGIN` différé, une transaction qui lit puis écrit échoue en `SQLITE_BUSY` sans attendre : `executerEnTransaction` est en `BEGIN IMMEDIATE`. Voir [`ADR-0011`](../docs/decisions/ADR-0011-temps-reel-listes-taches.md). |
| 7 | **Hors ligne** (F1 mentionne la consultation hors ligne) | La PWA du lot 12 met en cache la coquille et la dernière vue consultée, sans écriture hors ligne. Une vraie synchronisation différée est un projet à elle seule : à écarter explicitement de la V1. |
