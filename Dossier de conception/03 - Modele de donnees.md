# 03 — Modèle de données — Attroupe

> Décidé le 2026-11-15 par l'architecte, sur la base de `02 - Perimetre et jalons.md` et des
> ADR 0001 à 0005. Ce document est la référence du schéma de la **V1**. Toute évolution se
> fait par une migration numérotée et une mise à jour de ce fichier.
>
> Portée : SQLite en mode `STRICT`, clés étrangères actives, WAL. SQL explicite, pas d'ORM
> ([`ADR-0001`](../docs/decisions/ADR-0001-stack-technique.md)).

## 0. Les sept règles que le schéma doit rendre visibles

1. **Chaque table métier porte son groupe.** Colonne `group_id TEXT NOT NULL`, et une clé
   étrangère **composite** vers le parent qui force la cohérence de groupe au niveau de la
   base, pas seulement du code (§4.1). Une seule exception, documentée et encadrée :
   `personal_events` (§3.6).
2. **L'acteur dans un groupe est une appartenance, pas un compte.** Tout ce qui est « qui a
   fait quoi » référence `memberships.id`, jamais `users.id`. Conséquence directe : retirer
   un membre n'efface rien, puisque la ligne d'appartenance reste (§4.3).
3. **Les montants sont des entiers d'unités mineures**, toujours accompagnés de leur code
   ISO 4217. Jamais de `REAL` sur une somme d'argent. Additionner deux devises est une
   erreur, pas une conversion implicite (§4.4).
4. **Le taux de change est figé à la saisie** et conservé sur la ligne de dépense, avec le
   montant déjà converti. Un solde passé ne bouge jamais (§4.4).
5. **Aucune donnée bancaire.** Aucune colonne IBAN, BIC, titulaire, carte, jeton de
   prestataire. Les remboursements sont des *déclarations* (`settlements`), pas des flux.
6. **L'historique survit au départ.** Aucun `ON DELETE CASCADE` vers une appartenance ou un
   compte ; les suppressions métier sont des marquages (§4.3).
7. **Rien de devinable.** Identifiants opaques, jetons stockés **hachés**, clés d'API Immich
   stockées **chiffrées**, URL de photos signées et expirantes.

## 1. Conventions

| Sujet | Règle |
|---|---|
| **Clé primaire** | `TEXT` contenant un **UUID v7** (26–36 caractères, ordonnable dans le temps). Opaque, pas de compteur à incrémenter, donc pas de fuite de volumétrie entre groupes. |
| **Dates et heures** | `TEXT` ISO 8601 UTC, format exact `AAAA-MM-JJTHH:MM:SSZ`. Les dates sans heure (journée entière, date d'une dépense) sont `TEXT` `AAAA-MM-JJ`. Jamais d'entier epoch : la base reste lisible en `sqlite3`. |
| **Booléens** | `INTEGER` contraint `CHECK (col IN (0, 1))`. `STRICT` n'a pas de type booléen. |
| **Énumérations** | `TEXT` + `CHECK (col IN (...))`. Pas de table de référence pour trois valeurs. |
| **Horodatage de ligne** | `created_at` partout, `updated_at` sur tout ce qui est modifiable, `deleted_at` sur tout ce qui porte de l'historique. |
| **Suppression** | `deleted_at IS NULL` fait partie de **toute** lecture métier. Voir §4.3. |
| **Nommage** | Tables et colonnes en anglais, au pluriel pour les tables, `snake_case`. Les textes destinés aux humains sont en français mais vivent dans le fichier de traduction, pas dans la base (sauf contenu saisi par l'utilisateur). |
| **Index** | Tout index de lecture métier commence par `group_id`. Un index qui ne commence pas par `group_id` sur une table métier est un signal d'alerte en revue. |

## 2. Carte des tables

| Domaine | Tables | Portée groupe |
|---|---|---|
| Référence | `schema_migrations`, `currencies` | — |
| Comptes | `users`, `user_identities`, `sessions`, `password_reset_tokens` | — (transverses) |
| Groupes | `groups`, `memberships`, `invitations` | racine / `group_id` |
| Planning groupe | `events`, `event_organizers`, `event_attendances` | `group_id` |
| Planning perso | `personal_events`, `personal_event_shares` | exception encadrée (§3.6) |
| Décision de date | `date_polls`, `date_poll_options`, `date_poll_votes` | `group_id` |
| Préparation | `shopping_lists`, `shopping_items`, `event_tasks` | `group_id` |
| Discussion | `threads`, `messages` | `group_id` |
| Dépenses | `expenses`, `expense_shares`, `settlements`, `expense_closures` | `group_id` |
| Photos | `group_immich_configs`, `albums`, `album_assets` | `group_id` |
| Diffusion | `calendar_feed_tokens`, `notifications`, `notification_preferences`, `email_outbox` | `group_id` (ou `NULL` assumé) |

Soit **33 tables** en V1, dont 2 de référence.

## 3. Le schéma, domaine par domaine

Chaque sous-section donne : ce que représente **une ligne**, les colonnes, les contraintes
d'unicité et les index. Le SQL exécutable complet est en §5.

### 3.1 Référence

**`schema_migrations`** — une ligne = une migration déjà jouée sur cette base.

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `version` | TEXT | **PK** | Nom du fichier sans extension (`0001_socle`). |
| `applied_at` | TEXT | NOT NULL | Quand elle a été jouée. |
| `checksum` | TEXT | NOT NULL | SHA-256 du fichier, pour détecter une migration modifiée après coup. |

**`currencies`** — une ligne = une devise acceptée par l'instance.

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `code` | TEXT | **PK**, `CHECK (length(code) = 3)` | Code ISO 4217 (`EUR`, `JPY`). |
| `exponent` | INTEGER | NOT NULL, `CHECK (exponent BETWEEN 0 AND 4)` | Nombre de décimales. `2` pour l'euro, **`0` pour le yen**. C'est cette colonne qui résout proprement les devises sans sous-unité (§4.5). |
| `symbol` | TEXT | NOT NULL | `€`, `¥`. Affichage seulement. |
| `name_key` | TEXT | NOT NULL | Clé de traduction (`currency.eur`), pas un libellé en dur. |
| `is_enabled` | INTEGER | NOT NULL DEFAULT 1, booléen | Permet d'élaguer la liste de l'`ADR-0004` sans migration. |

> Les 17 devises de l'[`ADR-0004`](../docs/decisions/ADR-0004-depenses-devises.md) sont
> insérées par la migration initiale. Le point ouvert n° 5 du périmètre (quelles devises
> exactement) se règle donc par un `UPDATE … SET is_enabled = 0`, jamais par du code.

### 3.2 Comptes et sessions

**`users`** — une ligne = une personne inscrite sur l'instance.

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `id` | TEXT | **PK** | |
| `email` | TEXT | NOT NULL, **UNIQUE** sur `lower(email)` (index unique sur expression) | Adresse de connexion et de notification. |
| `email_verified_at` | TEXT | NULL | Non bloquant en V1, mais tracé. |
| `username` | TEXT | NOT NULL, **UNIQUE** sur `lower(username)`, `CHECK (length(username) BETWEEN 3 AND 32)` | Identifiant public, sert à l'ajout d'un membre existant (§3.4). |
| `display_name` | TEXT | NOT NULL | Prénom ou pseudo affiché. |
| `password_hash` | TEXT | NULL | **Nullable** : un compte créé par « connexion Google » (V2) n'en a pas. Format `scrypt$N$r$p$sel$empreinte`. |
| `avatar_path` | TEXT | NULL | Chemin relatif dans le volume de données. Pas de blob en base. |
| `birthday` | TEXT | NULL | `AAAA-MM-JJ` ou `--MM-JJ` si l'année n'est pas donnée. Alimente B8 en V2. |
| `locale` | TEXT | NOT NULL DEFAULT `'fr'` | |
| `time_zone` | TEXT | NOT NULL DEFAULT `'Europe/Paris'` | Fuseau d'affichage par défaut (§4.1). |
| `is_instance_admin` | INTEGER | NOT NULL DEFAULT 0, booléen | Administrateur **de l'instance**. Ce drapeau ne donne **aucun** accès au contenu des groupes : il n'est jamais consulté par la couche de cloisonnement. |
| `created_at`, `updated_at` | TEXT | NOT NULL | |
| `disabled_at` | TEXT | NULL | Compte suspendu par l'administrateur d'instance. |
| `anonymized_at` | TEXT | NULL | Suppression de compte (V2, F8) : les colonnes personnelles sont écrasées, la ligne reste pour que l'historique tienne (§4.3). |

Index : `idx_users_email_lower` (unique), `idx_users_username_lower` (unique).

**`user_identities`** — une ligne = une façon externe de prouver son identité. **Vide en V1**,
créée tout de suite pour que « connexion Google » soit une insertion et non une migration
structurelle.

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `id` | TEXT | **PK** | |
| `user_id` | TEXT | NOT NULL → `users(id)` | |
| `provider` | TEXT | NOT NULL, `CHECK (provider IN ('google'))` | La liste s'étend par migration quand un fournisseur arrive. |
| `subject` | TEXT | NOT NULL | Identifiant stable chez le fournisseur (`sub` OIDC). |
| `email_at_provider` | TEXT | NULL | Pour diagnostic, jamais pour authentifier. |
| `created_at`, `last_used_at` | TEXT | | |

Unicité : `UNIQUE (provider, subject)`, et `UNIQUE (user_id, provider)` — un compte, une
identité par fournisseur.

**`sessions`** — une ligne = une session ouverte sur un appareil.

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `id` | TEXT | **PK** | |
| `user_id` | TEXT | NOT NULL → `users(id)` ON DELETE CASCADE | Seule cascade acceptée : une session n'est pas de l'historique. |
| `token_hash` | TEXT | NOT NULL, **UNIQUE** | SHA-256 du jeton de 32 octets. Le jeton en clair n'existe que dans le cookie. |
| `created_at`, `expires_at` | TEXT | NOT NULL | Glissant : prolongé à l'usage, plafonné (§Architecture). |
| `last_seen_at` | TEXT | NOT NULL | |
| `user_agent`, `ip_hash` | TEXT | NULL | `ip_hash` = HMAC de l'adresse, pour lister ses sessions sans journaliser d'IP en clair. |
| `revoked_at` | TEXT | NULL | |

Index : `idx_sessions_user (user_id, expires_at)`.

**`password_reset_tokens`** — une ligne = une demande de réinitialisation en cours.
Colonnes : `id` PK, `user_id` NOT NULL → `users`, `token_hash` UNIQUE NOT NULL,
`created_at`, `expires_at` NOT NULL, `used_at` NULL. Purge au-delà de 24 h.

### 3.3 Groupes, appartenances et rôles

**`groups`** — une ligne = un cercle étanche (la bande, les collègues, la coloc). C'est la
racine de tout le cloisonnement.

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `id` | TEXT | **PK** | Apparaît dans toutes les URL métier. |
| `name` | TEXT | NOT NULL, `CHECK (length(name) BETWEEN 1 AND 80)` | |
| `slug` | TEXT | NOT NULL, **UNIQUE** | Pour des URL lisibles. Unique sur l'instance, donc révèle l'existence d'un nom : on le génère avec un suffixe aléatoire. |
| `default_currency_code` | TEXT | NOT NULL → `currencies(code)` DEFAULT `'EUR'` | Devise des soldes par défaut ([`ADR-0004`](../docs/decisions/ADR-0004-depenses-devises.md) §4). |
| `time_zone` | TEXT | NOT NULL DEFAULT `'Europe/Paris'` | Fuseau de référence du groupe (§4.1). |
| `created_by_user_id` | TEXT | NOT NULL → `users(id)` | Créateur. Référence un **compte** et non une appartenance : c'est le seul cas, la ligne précède l'appartenance. |
| `created_at`, `updated_at` | TEXT | NOT NULL | |
| `archived_at` | TEXT | NULL | Groupe mis en sommeil : lecture seule. |
| `deleted_at` | TEXT | NULL | Suppression par son administrateur. Purge physique différée (§4.3). |

**`memberships`** — une ligne = l'appartenance d'un compte à un groupe, **et le porteur de son
historique dans ce groupe**. Une ligne n'est jamais supprimée.

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `id` | TEXT | **PK**, et **`UNIQUE (id, group_id)`** | Le doublon d'unicité est volontaire : il rend possible les clés étrangères composites (§4.1). |
| `group_id` | TEXT | NOT NULL → `groups(id)` | |
| `user_id` | TEXT | NOT NULL → `users(id)` | |
| `role` | TEXT | NOT NULL, `CHECK (role IN ('admin', 'member'))` | Administrateur **du groupe** ou membre. Le rôle d'organisateur est **par événement**, pas ici (§3.5). |
| `status` | TEXT | NOT NULL, `CHECK (status IN ('active', 'removed', 'left'))` | `removed` = retiré par un administrateur, `left` = parti de lui-même. Dans les deux cas l'historique reste. |
| `nickname` | TEXT | NULL | Surnom dans ce groupe seulement. |
| `joined_at` | TEXT | NOT NULL | |
| `ended_at` | TEXT | NULL | Non nul si et seulement si `status <> 'active'` (`CHECK`). |
| `created_at`, `updated_at` | TEXT | NOT NULL | |

Unicité : `UNIQUE (group_id, user_id)` — une personne a **une** ligne par groupe, réactivée
plutôt que dupliquée si elle revient. Index : `idx_memberships_user (user_id, status)` pour le
sélecteur de groupes, `idx_memberships_group (group_id, status)` pour la liste des membres.

> **Règle de lecture** : la liste des membres actifs filtre `status = 'active'`, mais l'affichage
> d'une dépense ou d'un message de 2024 joint `memberships` **sans** filtre de statut, et
> l'interface marque « ancien membre ». C'est ce qui satisfait la règle 6.

**Invariant à tester** : un groupe a toujours au moins un `admin` actif. Le retrait du dernier
administrateur est refusé par la couche métier (pas exprimable en `CHECK`).

### 3.4 Invitations

**`invitations`** — une ligne = une proposition d'entrer dans un groupe, en attente de réponse.
Couvre les deux chemins du périmètre A1 : par **e-mail** (la personne n'a pas de compte) et par
**nom d'utilisateur ou e-mail exact** (la personne a déjà un compte).

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `id` | TEXT | **PK** | |
| `group_id` | TEXT | NOT NULL → `groups(id)` | |
| `invited_by_membership_id` | TEXT | NOT NULL, FK composite → `memberships(id, group_id)` | Qui invite, dans ce groupe. |
| `kind` | TEXT | NOT NULL, `CHECK (kind IN ('email', 'existing_user'))` | |
| `target_user_id` | TEXT | NULL → `users(id)` | Renseigné si `kind = 'existing_user'`. |
| `email` | TEXT | NULL | Renseigné si `kind = 'email'`. `CHECK` : exactement l'un des deux est non nul. |
| `role` | TEXT | NOT NULL DEFAULT `'member'`, `CHECK (role IN ('admin','member'))` | Rôle proposé. |
| `token_hash` | TEXT | NULL, **UNIQUE** | Jeton du lien d'acceptation, **haché**. `NULL` pour `existing_user` : l'invitation s'accepte depuis l'application connectée, aucun lien n'est nécessaire. |
| `status` | TEXT | NOT NULL, `CHECK (status IN ('pending','accepted','declined','revoked','expired'))` | |
| `message` | TEXT | NULL | Mot d'accompagnement, ≤ 500 caractères. |
| `created_at`, `expires_at` | TEXT | NOT NULL | 14 jours par défaut. |
| `responded_at` | TEXT | NULL | |
| `resulting_membership_id` | TEXT | NULL, FK composite → `memberships(id, group_id)` | Trace de ce que l'acceptation a produit. |

Unicité : index unique partiel `UNIQUE (group_id, target_user_id) WHERE status = 'pending'` et
`UNIQUE (group_id, lower(email)) WHERE status = 'pending'` — on ne spamme pas la même personne
avec dix invitations au même groupe. Index : `idx_invitations_target (target_user_id, status)`
pour le badge « vous avez une invitation ».

> **Pourquoi aucune adhésion d'office** : il n'existe aucun chemin qui crée un `memberships`
> actif sans passer par une invitation `accepted` (ou par la création du groupe). C'est la
> contrepartie du fait qu'un membre s'ajoute par nom d'utilisateur. La recherche d'une cible
> est une **correspondance exacte** sur `lower(username)` ou `lower(email)` et ne renvoie
> jamais de liste : pas d'annuaire, pas d'énumération.

### 3.5 Événements du groupe, organisateurs et présences

**`events`** — une ligne = une soirée, une sortie, un créneau commun du groupe.

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `id` | TEXT | **PK**, **`UNIQUE (id, group_id)`** | Cible des FK composites. |
| `group_id` | TEXT | NOT NULL → `groups(id)` | |
| `title` | TEXT | NOT NULL | |
| `description` | TEXT | NULL | Consignes, thème, places de couchage (C1). Markdown restreint. |
| `location_name` | TEXT | NULL | « Chez Paul », « Gare de Lyon ». |
| `location_address` | TEXT | NULL | |
| `location_lat`, `location_lon` | REAL | NULL | Les seuls `REAL` du schéma : des coordonnées, pas de l'argent. Préparent D10. |
| `all_day` | INTEGER | NOT NULL DEFAULT 0, booléen | |
| `starts_at`, `ends_at` | TEXT | NOT NULL / NULL | Si `all_day = 0` : instant UTC `…Z`. Si `all_day = 1` : date `AAAA-MM-JJ` flottante. `CHECK` sur la longueur selon `all_day`, et `CHECK (ends_at IS NULL OR ends_at >= starts_at)`. |
| `time_zone` | TEXT | NOT NULL | Fuseau **du lieu** de l'événement, hérité du groupe par défaut (§4.1). |
| `arrival_note` | TEXT | NULL | « à partir de 20 h, on mange à 21 h » (C1). |
| `host_membership_id` | TEXT | NULL, FK composite → `memberships(id, group_id)` | Celui qui reçoit. |
| `currency_code` | TEXT | NULL → `currencies(code)` | Devise de l'événement si elle diffère de celle du groupe (voyage). `NULL` = celle du groupe. |
| `capacity` | INTEGER | NULL, `CHECK (capacity IS NULL OR capacity > 0)` | |
| `status` | TEXT | NOT NULL, `CHECK (status IN ('draft','published','cancelled'))` | Un brouillon n'apparaît ni dans l'iCal ni dans les notifications. |
| `source_date_poll_id` | TEXT | NULL, FK composite → `date_polls(id, group_id)` | Trace du sondage qui a produit l'événement (B5). |
| `recurrence_rule` | TEXT | NULL | **Inutilisé en V1**, réservé à B7 : une `RRULE` RFC 5545. §4.2. |
| `recurrence_parent_id` | TEXT | NULL, FK composite → `events(id, group_id)` | Inutilisé en V1 : l'occurrence détachée d'une série. §4.2. |
| `occurrence_date` | TEXT | NULL | Inutilisé en V1 : la date d'origine de l'occurrence détachée. §4.2. |
| `created_by_membership_id` | TEXT | NOT NULL, FK composite → `memberships(id, group_id)` | |
| `created_at`, `updated_at` | TEXT | NOT NULL | `updated_at` alimente le `SEQUENCE` iCal et l'`ETag` du flux. |
| `deleted_at` | TEXT | NULL | |

Index : `idx_events_group_start (group_id, starts_at)` — la requête de l'agenda ;
`idx_events_group_status (group_id, status, starts_at)`.

**`event_organizers`** — une ligne = un co-organisateur d'un événement. Table plutôt que
colonne : C1/C5 parlent d'organisateurs au pluriel (« clôturer les comptes » peut être fait à
plusieurs), et une colonne unique aurait imposé une migration dès le premier besoin.
Colonnes : `event_id` + `group_id` (FK composite → `events`), `membership_id` (FK composite →
`memberships`), `added_at`. **PK `(event_id, membership_id)`**, index `(group_id, membership_id)`.

> Le rôle **organisateur** est donc : `events.created_by_membership_id` ou une ligne dans
> `event_organizers`, ou `memberships.role = 'admin'`. Une seule fonction du code répond à
> « peut-il modifier cet événement ? ».

**`event_attendances`** — une ligne = la réponse d'un membre à un événement (B2).

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `event_id`, `group_id` | TEXT | NOT NULL, FK composite → `events(id, group_id)` | |
| `membership_id` | TEXT | NOT NULL, FK composite → `memberships(id, group_id)` | |
| `status` | TEXT | NOT NULL, `CHECK (status IN ('yes','maybe','no'))` | L'absence de ligne = « pas répondu », ce qui est une information différente de « pas là ». |
| `guests_count` | INTEGER | NOT NULL DEFAULT 0, `CHECK (guests_count BETWEEN 0 AND 20)` | « je viens avec deux personnes ». |
| `comment` | TEXT | NULL | « j'arrive vers 22 h ». |
| `responded_at`, `updated_at` | TEXT | NOT NULL | |

**PK `(event_id, membership_id)`** : l'unicité est structurelle, pas une règle de code. Index
`idx_attendances_membership (group_id, membership_id)` pour « mes prochaines sorties » et le flux iCal.

### 3.6 Agenda personnel et ses deux niveaux de visibilité (B4)

C'est **la seule exception** à la règle « chaque table métier porte son groupe », et elle est
assumée : un événement personnel appartient à une personne, pas à un groupe. Il serait faux de
le dupliquer par groupe. La cloison est reportée sur la table de partage, qui elle porte
`group_id`, et **aucune lecture ne va chercher `personal_events` autrement qu'en passant par
`personal_event_shares`** (sauf pour son propre agenda).

**`personal_events`** — une ligne = un créneau privé du propriétaire.

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `id` | TEXT | **PK** | |
| `user_id` | TEXT | NOT NULL → `users(id)` | Propriétaire, et seule autorité sur la ligne. |
| `title` | TEXT | NOT NULL | **Ne sort jamais** du serveur en visibilité `busy`. |
| `description`, `location_name` | TEXT | NULL | Idem. |
| `all_day` | INTEGER | NOT NULL DEFAULT 0, booléen | |
| `starts_at`, `ends_at` | TEXT | NOT NULL / NULL | Mêmes règles que `events`. |
| `time_zone` | TEXT | NOT NULL | |
| `recurrence_rule` | TEXT | NULL | Réservé B7, inutilisé en V1. |
| `created_at`, `updated_at`, `deleted_at` | TEXT | | |

Index : `idx_personal_events_user (user_id, starts_at)`.

**`personal_event_shares`** — une ligne = « ce créneau est visible du groupe X, à ce niveau ».

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `personal_event_id` | TEXT | NOT NULL → `personal_events(id)` ON DELETE CASCADE | Cascade acceptée : un partage n'a pas de valeur historique. |
| `membership_id` | TEXT | NOT NULL | L'appartenance de **l'auteur du partage** dans ce groupe. |
| `group_id` | TEXT | NOT NULL → `groups(id)` | **C'est cette colonne que la couche d'accès filtre** : `personal_event_shares` fait partie du `GroupScope`. |
| `visibility` | TEXT | NOT NULL, `CHECK (visibility IN ('busy','details'))` | `busy` : le serveur ne renvoie que l'intervalle et le libellé traduit « Occupé ». `details` : titre et lieu. |
| `created_at` | TEXT | NOT NULL | |

**PK `(personal_event_id, group_id)`**. **Clé étrangère composite `(membership_id, group_id)` →
`memberships(id, group_id)`** : on ne peut pas publier un créneau vers un groupe dont on n'est pas
membre, ni usurper l'appartenance d'un autre. Une appartenance qui prend fin (`left`, `removed`)
ne supprime pas la ligne (§4.4) : la projection « occupé » ne retient que les appartenances
`active`. Le fait que le créneau appartienne bien à l'auteur du partage n'est pas exprimable en
clé étrangère : la couche d'accès le vérifie à l'insertion (`personal_events.user_id` = auteur).
Index `idx_pes_group (group_id, visibility)`.

**Décision** : le niveau de visibilité vit sur le **partage**, pas sur l'événement. Motif :
quelqu'un accepte volontiers de montrer « Dîner chez les parents » à la bande et seulement
« Occupé » aux collègues. Un `default_personal_visibility` sur `memberships` (valeurs
`none` / `busy` / `details`) permet à l'interface de créer les lignes de partage
automatiquement à la création d'un créneau, pour que personne n'ait à cocher quatre cases.

> **Garde-fou côté serveur** : la projection « occupé » est faite **en SQL**, par une requête
> dédiée (`GroupScope.creneauxOccupes`) qui ne sélectionne jamais les colonnes de texte de
> `personal_events`. La garde du SQL brut n'admet une lecture de `personal_events` que par
> `user_id = ?` (son propre agenda, `PorteeUtilisateur`) ou par jointure avec les partages du groupe. On ne
> charge pas l'objet complet pour le masquer ensuite : une fuite d'affichage serait alors à
> un oubli de `delete obj.title` de distance.
>
> Cette table est aussi le socle de **B6** (détection des disponibilités, V2) : le calcul se
> fait sur les intervalles, sans jamais lire les titres. Aucune évolution de schéma ne sera
> nécessaire.

### 3.7 Sondages de dates (B5)

**`date_polls`** — une ligne = une question « quand est-ce qu'on fait ça ? ».

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `id` | TEXT | **PK**, **`UNIQUE (id, group_id)`** | |
| `group_id` | TEXT | NOT NULL → `groups(id)` | |
| `title` | TEXT | NOT NULL | |
| `description` | TEXT | NULL | |
| `status` | TEXT | NOT NULL, `CHECK (status IN ('open','closed','converted','cancelled'))` | `converted` = un événement en est sorti. |
| `closes_at` | TEXT | NULL | Clôture automatique facultative. |
| `resulting_event_id` | TEXT | NULL, FK composite → `events(id, group_id)` | L'autre bout du lien avec `events.source_date_poll_id`. |
| `created_by_membership_id` | TEXT | NOT NULL, FK composite → `memberships` | |
| `created_at`, `updated_at`, `deleted_at` | TEXT | | |

**`date_poll_options`** — une ligne = un créneau proposé.
`id` **PK** + **`UNIQUE (id, group_id)`**, `date_poll_id` + `group_id` FK composite,
`all_day` booléen, `starts_at` NOT NULL, `ends_at` NULL, `position` INTEGER NOT NULL
(ordre d'affichage stable), `created_at`. Unicité : `UNIQUE (date_poll_id, starts_at, ends_at)`
— on ne propose pas deux fois le même créneau.

**`date_poll_votes`** — une ligne = l'avis d'un membre sur **un** créneau.
`date_poll_option_id` + `group_id` FK composite, `membership_id` FK composite,
`value` `CHECK (value IN ('yes','maybe','no'))`, `created_at`, `updated_at`.
**PK `(date_poll_option_id, membership_id)`**. Index `idx_votes_membership (group_id, membership_id)`.

> Un vote par **option** et non par sondage : c'est ce qui permet « je peux jeudi et samedi,
> peut-être vendredi ». Le dépouillement est un `GROUP BY date_poll_option_id` avec une
> pondération `yes = 2, maybe = 1, no = 0`, départagé par le nombre de `yes` puis par
> `position`. Déterministe, donc testable.

### 3.8 Liste de courses (C2) et tâches (C7)

**`shopping_lists`** — une ligne = une liste, rattachée à un événement ou libre dans le groupe.
`id` **PK** + **`UNIQUE (id, group_id)`**, `group_id`, `event_id` **NULL** FK composite →
`events`, `title` NOT NULL, `created_by_membership_id`, `created_at`, `updated_at`,
`deleted_at`. Index `idx_lists_event (group_id, event_id)`.

> Une liste par événement est le cas courant, mais `event_id` est nullable pour la liste de la
> coloc qui ne dépend d'aucune soirée. Pas d'unicité sur `event_id` : « boissons » et
> « matériel » sont deux listes légitimes.

**`shopping_items`** — une ligne = un article à apporter, et qui s'en charge.

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `id` | TEXT | **PK**, **`UNIQUE (id, group_id)`** | |
| `shopping_list_id`, `group_id` | TEXT | NOT NULL, FK composite | |
| `label` | TEXT | NOT NULL | « Chips », « 3 bouteilles de rouge ». |
| `quantity` | TEXT | NULL | **Texte libre** et non un nombre : « 2 kg », « de quoi pour 8 ». Le regroupement par rayon et les quantités cumulées (C4) sont en V2 et introduiront alors `quantity_value` + `unit` à côté, sans casser l'existant. |
| `category` | TEXT | NULL | Réservé C4 (rayon), inutilisé en V1. |
| `claimed_by_membership_id` | TEXT | NULL, FK composite → `memberships` | **Qui le prend.** `NULL` = personne. |
| `claimed_at` | TEXT | NULL | `CHECK` de cohérence avec la colonne ci-dessus. |
| `is_done` | INTEGER | NOT NULL DEFAULT 0, booléen | Acheté / apporté. |
| `done_at` | TEXT | NULL | |
| `position` | INTEGER | NOT NULL | Ordre dans la liste, réordonnable. |
| `created_by_membership_id` | TEXT | NOT NULL, FK composite | |
| `created_at`, `updated_at`, `deleted_at` | TEXT | | |

Index : `idx_items_list (group_id, shopping_list_id, position)`.

> **Un article, un preneur.** « À deux sur les courses » se modélise par deux articles. C'est
> le compromis qui garde la case à cocher lisible sur un téléphone, et il évite une table
> d'association de plus. Le temps réel (C2) est un problème de transport, pas de schéma :
> `updated_at` suffit à un rafraîchissement par événements serveur.

**`event_tasks`** — une ligne = ce qui ne s'achète pas (réserver, apporter l'enceinte).
`id` **PK** + **`UNIQUE (id, group_id)`**, `group_id`, `event_id` **NULL** FK composite
(une tâche peut être libre), `title` NOT NULL, `details` NULL,
`assignee_membership_id` NULL FK composite, `due_at` NULL,
`status` `CHECK (status IN ('todo','doing','done','dropped'))`, `done_at` NULL,
`position`, `created_by_membership_id`, `created_at`, `updated_at`, `deleted_at`.
Index `idx_tasks_event (group_id, event_id, status)`, `idx_tasks_assignee (group_id, assignee_membership_id, status)`.

### 3.9 Fils de discussion et messages

**`threads`** — une ligne = un fil : celui d'un événement, ou un fil libre du groupe.

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `id` | TEXT | **PK**, **`UNIQUE (id, group_id)`** | |
| `group_id` | TEXT | NOT NULL → `groups(id)` | |
| `event_id` | TEXT | NULL, FK composite → `events(id, group_id)` | Non nul = fil de l'événement, créé avec lui. |
| `title` | TEXT | NULL | `NULL` autorisé pour un fil d'événement : il prend le titre de l'événement. |
| `kind` | TEXT | NOT NULL, `CHECK (kind IN ('event','free'))` | `CHECK` croisé : `kind = 'event'` ⇔ `event_id` non nul. |
| `is_locked` | INTEGER | NOT NULL DEFAULT 0, booléen | |
| `last_message_at` | TEXT | NULL | **Dénormalisation assumée** : sans elle, la liste des fils fait un sous-select par ligne. Mise à jour dans la même transaction que l'insertion du message. |
| `created_by_membership_id` | TEXT | NOT NULL, FK composite | |
| `created_at`, `updated_at`, `deleted_at` | TEXT | | |

Unicité : index unique partiel `UNIQUE (event_id) WHERE kind = 'event' AND deleted_at IS NULL`
— **un seul** fil par événement. Index `idx_threads_group (group_id, last_message_at DESC)`.

**`messages`** — une ligne = un message dans un fil.
`id` **PK** + **`UNIQUE (id, group_id)`**, `thread_id` + `group_id` FK composite,
`author_membership_id` NOT NULL FK composite, `body` TEXT NOT NULL
`CHECK (length(body) BETWEEN 1 AND 8000)`, `reply_to_message_id` NULL FK composite → `messages`,
`created_at`, `edited_at` NULL, `deleted_at` NULL.
Index : `idx_messages_thread (group_id, thread_id, created_at)`.

> **Suppression d'un message** : marquage, et le corps est **écrasé** par une chaîne vide au
> même moment. On garde la ligne (les réponses y pointent, la chronologie reste cohérente) sans
> garder le texte. C'est le seul endroit où le marquage est accompagné d'un effacement de
> contenu — ailleurs, l'historique a de la valeur.
>
> Les réactions et commentaires (A4, D6) sont en V2 et prendront une table `reactions`
> polymorphe `(group_id, target_type, target_id, membership_id, emoji)`. Rien à changer ici.

### 3.10 Dépenses, parts, soldes et clôture (C5)

Rappel de l'[`ADR-0004`](../docs/decisions/ADR-0004-depenses-devises.md) : entiers d'unités
mineures, devise portée par le montant, taux figé, **aucun flux bancaire**.

**`expenses`** — une ligne = une dépense réellement avancée par quelqu'un.

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `id` | TEXT | **PK**, **`UNIQUE (id, group_id)`** | |
| `group_id` | TEXT | NOT NULL → `groups(id)` | |
| `event_id` | TEXT | NULL, FK composite → `events(id, group_id)` | Nullable : « les courses de la coloc » n'est pas une soirée. La clôture (§ ci-dessous) ne concerne que les dépenses d'un événement. |
| `label` | TEXT | NOT NULL | |
| `spent_on` | TEXT | NOT NULL | Date `AAAA-MM-JJ`. Une dépense n'a pas d'heure, et pas de fuseau : on ne veut pas qu'un achat du 31 décembre devienne du 1er janvier (§4.1). |
| `payer_membership_id` | TEXT | NOT NULL, FK composite → `memberships` | **Qui a avancé l'argent.** Une seule personne par dépense ; deux payeurs = deux dépenses. |
| `amount_minor` | INTEGER | NOT NULL, `CHECK (amount_minor > 0)` | Montant total **en unités mineures de `currency_code`**. |
| `currency_code` | TEXT | NOT NULL → `currencies(code)` | Devise réelle du paiement. |
| `target_currency_code` | TEXT | NOT NULL → `currencies(code)` | Devise de calcul des soldes **au moment de la saisie** : celle de l'événement, sinon celle du groupe. Copiée, pas déduite : si le groupe change de devise par défaut, les dépenses passées ne bougent pas. |
| `rate_ppm` | INTEGER | NOT NULL, `CHECK (rate_ppm > 0)` | **Taux figé**, exprimé en millionièmes : 1 unité *majeure* de `currency_code` = `rate_ppm / 1 000 000` unité majeure de `target_currency_code`. Vaut exactement `1 000 000` quand les deux devises sont identiques (`CHECK` croisé). |
| `rate_source` | TEXT | NOT NULL, `CHECK (rate_source IN ('identity','manual','provider'))` | D'où vient le taux. `provider` reste possible sans être implémenté en V1 : la saisie manuelle suffit, et aucune dépendance réseau n'entre dans le chemin d'écriture. |
| `rate_fetched_at` | TEXT | NULL | |
| `amount_target_minor` | INTEGER | NOT NULL, `CHECK (amount_target_minor > 0)` | **Montant converti, calculé et stocké une fois.** Redondant avec les trois colonnes au-dessus, et c'est voulu : c'est lui qui garantit qu'un solde passé est immuable, même si la table `currencies` ou l'arithmétique du code évolue. |
| `split_mode` | TEXT | NOT NULL, `CHECK (split_mode IN ('equal','weights','exact'))` | Comment les parts ont été produites (§4.4). Conservé pour pouvoir **rejouer** la répartition quand on ajoute un participant. |
| `note` | TEXT | NULL | |
| `receipt_path` | TEXT | NULL | Photo du ticket dans le volume de données. Pas d'Immich ici : un ticket n'est pas un souvenir. |
| `created_by_membership_id` | TEXT | NOT NULL, FK composite | Peut différer du payeur (« j'enregistre pour Marc »). |
| `created_at`, `updated_at` | TEXT | NOT NULL | |
| `deleted_at` | TEXT | NULL | |

Index : `idx_expenses_group_date (group_id, spent_on DESC)`,
`idx_expenses_event (group_id, event_id)`, `idx_expenses_payer (group_id, payer_membership_id)`.

> **Aucune colonne bancaire, et cela se vérifie** : un test de schéma liste les colonnes de
> toutes les tables et échoue si l'une d'elles ressemble à `%iban%`, `%bic%`, `%card%`,
> `%account_number%`, `%payment%`. C'est un garde-fou contre la dérive, pas contre l'erreur
> d'aujourd'hui (§Architecture, tests).

**`expense_shares`** — une ligne = la part d'un membre dans une dépense.

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `expense_id`, `group_id` | TEXT | NOT NULL, FK composite → `expenses(id, group_id)` | |
| `membership_id` | TEXT | NOT NULL, FK composite → `memberships(id, group_id)` | Un **ancien** membre garde ses parts : la FK ne filtre pas le statut. |
| `weight` | INTEGER | NOT NULL DEFAULT 1, `CHECK (weight >= 0)` | Poids de la part en mode `equal`/`weights` (1 pour tous, 2 pour le couple). Ignoré en mode `exact`. |
| `share_minor` | INTEGER | NOT NULL, `CHECK (share_minor >= 0)` | Part **dans la devise de la dépense**. La somme des `share_minor` d'une dépense vaut exactement `expenses.amount_minor`. |
| `share_target_minor` | INTEGER | NOT NULL, `CHECK (share_target_minor >= 0)` | Part **dans la devise de calcul**. La somme vaut exactement `expenses.amount_target_minor`. C'est ce qui fait qu'un solde se boucle à zéro malgré les arrondis de conversion (§4.4). |
| `created_at`, `updated_at` | TEXT | NOT NULL | |

**PK `(expense_id, membership_id)`**. Index `idx_shares_membership (group_id, membership_id)`
— c'est l'index du calcul des soldes.

> Les deux invariants de somme **ne sont pas exprimables** en `CHECK` (SQLite ne fait pas
> d'agrégat dans une contrainte). Ils sont donc : (a) garantis par une fonction unique qui
> écrit dépense et parts **dans la même transaction**, (b) vérifiés par une requête de
> cohérence lancée par la suite de tests et par une commande d'exploitation
> `npm run verifier:soldes`. Les parts ne sont jamais écrites une par une depuis une route.

**`settlements`** — une ligne = un remboursement **déclaré**, effectué **hors de
l'application**. C'est une pièce comptable, pas un ordre de paiement.

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `id` | TEXT | **PK**, **`UNIQUE (id, group_id)`** | |
| `group_id` | TEXT | NOT NULL → `groups(id)` | |
| `event_id` | TEXT | NULL, FK composite → `events` | Permet de solder un événement précis, ou l'ardoise générale. |
| `from_membership_id`, `to_membership_id` | TEXT | NOT NULL, FK composites, `CHECK (from <> to)` | Qui a rendu à qui. |
| `amount_minor`, `currency_code` | INTEGER / TEXT | NOT NULL, `CHECK (amount_minor > 0)` | |
| `target_currency_code`, `rate_ppm`, `amount_target_minor` | | NOT NULL | Mêmes règles et mêmes `CHECK` que `expenses`. Un remboursement en liquide dans une autre devise est le cas réel en voyage. |
| `settled_on` | TEXT | NOT NULL | Date déclarée. |
| `method_note` | TEXT | NULL | « virement », « liquide », « il m'a payé le resto ». **Texte libre, jamais structuré** : pas d'IBAN, pas de référence de transaction. |
| `recorded_by_membership_id` | TEXT | NOT NULL, FK composite | |
| `confirmed_by_membership_id` | TEXT | NULL, FK composite | Le bénéficiaire peut confirmer. Sans confirmation, l'affichage marque « déclaré, non confirmé ». |
| `created_at`, `updated_at`, `deleted_at` | TEXT | | |

Index : `idx_settlements_group (group_id, settled_on DESC)`,
`idx_settlements_pair (group_id, from_membership_id, to_membership_id)`.

**`expense_closures`** — une ligne = la clôture des comptes d'un événement : un arrêté figé.

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `id` | TEXT | **PK** | |
| `group_id` | TEXT | NOT NULL → `groups(id)` | |
| `event_id` | TEXT | NOT NULL, FK composite → `events(id, group_id)` | |
| `currency_code` | TEXT | NOT NULL → `currencies(code)` | Devise de l'arrêté. |
| `snapshot_json` | TEXT | NOT NULL | **Le résultat du calcul au moment de la clôture** : soldes par appartenance, et la liste minimale de virements proposés. Du JSON validé à l'écriture et à la lecture par un schéma. |
| `total_minor` | INTEGER | NOT NULL | Total dépensé, pour l'affichage de la liste sans désérialiser le JSON. |
| `closed_by_membership_id` | TEXT | NOT NULL, FK composite | |
| `closed_at` | TEXT | NOT NULL | |
| `reopened_at`, `reopened_by_membership_id` | | NULL | Une réouverture **n'efface pas** la ligne : elle la marque et on en crée une nouvelle à la clôture suivante. |

Unicité : index unique partiel `UNIQUE (event_id) WHERE reopened_at IS NULL` — un seul arrêté
en vigueur par événement.

> **Pas de table de soldes.** Les soldes sont **calculés** à la demande
> (`SUM(payé) - SUM(parts) + SUM(remboursements)` par appartenance, sur
> `amount_target_minor`), jamais stockés. Motif : un solde stocké dérive dès qu'une écriture
> échoue à mi-chemin, et il faudrait le recalculer après chaque modification de dépense. À
> l'échelle visée — quelques milliers de lignes par groupe — le calcul est instantané avec
> l'index `idx_shares_membership`. Le seul solde figé est celui du `snapshot_json` d'une
> clôture, et c'est précisément son rôle.
>
> **Conséquence sur les devises** : le calcul de solde additionne des `amount_target_minor`.
> Il n'est donc licite que si **toutes** les lignes considérées partagent la même
> `target_currency_code`. La requête de solde **groupe par `target_currency_code`** et l'API
> renvoie une liste de soldes, un par devise de calcul. Si un événement a mélangé deux devises
> de calcul (cas possible seulement si quelqu'un a changé la devise de l'événement en cours de
> route), l'interface affiche deux ardoises au lieu d'en inventer une seule. **Additionner
> deux devises reste une erreur**, y compris au niveau de la requête.

### 3.11 Photos : configuration Immich par groupe et albums (D1, D11)

**`group_immich_configs`** — une ligne = le raccordement d'un groupe à une instance Immich.
Zéro ou une ligne par groupe ; sans ligne, **l'onglet photos est absent** et le reste de
l'application fonctionne ([`ADR-0003`](../docs/decisions/ADR-0003-photos-immich.md)).

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `group_id` | TEXT | **PK** → `groups(id)` | La clé primaire *est* le groupe : un groupe, une instance. |
| `base_url` | TEXT | NOT NULL | `https://photos.exemple.net`. Validée à l'enregistrement : schéma `https` (ou `http` sur IP privée), pas de redirection suivie. |
| `api_key_cipher` | BLOB | NOT NULL | Clé d'API **chiffrée** en AES-256-GCM avec la clé d'instance (`ATTROUPE_ENCRYPTION_KEY`). |
| `api_key_nonce` | BLOB | NOT NULL | |
| `api_key_fingerprint` | TEXT | NOT NULL | 8 premiers caractères du SHA-256 de la clé, pour afficher « clé …3f9a » sans la déchiffrer. |
| `immich_user_id` | TEXT | NULL | Compte Immich auquel la clé appartient, renvoyé par le test de connexion. |
| `status` | TEXT | NOT NULL, `CHECK (status IN ('ok','unreachable','unauthorized','untested'))` | Dernier état connu. |
| `last_checked_at`, `last_error` | | NULL | `last_error` est un **code** traduit côté client, pas un message brut d'Immich. |
| `configured_by_membership_id` | TEXT | NOT NULL, FK composite | Un administrateur du groupe, nécessairement. |
| `created_at`, `updated_at` | TEXT | NOT NULL | |

**`albums`** — une ligne = un album du groupe, miroir local d'un album Immich.

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `id` | TEXT | **PK**, **`UNIQUE (id, group_id)`** | Identifiant **à nous** : c'est lui qui circule dans nos URL, jamais celui d'Immich. |
| `group_id` | TEXT | NOT NULL → `groups(id)` | |
| `event_id` | TEXT | NULL, FK composite → `events(id, group_id)` | Album d'événement (créé avec lui) ou album libre. |
| `title` | TEXT | NOT NULL | |
| `immich_album_id` | TEXT | NOT NULL | Identifiant côté Immich. |
| `cover_immich_asset_id` | TEXT | NULL | |
| `asset_count` | INTEGER | NOT NULL DEFAULT 0 | Compteur rafraîchi à la synchronisation, pour afficher la liste sans appeler Immich. |
| `last_synced_at` | TEXT | NULL | |
| `sync_status` | TEXT | NOT NULL, `CHECK (sync_status IN ('ok','pending','error','orphan'))` | `orphan` : l'album a disparu côté Immich. On le signale, on ne le supprime pas. |
| `created_by_membership_id` | TEXT | NOT NULL, FK composite | |
| `created_at`, `updated_at`, `deleted_at` | TEXT | | |

Unicité : `UNIQUE (group_id, immich_album_id)` — **la contrainte de cloisonnement des photos** :
le même album Immich ne peut pas être rattaché deux fois dans le même groupe, et
`UNIQUE (immich_album_id)` serait trop fort (deux groupes peuvent viser deux instances
différentes où l'identifiant se répète). Index unique partiel
`UNIQUE (event_id) WHERE event_id IS NOT NULL AND deleted_at IS NULL`.

**`album_assets`** — une ligne = une photo ou une vidéo connue de nous dans un album. **Cache,
pas source de vérité** : Immich reste maître.

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `album_id`, `group_id` | TEXT | NOT NULL, FK composite → `albums(id, group_id)` | |
| `immich_asset_id` | TEXT | NOT NULL | |
| `kind` | TEXT | NOT NULL, `CHECK (kind IN ('image','video'))` | Les vidéos entrent dans le périmètre sans travail de notre côté (`ADR-0003`). |
| `taken_at` | TEXT | NULL | Date EXIF, renvoyée par Immich. Préparera D3 (rangement automatique) en V2. |
| `width`, `height`, `duration_ms` | INTEGER | NULL | Pour réserver la place dans la grille et éviter le saut de mise en page. |
| `uploaded_by_membership_id` | TEXT | NULL, FK composite | `NULL` si la photo a été ajoutée directement dans Immich, hors de chez nous. |
| `created_at`, `updated_at`, `removed_at` | TEXT | | `removed_at` : disparue côté Immich. |

**PK `(album_id, immich_asset_id)`**. Index `idx_assets_album (group_id, album_id, taken_at DESC)`.

> **Le cloisonnement des photos tient à une règle unique** : aucune route ne reçoit jamais un
> `immich_asset_id`. Elle reçoit `(:groupId, :albumId, :assetId)`, et le serveur ne résout
> l'identifiant Immich qu'après avoir vérifié que la ligne `album_assets` existe **dans ce
> groupe**. Un identifiant Immich forgé ne mène donc nulle part.

### 3.12 Flux iCal, notifications, e-mails

**`calendar_feed_tokens`** — une ligne = une URL d'abonnement privée (B3).

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `id` | TEXT | **PK** | |
| `user_id` | TEXT | NOT NULL → `users(id)` | Le jeton appartient à la personne. |
| `group_id` | TEXT | NULL → `groups(id)` | `NULL` = flux agrégé de tous ses groupes. Non nul = flux d'un seul groupe (celui qui veut un calendrier « la coloc » distinct). |
| `token_hash` | TEXT | NOT NULL, **UNIQUE** | SHA-256 du jeton de 32 octets. Le jeton en clair **n'est affiché qu'une fois**, à la création. |
| `label` | TEXT | NULL | « iPhone de Théo ». |
| `include_personal` | INTEGER | NOT NULL DEFAULT 0, booléen | Inclure ses propres créneaux personnels. |
| `include_declined` | INTEGER | NOT NULL DEFAULT 1, booléen | Inclure les événements auxquels il a répondu « pas là ». |
| `created_at` | TEXT | NOT NULL | |
| `last_used_at`, `last_user_agent` | | NULL | Permet de dire « ce flux n'a jamais été consulté ». |
| `revoked_at` | TEXT | NULL | Révocation sans suppression : on garde la trace. |

Index : `idx_feeds_user (user_id, revoked_at)`.

> **Création d'un jeton** : la `PorteeUtilisateur` n'accepte un `group_id` non nul que si le compte
> est **membre actif** de ce groupe (la clé étrangère seule ne l'impose pas), et ne le laisse plus
> modifier ensuite. **Le lot 5 devra revérifier l'appartenance active à chaque service du flux** : un
> jeton créé avant un départ ne doit pas continuer à servir. Même contrôle sur
> `notification_preferences.group_id` (`'*'` ou groupe dont on est membre actif).
>
> `group_id` est **nullable** ici, et c'est une entorse apparente à la règle 1. Elle est sûre
> parce que la résolution du contenu du flux ne lit jamais « les événements du groupe X » mais
> « les événements des groupes où `memberships.status = 'active'` pour ce `user_id` » : le
> cloisonnement est porté par la jointure sur `memberships`, qui est la même que partout
> ailleurs.

**`notifications`** — une ligne = une chose à signaler à une personne.

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `id` | TEXT | **PK** | |
| `user_id` | TEXT | NOT NULL → `users(id)` | Le destinataire est un **compte** : il faut pouvoir notifier une invitation avant qu'il soit membre. |
| `group_id` | TEXT | NULL → `groups(id)` | Non nul dès que la notification parle d'un groupe — et l'`ADR-0002` l'exige : **le libellé dit toujours de quel groupe il s'agit**. |
| `kind` | TEXT | NOT NULL, `CHECK (kind IN (...))` | `invitation_received`, `event_created`, `event_updated`, `event_cancelled`, `poll_opened`, `poll_closing`, `item_claimed`, `task_assigned`, `message_posted`, `expense_added`, `accounts_closed`, `member_joined`. |
| `subject_type`, `subject_id` | TEXT | NULL | Référence **non contrainte** vers l'objet concerné (`event`, `thread`, `expense`…). Pas de FK : une notification doit survivre à la suppression de son sujet, et une FK polymorphe n'existe pas en SQL. La route de redirection vérifie l'existence et le groupe avant de rediriger. |
| `payload_json` | TEXT | NOT NULL | Les **données** de la notification (titre de l'événement, nom de l'auteur), jamais un texte rédigé : le rendu se fait avec le fichier de traduction, à l'affichage. |
| `created_at` | TEXT | NOT NULL | |
| `read_at` | TEXT | NULL | |
| `email_queued_at`, `email_sent_at` | | NULL | |

Index : `idx_notifications_user (user_id, read_at, created_at DESC)`.

**`notification_preferences`** — une ligne = ce qu'une personne veut recevoir, pour un groupe.
`user_id` + `group_id` (**PK composite**, `group_id` pouvant valoir la chaîne `'*'` pour le
réglage global — préférable à `NULL` dans une clé primaire), `channel_email` booléen,
`digest` `CHECK (digest IN ('instant','daily','off'))`, `muted_kinds` TEXT (liste JSON de
`kind`), `created_at`, `updated_at`.

**`email_outbox`** — une ligne = un e-mail à remettre à Brevo. File d'attente persistée, pour
qu'une panne de Brevo ou un redémarrage ne perde pas une invitation.

| Colonne | Type | Contraintes | Rôle |
|---|---|---|---|
| `id` | TEXT | **PK** | |
| `to_email` | TEXT | NOT NULL | |
| `template_key` | TEXT | NOT NULL | `invitation`, `reinitialisation_mot_de_passe`, `resume_quotidien`… |
| `payload_json` | TEXT | NOT NULL | Variables du gabarit. |
| `locale` | TEXT | NOT NULL DEFAULT `'fr'` | |
| `group_id` | TEXT | NULL → `groups(id)` | Pour le diagnostic et les quotas par groupe. |
| `status` | TEXT | NOT NULL, `CHECK (status IN ('pending','sent','failed','abandoned'))` | |
| `attempts` | INTEGER | NOT NULL DEFAULT 0 | |
| `next_attempt_at` | TEXT | NOT NULL | Report exponentiel. |
| `provider_message_id`, `last_error` | | NULL | |
| `created_at`, `sent_at` | | | |

Index : `idx_outbox_pending (status, next_attempt_at)`.

## 4. Les points délicats, tranchés

### 4.1 Le cloisonnement rendu structurel : la clé étrangère composite

**Décision.** Toute table métier porte `group_id NOT NULL`, et toute référence vers un parent
métier est une clé étrangère **composite sur `(id, group_id)`**, le parent déclarant
`UNIQUE (id, group_id)` pour la rendre possible.

```sql
-- shopping_items
FOREIGN KEY (shopping_list_id, group_id) REFERENCES shopping_lists (id, group_id)
```

Ce que ça achète : si une route oublie un filtre et tente d'insérer un article du groupe A dans
une liste du groupe B, **SQLite refuse l'écriture**. Le cloisonnement en écriture n'est plus une
affaire de rigueur, c'est une contrainte d'intégrité. En lecture, le filtre reste nécessaire —
c'est le rôle du dispositif décrit dans `04 - Architecture.md` §3.

Le coût est réel et accepté : une colonne `group_id` dénormalisée sur chaque table enfant (une
liste connaît déjà son groupe par son événement), et un index de plus. C'est le prix de la
règle numéro un du projet.

### 4.2 Dates, heures et fuseaux

**Décision, en trois cas distincts :**

| Cas | Stockage | Pourquoi |
|---|---|---|
| **Événement à l'heure** | `starts_at` = instant **UTC** `…Z`, plus `time_zone` = fuseau IANA **du lieu** | L'instant est non ambigu pour trier, comparer et détecter les chevauchements ; le fuseau sert à *afficher* « 20 h » et à produire un `DTSTART;TZID=` correct dans l'iCal. Les deux sont nécessaires : UTC seul perd l'heure locale voulue si la zone change de règles d'heure d'été, le local seul rend tout tri impossible. |
| **Journée entière** | `starts_at` = `AAAA-MM-JJ`, **flottant** (aucun fuseau appliqué) | Un anniversaire ou un week-end ne commence pas à un instant : il commence « le 14 ». Les traiter comme minuit UTC les décale d'un jour pour la moitié de la planète. L'iCal correspondant est un `DTSTART;VALUE=DATE`. |
| **Date de dépense** | `spent_on` = `AAAA-MM-JJ`, flottant | Un achat appartient à un jour, pas à un instant. Évite qu'une dépense du 31 décembre à 23 h à Bangkok devienne du 30 à Paris. |

**Fuseau du groupe et de l'utilisateur.** `groups.time_zone` donne la valeur par défaut d'un
nouvel événement ; `users.time_zone` ne sert qu'à l'affichage de l'agenda personnel. Quand le
groupe part à Tokyo, l'événement créé là-bas porte `Asia/Tokyo` et s'affiche « 19 h » pour
tout le monde — avec, dans l'interface, la mention du fuseau dès qu'il diffère de celui du
lecteur. C'est la seule manière de ne pas se tromper d'heure de rendez-vous.

**Implications techniques** : aucune colonne `DATETIME` (ça n'existe pas en SQLite `STRICT`),
comparaison lexicographique valide puisque le format est fixe et à longueur constante, et un
`CHECK` sur la longueur selon `all_day` pour qu'on ne mélange pas les deux formats dans la même
colonne. Le serveur ne fait **aucun** calcul de fuseau à la main : il utilise
`Intl.DateTimeFormat` et `Temporal` de la plateforme (Node 24), avec la base `tzdata` du
conteneur, qu'il faut donc installer dans l'image.

### 4.3 Récurrence (B7, V2) : ce qu'il ne faut pas s'interdire

**Décision** : trois colonnes nullables sont posées dès la V1 dans `events` et une dans
`personal_events` (`recurrence_rule`, `recurrence_parent_id`, `occurrence_date`), **inutilisées,
documentées comme telles**, et le modèle retenu pour V2 est **« règle + occurrences détachées »** :

- un événement « maître » porte une `RRULE` RFC 5545 (`FREQ=WEEKLY;BYDAY=TU`) ;
- les occurrences ne sont **pas** matérialisées en base : elles sont dépliées à la lecture,
  sur la fenêtre demandée (un mois d'agenda, un an d'iCal) ;
- dès qu'une occurrence est modifiée, annulée, ou qu'elle reçoit des présences, une liste de
  courses ou des dépenses, elle est **matérialisée** en ligne réelle avec
  `recurrence_parent_id` = le maître et `occurrence_date` = sa date d'origine. Le dépliage
  saute les dates déjà matérialisées.

Pourquoi ce modèle : il évite de créer 520 lignes pour « le foot du mardi », tout en permettant
qu'une occupation particulière ait sa propre liste de courses et ses propres dépenses — ce que
le modèle « tout déplier » rend coûteux et que le modèle « rien matérialiser » rend impossible
(une FK ne peut pas pointer sur une occurrence virtuelle).

**Ce que la V1 doit respecter pour ne pas fermer la porte** : aucune contrainte d'unicité sur
`(group_id, starts_at)` ou `(group_id, title)` ; toute table enfant pointe sur `events.id` et
jamais sur un couple `(série, date)` ; aucune requête d'agenda ne suppose « une ligne = une
occurrence » — elle passe par une fonction `listerOccurrences(fenêtre)` qui, en V1, se contente
de renvoyer les lignes telles quelles. Index unique à ajouter en V2 :
`UNIQUE (recurrence_parent_id, occurrence_date)`.

### 4.4 Suppression : marquage ou effacement

**Décision** : marquage par défaut, effacement réel pour ce qui n'est pas de l'historique.

| Objet | Politique | Motif |
|---|---|---|
| `events`, `threads`, `messages`, `expenses`, `settlements`, `shopping_lists`, `shopping_items`, `event_tasks`, `albums`, `date_polls` | `deleted_at` | Historique, et références croisées (une notification, une clôture, une réponse y pointent). |
| `messages` | `deleted_at` **+ corps écrasé** | On garde la place dans le fil, pas le texte. |
| `memberships` | **jamais supprimée** : `status` + `ended_at` | Règle 6. Tout l'historique du groupe pend à cette ligne. |
| `expense_shares`, `event_attendances`, `date_poll_votes`, `album_assets`, `personal_event_shares` | effacement réel | Lignes d'association, remplacées en bloc dans une transaction ; les conserver n'apporterait qu'une complexité de requête. |
| `sessions`, `password_reset_tokens`, `email_outbox` (envoyés), `notifications` (lues, > 90 j) | effacement réel, par une purge périodique | Données d'exploitation, aucune valeur passée. |
| `calendar_feed_tokens`, `invitations` | marquage (`revoked_at` / `status`) | Il faut pouvoir répondre « ce lien a été révoqué » plutôt que « inconnu ». |
| `groups` | `deleted_at`, puis **purge physique différée de 30 jours** par une tâche d'exploitation | Protège d'une suppression de groupe par erreur ou par malveillance d'un administrateur, et permet d'honorer un vrai effacement. |
| `users` | `anonymized_at` + écrasement des colonnes personnelles | Un compte supprimé ne doit pas faire disparaître les dépenses des autres. Son nom devient une clé de traduction (« Membre retiré »). |

**Conséquence sur le code, non négociable** : `deleted_at IS NULL` est ajouté par la couche
d'accès, au même endroit et en même temps que `group_id = ?`. Les deux filtres oubliés sont le
même bug — l'un fuit entre groupes, l'autre ressuscite des données.

### 4.5 Répartition des dépenses et attribution du reliquat

**Décision** : *plus grands restes* (méthode de Hamilton), avec un ordre de départage
**déterministe et auditable**.

Toute l'arithmétique est en entiers (`BigInt` côté serveur), en trois étapes :

**1. Conversion du total, une fois.** Avec `e_s` et `e_c` les exposants des devises source et
cible, `d = e_c − e_s` :

```
numérateur   = amount_minor × rate_ppm × 10^max(0, d)
dénominateur = 1 000 000 × 10^max(0, −d)
amount_target_minor = (numérateur + dénominateur / 2) / dénominateur   (division entière)
```

Arrondi au plus proche, moitié vers le haut. **Les parts ne sont jamais converties
individuellement** : on convertit le total, puis on répartit le total converti. C'est ce qui
garantit que `SUM(share_target_minor) = amount_target_minor` **exactement**, sans correctif.

**2. Répartition.** Pour un total `T`, des poids `w_i` et `W = Σw_i` :

```
base_i  = (T × w_i) / W          (division entière)
reste_i = (T × w_i) mod W
R = T − Σ base_i                  (le reliquat, 0 ≤ R < nombre de parts)
```

**3. Attribution du reliquat.** Les parts sont triées par `reste_i` **décroissant**, puis en
cas d'égalité par `membership_id` **croissant** (ordre lexicographique de l'UUID v7 : l'ordre
d'arrivée dans le groupe, stable et explicable). Les `R` premières reçoivent **une** unité
mineure de plus.

Exemple : 10,00 € entre trois personnes → `333, 333, 333` et `R = 1` ; les trois restes sont
égaux (`1`), donc le centime va à l'appartenance de plus petit identifiant. On obtient
`3,34 / 3,33 / 3,33`, toujours la même, quel que soit l'ordre d'affichage ou le fuseau du
serveur.

**Les trois modes** :
- `equal` : tous les participants ont `weight = 1` ;
- `weights` : poids entiers saisis (le couple compte double) ;
- `exact` : les `share_minor` sont saisis à la main. Le contrôle devient `Σ share_minor = amount_minor` ; si la saisie ne boucle pas, **la requête est refusée** (erreur 422), on ne « rattrape » pas silencieusement.

Dans les trois cas, `share_target_minor` est produit à l'étape 2 appliquée à
`amount_target_minor` avec les mêmes poids — ou, en mode `exact`, avec les `share_minor` comme
poids, ce qui conserve les proportions exactes au centime près.

**Tests associés, obligatoires** (`ADR-0004`) : pour une suite aléatoire de dépenses, de modes
et de devises, (a) la somme des parts égale le total, (b) la somme des soldes du groupe est
**exactement zéro**, (c) le même jeu de données donne la même répartition à chaque exécution,
(d) un cas en JPY et un cas où le reliquat est maximal (n−1 unités).

### 4.6 Devises sans sous-unité

**Décision** : `currencies.exponent` est l'unique source de vérité, et vaut `0` pour le yen.
Rien dans le code ne suppose « 2 décimales » ni « diviser par 100 ».

- **Stockage** : 1 000 ¥ se stocke `amount_minor = 1000`, `currency_code = 'JPY'`,
  `exponent = 0`. Il n'y a pas d'unité mineure, l'unité mineure *est* le yen.
- **Saisie** : le champ interdit la virgule quand `exponent = 0`, et la saisie « 1000,50 » est
  refusée, pas tronquée.
- **Affichage** : `Intl.NumberFormat('fr-FR', { style: 'currency', currency: code })` fait le
  travail et connaît déjà les exposants ; on ne formate jamais à la main.
- **Conversion** : le `10^d` de §4.5 traite le changement d'exposant (EUR→JPY : `d = −2`).
- **Piège signalé** : trois devises de la liste de l'`ADR-0004` ont un exposant inhabituel chez
  d'autres émetteurs (dinars à 3 décimales), aucune n'est dans notre liste aujourd'hui ; la
  colonne `exponent` autorise jusqu'à 4, donc l'ajout est une insertion.
- **Rappel de l'`ADR-0004`** : la monnaie chinoise est le **yuan** (`CNY`, exposant 2), le yen
  (`JPY`, exposant 0) est japonais.

## 5. Migration initiale

Contenu de `app/migrations/0001_socle.sql` (lot 1, **corrigé après revue avant tout déploiement** : le fichier n'a
jamais été joué ailleurs que sur des bases de test, d'où la possibilité de modifier des contraintes). Elle est idempotente par construction (`IF NOT EXISTS`
partout) comme l'exige l'[`ADR-0005`](../docs/decisions/ADR-0005-deploiement.md), et jouée au
démarrage du conteneur.

Les `PRAGMA` de connexion (`foreign_keys`, `journal_mode`, `busy_timeout`, `synchronous`) sont
posés par la couche d'accès **à chaque ouverture de connexion** et non par le fichier de
migration : `journal_mode = WAL` est persistant mais `foreign_keys` ne l'est pas, et un oubli
côté connexion désactiverait silencieusement toutes les clés étrangères composites du §4.1.

```sql
-- 0001_socle.sql — schéma initial de Attroupe (V1)
-- Posé par la couche d'accès à chaque connexion :
--   PRAGMA journal_mode = WAL;        -- persistant, mais réaffirmé
--   PRAGMA foreign_keys = ON;         -- NON persistant : obligatoire à chaque ouverture
--   PRAGMA busy_timeout = 5000;
--   PRAGMA synchronous = NORMAL;      -- suffisant avec WAL
--   PRAGMA foreign_keys;              -- vérifié : le démarrage échoue si la valeur n'est pas 1

-- ============================================================
-- 1. Référence
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT NOT NULL PRIMARY KEY,
  applied_at  TEXT NOT NULL,
  checksum    TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS currencies (
  code        TEXT NOT NULL PRIMARY KEY,
  exponent    INTEGER NOT NULL,
  symbol      TEXT NOT NULL,
  name_key    TEXT NOT NULL,
  is_enabled  INTEGER NOT NULL DEFAULT 1,
  CHECK (length(code) = 3 AND code = upper(code)),
  CHECK (exponent BETWEEN 0 AND 4),
  CHECK (is_enabled IN (0, 1))
) STRICT;

INSERT INTO currencies (code, exponent, symbol, name_key) VALUES
  ('EUR', 2, '€',   'currency.eur'),
  ('USD', 2, '$',   'currency.usd'),
  ('GBP', 2, '£',   'currency.gbp'),
  ('CHF', 2, 'CHF', 'currency.chf'),
  ('CAD', 2, '$',   'currency.cad'),
  ('JPY', 0, '¥',   'currency.jpy'),
  ('CNY', 2, '¥',   'currency.cny'),
  ('MXN', 2, '$',   'currency.mxn'),
  ('AUD', 2, '$',   'currency.aud'),
  ('SEK', 2, 'kr',  'currency.sek'),
  ('NOK', 2, 'kr',  'currency.nok'),
  ('DKK', 2, 'kr',  'currency.dkk'),
  ('PLN', 2, 'zł',  'currency.pln'),
  ('CZK', 2, 'Kč',  'currency.czk'),
  ('MAD', 2, 'DH',  'currency.mad'),
  ('THB', 2, '฿',   'currency.thb'),
  ('TRY', 2, '₺',   'currency.try')
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- 2. Comptes et sessions
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id                 TEXT NOT NULL PRIMARY KEY,
  email              TEXT NOT NULL,
  email_verified_at  TEXT,
  username           TEXT NOT NULL,
  display_name       TEXT NOT NULL,
  password_hash      TEXT,
  avatar_path        TEXT,
  birthday           TEXT,
  locale             TEXT NOT NULL DEFAULT 'fr',
  time_zone          TEXT NOT NULL DEFAULT 'Europe/Paris',
  is_instance_admin  INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  disabled_at        TEXT,
  anonymized_at      TEXT,
  CHECK (is_instance_admin IN (0, 1)),
  CHECK (length(username) BETWEEN 3 AND 32),
  CHECK (length(display_name) BETWEEN 1 AND 60),
  CHECK (email LIKE '_%@_%._%')
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower    ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (lower(username));

CREATE TABLE IF NOT EXISTS user_identities (
  id                 TEXT NOT NULL PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider           TEXT NOT NULL,
  subject            TEXT NOT NULL,
  email_at_provider  TEXT,
  created_at         TEXT NOT NULL,
  last_used_at       TEXT,
  CHECK (provider IN ('google')),
  UNIQUE (provider, subject),
  UNIQUE (user_id, provider)
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT NOT NULL PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  user_agent    TEXT,
  ip_hash       TEXT,
  revoked_at    TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, expires_at);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          TEXT NOT NULL PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
) STRICT;

-- ============================================================
-- 3. Groupes, appartenances, invitations
-- ============================================================

CREATE TABLE IF NOT EXISTS groups (
  id                     TEXT NOT NULL PRIMARY KEY,
  name                   TEXT NOT NULL,
  slug                   TEXT NOT NULL UNIQUE,
  default_currency_code  TEXT NOT NULL DEFAULT 'EUR' REFERENCES currencies (code),
  time_zone              TEXT NOT NULL DEFAULT 'Europe/Paris',
  created_by_user_id     TEXT NOT NULL REFERENCES users (id),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  archived_at            TEXT,
  deleted_at             TEXT,
  CHECK (length(name) BETWEEN 1 AND 80)
) STRICT;

CREATE TABLE IF NOT EXISTS memberships (
  id          TEXT NOT NULL PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups (id),
  user_id     TEXT NOT NULL REFERENCES users (id),
  role        TEXT NOT NULL DEFAULT 'member',
  status      TEXT NOT NULL DEFAULT 'active',
  nickname    TEXT,
  default_personal_visibility TEXT NOT NULL DEFAULT 'busy',
  joined_at   TEXT NOT NULL,
  ended_at    TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK (role IN ('admin', 'member')),
  CHECK (status IN ('active', 'removed', 'left')),
  CHECK (default_personal_visibility IN ('none', 'busy', 'details')),
  CHECK ((status = 'active') = (ended_at IS NULL)),
  UNIQUE (group_id, user_id),
  UNIQUE (id, group_id)            -- cible des clés étrangères composites
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memberships_user  ON memberships (user_id, status);
CREATE INDEX IF NOT EXISTS idx_memberships_group ON memberships (group_id, status);

CREATE TABLE IF NOT EXISTS invitations (
  id                        TEXT NOT NULL PRIMARY KEY,
  group_id                  TEXT NOT NULL REFERENCES groups (id),
  invited_by_membership_id  TEXT NOT NULL,
  kind                      TEXT NOT NULL,
  target_user_id            TEXT REFERENCES users (id),
  email                     TEXT,
  role                      TEXT NOT NULL DEFAULT 'member',
  token_hash                TEXT UNIQUE,
  status                    TEXT NOT NULL DEFAULT 'pending',
  message                   TEXT,
  created_at                TEXT NOT NULL,
  expires_at                TEXT NOT NULL,
  responded_at              TEXT,
  resulting_membership_id   TEXT,
  CHECK (kind IN ('email', 'existing_user')),
  CHECK (role IN ('admin', 'member')),
  CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  CHECK ((target_user_id IS NOT NULL) + (email IS NOT NULL) = 1),
  CHECK ((kind = 'existing_user') = (target_user_id IS NOT NULL)),
  CHECK (message IS NULL OR length(message) <= 500),
  FOREIGN KEY (invited_by_membership_id, group_id) REFERENCES memberships (id, group_id),
  FOREIGN KEY (resulting_membership_id, group_id) REFERENCES memberships (id, group_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_pending_user
  ON invitations (group_id, target_user_id) WHERE status = 'pending' AND target_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_pending_email
  ON invitations (group_id, lower(email)) WHERE status = 'pending' AND email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invitations_target ON invitations (target_user_id, status);
CREATE INDEX IF NOT EXISTS idx_invitations_group  ON invitations (group_id, status);

-- ============================================================
-- 4. Sondages de dates  (déclarés avant events : events y référence)
-- ============================================================

CREATE TABLE IF NOT EXISTS date_polls (
  id                        TEXT NOT NULL PRIMARY KEY,
  group_id                  TEXT NOT NULL REFERENCES groups (id),
  title                     TEXT NOT NULL,
  description               TEXT,
  status                    TEXT NOT NULL DEFAULT 'open',
  closes_at                 TEXT,
  resulting_event_id        TEXT,
  created_by_membership_id  TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT,
  CHECK (status IN ('open', 'closed', 'converted', 'cancelled')),
  FOREIGN KEY (created_by_membership_id, group_id) REFERENCES memberships (id, group_id),
  FOREIGN KEY (resulting_event_id, group_id)       REFERENCES events (id, group_id),  -- events est créée plus bas : SQLite l'accepte
  UNIQUE (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_polls_group ON date_polls (group_id, status, created_at DESC);

-- ============================================================
-- 5. Événements, organisateurs, présences
-- ============================================================

CREATE TABLE IF NOT EXISTS events (
  id                        TEXT NOT NULL PRIMARY KEY,
  group_id                  TEXT NOT NULL REFERENCES groups (id),
  title                     TEXT NOT NULL,
  description               TEXT,
  location_name             TEXT,
  location_address          TEXT,
  location_lat              REAL,
  location_lon              REAL,
  all_day                   INTEGER NOT NULL DEFAULT 0,
  starts_at                 TEXT NOT NULL,
  ends_at                   TEXT,
  time_zone                 TEXT NOT NULL,
  arrival_note              TEXT,
  host_membership_id        TEXT,
  currency_code             TEXT REFERENCES currencies (code),
  capacity                  INTEGER,
  status                    TEXT NOT NULL DEFAULT 'published',
  source_date_poll_id       TEXT,
  recurrence_rule           TEXT,          -- réservé B7 (V2), inutilisé en V1
  recurrence_parent_id      TEXT,          -- réservé B7 (V2), inutilisé en V1
  occurrence_date           TEXT,          -- réservé B7 (V2), inutilisé en V1
  created_by_membership_id  TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT,
  CHECK (all_day IN (0, 1)),
  CHECK (status IN ('draft', 'published', 'cancelled')),
  CHECK (length(title) BETWEEN 1 AND 140),
  CHECK (capacity IS NULL OR capacity > 0),
  CHECK (
    (all_day = 0 AND length(starts_at) = 20 AND substr(starts_at, 20, 1) = 'Z')
    OR (all_day = 1 AND length(starts_at) = 10)
  ),
  CHECK (ends_at IS NULL OR (length(ends_at) = length(starts_at) AND ends_at >= starts_at)),
  CHECK ((recurrence_parent_id IS NULL) = (occurrence_date IS NULL)),
  FOREIGN KEY (host_membership_id, group_id)       REFERENCES memberships (id, group_id),
  FOREIGN KEY (created_by_membership_id, group_id) REFERENCES memberships (id, group_id),
  FOREIGN KEY (source_date_poll_id, group_id)      REFERENCES date_polls (id, group_id),
  FOREIGN KEY (recurrence_parent_id, group_id)     REFERENCES events (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_events_group_start  ON events (group_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_events_group_status ON events (group_id, status, starts_at);

CREATE TABLE IF NOT EXISTS event_organizers (
  event_id       TEXT NOT NULL,
  group_id       TEXT NOT NULL REFERENCES groups (id),
  membership_id  TEXT NOT NULL,
  added_at       TEXT NOT NULL,
  PRIMARY KEY (event_id, membership_id),
  FOREIGN KEY (event_id, group_id)      REFERENCES events (id, group_id),
  FOREIGN KEY (membership_id, group_id) REFERENCES memberships (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_organizers_member ON event_organizers (group_id, membership_id);

CREATE TABLE IF NOT EXISTS event_attendances (
  event_id       TEXT NOT NULL,
  group_id       TEXT NOT NULL REFERENCES groups (id),
  membership_id  TEXT NOT NULL,
  status         TEXT NOT NULL,
  guests_count   INTEGER NOT NULL DEFAULT 0,
  comment        TEXT,
  responded_at   TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (event_id, membership_id),
  CHECK (status IN ('yes', 'maybe', 'no')),
  CHECK (guests_count BETWEEN 0 AND 20),
  CHECK (comment IS NULL OR length(comment) <= 500),
  FOREIGN KEY (event_id, group_id)      REFERENCES events (id, group_id),
  FOREIGN KEY (membership_id, group_id) REFERENCES memberships (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_attendances_membership ON event_attendances (group_id, membership_id);

-- resulting_event_id est contraint par la clé étrangère composite de date_polls (circulaire avec
-- events.source_date_poll_id, ce que SQLite accepte) ; l'index sert la jointure inverse.
CREATE INDEX IF NOT EXISTS idx_polls_event ON date_polls (group_id, resulting_event_id);

CREATE TABLE IF NOT EXISTS date_poll_options (
  id            TEXT NOT NULL PRIMARY KEY,
  date_poll_id  TEXT NOT NULL,
  group_id      TEXT NOT NULL REFERENCES groups (id),
  all_day       INTEGER NOT NULL DEFAULT 0,
  starts_at     TEXT NOT NULL,
  ends_at       TEXT,
  position      INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  CHECK (all_day IN (0, 1)),
  CHECK (
    (all_day = 0 AND length(starts_at) = 20 AND substr(starts_at, 20, 1) = 'Z')
    OR (all_day = 1 AND length(starts_at) = 10)
  ),
  CHECK (ends_at IS NULL OR (length(ends_at) = length(starts_at) AND ends_at >= starts_at)),
  UNIQUE (date_poll_id, starts_at, ends_at),
  FOREIGN KEY (date_poll_id, group_id) REFERENCES date_polls (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_poll_options ON date_poll_options (group_id, date_poll_id, position);

CREATE TABLE IF NOT EXISTS date_poll_votes (
  date_poll_option_id  TEXT NOT NULL,
  group_id             TEXT NOT NULL REFERENCES groups (id),
  membership_id        TEXT NOT NULL,
  value                TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (date_poll_option_id, membership_id),
  CHECK (value IN ('yes', 'maybe', 'no')),
  FOREIGN KEY (date_poll_option_id, group_id) REFERENCES date_poll_options (id, group_id),
  FOREIGN KEY (membership_id, group_id)       REFERENCES memberships (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_poll_votes_member ON date_poll_votes (group_id, membership_id);

-- ============================================================
-- 6. Agenda personnel
-- ============================================================

CREATE TABLE IF NOT EXISTS personal_events (
  id               TEXT NOT NULL PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id),
  title            TEXT NOT NULL,
  description      TEXT,
  location_name    TEXT,
  all_day          INTEGER NOT NULL DEFAULT 0,
  starts_at        TEXT NOT NULL,
  ends_at          TEXT,
  time_zone        TEXT NOT NULL,
  recurrence_rule  TEXT,                  -- réservé B7 (V2)
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT,
  CHECK (all_day IN (0, 1)),
  CHECK (
    (all_day = 0 AND length(starts_at) = 20 AND substr(starts_at, 20, 1) = 'Z')
    OR (all_day = 1 AND length(starts_at) = 10)
  ),
  CHECK (ends_at IS NULL OR (length(ends_at) = length(starts_at) AND ends_at >= starts_at))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_personal_events_user ON personal_events (user_id, starts_at);

CREATE TABLE IF NOT EXISTS personal_event_shares (
  personal_event_id  TEXT NOT NULL REFERENCES personal_events (id) ON DELETE CASCADE,
  membership_id      TEXT NOT NULL,
  group_id           TEXT NOT NULL REFERENCES groups (id),
  visibility         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (personal_event_id, group_id),
  CHECK (visibility IN ('busy', 'details')),
  FOREIGN KEY (membership_id, group_id) REFERENCES memberships (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_pes_group ON personal_event_shares (group_id, visibility);

-- ============================================================
-- 7. Listes de courses et tâches
-- ============================================================

CREATE TABLE IF NOT EXISTS shopping_lists (
  id                        TEXT NOT NULL PRIMARY KEY,
  group_id                  TEXT NOT NULL REFERENCES groups (id),
  event_id                  TEXT,
  title                     TEXT NOT NULL,
  created_by_membership_id  TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT,
  CHECK (length(title) BETWEEN 1 AND 120),
  FOREIGN KEY (event_id, group_id)                 REFERENCES events (id, group_id),
  FOREIGN KEY (created_by_membership_id, group_id) REFERENCES memberships (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_lists_event ON shopping_lists (group_id, event_id);

CREATE TABLE IF NOT EXISTS shopping_items (
  id                         TEXT NOT NULL PRIMARY KEY,
  shopping_list_id           TEXT NOT NULL,
  group_id                   TEXT NOT NULL REFERENCES groups (id),
  label                      TEXT NOT NULL,
  quantity                   TEXT,
  category                   TEXT,          -- réservé C4 (V2)
  claimed_by_membership_id   TEXT,
  claimed_at                 TEXT,
  is_done                    INTEGER NOT NULL DEFAULT 0,
  done_at                    TEXT,
  position                   INTEGER NOT NULL,
  created_by_membership_id   TEXT NOT NULL,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  deleted_at                 TEXT,
  CHECK (is_done IN (0, 1)),
  CHECK (length(label) BETWEEN 1 AND 120),
  CHECK ((claimed_by_membership_id IS NULL) = (claimed_at IS NULL)),
  CHECK ((is_done = 1) = (done_at IS NOT NULL)),
  FOREIGN KEY (shopping_list_id, group_id)          REFERENCES shopping_lists (id, group_id),
  FOREIGN KEY (claimed_by_membership_id, group_id)  REFERENCES memberships (id, group_id),
  FOREIGN KEY (created_by_membership_id, group_id)  REFERENCES memberships (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_items_list    ON shopping_items (group_id, shopping_list_id, position);
CREATE INDEX IF NOT EXISTS idx_items_claimer ON shopping_items (group_id, claimed_by_membership_id);

CREATE TABLE IF NOT EXISTS event_tasks (
  id                        TEXT NOT NULL PRIMARY KEY,
  group_id                  TEXT NOT NULL REFERENCES groups (id),
  event_id                  TEXT,
  title                     TEXT NOT NULL,
  details                   TEXT,
  assignee_membership_id    TEXT,
  due_at                    TEXT,
  status                    TEXT NOT NULL DEFAULT 'todo',
  done_at                   TEXT,
  position                  INTEGER NOT NULL,
  created_by_membership_id  TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT,
  CHECK (status IN ('todo', 'doing', 'done', 'dropped')),
  CHECK ((status = 'done') = (done_at IS NOT NULL)),
  CHECK (length(title) BETWEEN 1 AND 140),
  FOREIGN KEY (event_id, group_id)                 REFERENCES events (id, group_id),
  FOREIGN KEY (assignee_membership_id, group_id)   REFERENCES memberships (id, group_id),
  FOREIGN KEY (created_by_membership_id, group_id) REFERENCES memberships (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tasks_event    ON event_tasks (group_id, event_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON event_tasks (group_id, assignee_membership_id, status);

-- ============================================================
-- 8. Fils de discussion
-- ============================================================

CREATE TABLE IF NOT EXISTS threads (
  id                        TEXT NOT NULL PRIMARY KEY,
  group_id                  TEXT NOT NULL REFERENCES groups (id),
  event_id                  TEXT,
  title                     TEXT,
  kind                      TEXT NOT NULL,
  is_locked                 INTEGER NOT NULL DEFAULT 0,
  last_message_at           TEXT,
  created_by_membership_id  TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT,
  CHECK (kind IN ('event', 'free')),
  CHECK (is_locked IN (0, 1)),
  CHECK ((kind = 'event') = (event_id IS NOT NULL)),
  CHECK (kind = 'event' OR title IS NOT NULL),
  FOREIGN KEY (event_id, group_id)                 REFERENCES events (id, group_id),
  FOREIGN KEY (created_by_membership_id, group_id) REFERENCES memberships (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_event_unique
  ON threads (event_id) WHERE kind = 'event' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_threads_group ON threads (group_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id                    TEXT NOT NULL PRIMARY KEY,
  thread_id             TEXT NOT NULL,
  group_id              TEXT NOT NULL REFERENCES groups (id),
  author_membership_id  TEXT NOT NULL,
  body                  TEXT NOT NULL,
  reply_to_message_id   TEXT,
  created_at            TEXT NOT NULL,
  edited_at             TEXT,
  deleted_at            TEXT,
  CHECK (length(body) <= 8000),
  CHECK (deleted_at IS NOT NULL OR length(body) >= 1),
  FOREIGN KEY (thread_id, group_id)             REFERENCES threads (id, group_id),
  FOREIGN KEY (author_membership_id, group_id)  REFERENCES memberships (id, group_id),
  FOREIGN KEY (reply_to_message_id, group_id)   REFERENCES messages (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (group_id, thread_id, created_at);

-- ============================================================
-- 9. Dépenses
-- ============================================================

CREATE TABLE IF NOT EXISTS expenses (
  id                        TEXT NOT NULL PRIMARY KEY,
  group_id                  TEXT NOT NULL REFERENCES groups (id),
  event_id                  TEXT,
  label                     TEXT NOT NULL,
  spent_on                  TEXT NOT NULL,
  payer_membership_id       TEXT NOT NULL,
  amount_minor              INTEGER NOT NULL,
  currency_code             TEXT NOT NULL REFERENCES currencies (code),
  target_currency_code      TEXT NOT NULL REFERENCES currencies (code),
  rate_ppm                  INTEGER NOT NULL,
  rate_source               TEXT NOT NULL,
  rate_fetched_at           TEXT,
  amount_target_minor       INTEGER NOT NULL,
  split_mode                TEXT NOT NULL,
  note                      TEXT,
  receipt_path              TEXT,
  created_by_membership_id  TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT,
  CHECK (amount_minor > 0 AND amount_target_minor > 0),
  CHECK (rate_ppm > 0),
  CHECK (length(spent_on) = 10),
  CHECK (length(label) BETWEEN 1 AND 140),
  CHECK (rate_source IN ('identity', 'manual', 'provider')),
  CHECK (split_mode IN ('equal', 'weights', 'exact')),
  -- devises identiques  <=>  taux neutre et source 'identity'
  CHECK (
    (currency_code = target_currency_code AND rate_ppm = 1000000 AND rate_source = 'identity')
    OR (currency_code <> target_currency_code AND rate_source <> 'identity')
  ),
  FOREIGN KEY (event_id, group_id)                 REFERENCES events (id, group_id),
  FOREIGN KEY (payer_membership_id, group_id)      REFERENCES memberships (id, group_id),
  FOREIGN KEY (created_by_membership_id, group_id) REFERENCES memberships (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_expenses_group_date ON expenses (group_id, spent_on DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_event      ON expenses (group_id, event_id);
CREATE INDEX IF NOT EXISTS idx_expenses_payer      ON expenses (group_id, payer_membership_id);

CREATE TABLE IF NOT EXISTS expense_shares (
  expense_id          TEXT NOT NULL,
  group_id            TEXT NOT NULL REFERENCES groups (id),
  membership_id       TEXT NOT NULL,
  weight              INTEGER NOT NULL DEFAULT 1,
  share_minor         INTEGER NOT NULL,
  share_target_minor  INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (expense_id, membership_id),
  CHECK (weight >= 0),
  CHECK (share_minor >= 0 AND share_target_minor >= 0),
  FOREIGN KEY (expense_id, group_id)    REFERENCES expenses (id, group_id),
  FOREIGN KEY (membership_id, group_id) REFERENCES memberships (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_shares_membership ON expense_shares (group_id, membership_id);

CREATE TABLE IF NOT EXISTS settlements (
  id                          TEXT NOT NULL PRIMARY KEY,
  group_id                    TEXT NOT NULL REFERENCES groups (id),
  event_id                    TEXT,
  from_membership_id          TEXT NOT NULL,
  to_membership_id            TEXT NOT NULL,
  amount_minor                INTEGER NOT NULL,
  currency_code               TEXT NOT NULL REFERENCES currencies (code),
  target_currency_code        TEXT NOT NULL REFERENCES currencies (code),
  rate_ppm                    INTEGER NOT NULL,
  amount_target_minor         INTEGER NOT NULL,
  settled_on                  TEXT NOT NULL,
  method_note                 TEXT,
  recorded_by_membership_id   TEXT NOT NULL,
  confirmed_by_membership_id  TEXT,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL,
  deleted_at                  TEXT,
  CHECK (amount_minor > 0 AND amount_target_minor > 0 AND rate_ppm > 0),
  CHECK (from_membership_id <> to_membership_id),
  CHECK (length(settled_on) = 10),
  CHECK (method_note IS NULL OR length(method_note) <= 200),
  CHECK (
    (currency_code = target_currency_code AND rate_ppm = 1000000)
    OR currency_code <> target_currency_code
  ),
  FOREIGN KEY (event_id, group_id)                    REFERENCES events (id, group_id),
  FOREIGN KEY (from_membership_id, group_id)          REFERENCES memberships (id, group_id),
  FOREIGN KEY (to_membership_id, group_id)            REFERENCES memberships (id, group_id),
  FOREIGN KEY (recorded_by_membership_id, group_id)   REFERENCES memberships (id, group_id),
  FOREIGN KEY (confirmed_by_membership_id, group_id)  REFERENCES memberships (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_settlements_group ON settlements (group_id, settled_on DESC);
CREATE INDEX IF NOT EXISTS idx_settlements_pair  ON settlements (group_id, from_membership_id, to_membership_id);

CREATE TABLE IF NOT EXISTS expense_closures (
  id                           TEXT NOT NULL PRIMARY KEY,
  group_id                     TEXT NOT NULL REFERENCES groups (id),
  event_id                     TEXT NOT NULL,
  currency_code                TEXT NOT NULL REFERENCES currencies (code),
  snapshot_json                TEXT NOT NULL,
  total_minor                  INTEGER NOT NULL,
  closed_by_membership_id      TEXT NOT NULL,
  closed_at                    TEXT NOT NULL,
  reopened_at                  TEXT,
  reopened_by_membership_id    TEXT,
  CHECK (total_minor >= 0),
  CHECK (json_valid(snapshot_json)),
  CHECK ((reopened_at IS NULL) = (reopened_by_membership_id IS NULL)),
  FOREIGN KEY (event_id, group_id)                   REFERENCES events (id, group_id),
  FOREIGN KEY (closed_by_membership_id, group_id)    REFERENCES memberships (id, group_id),
  FOREIGN KEY (reopened_by_membership_id, group_id)  REFERENCES memberships (id, group_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_closures_active
  ON expense_closures (event_id) WHERE reopened_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_closures_group ON expense_closures (group_id, closed_at DESC);

-- ============================================================
-- 10. Photos (Immich)
-- ============================================================

CREATE TABLE IF NOT EXISTS group_immich_configs (
  group_id                   TEXT NOT NULL PRIMARY KEY REFERENCES groups (id),
  base_url                   TEXT NOT NULL,
  api_key_cipher             BLOB NOT NULL,
  api_key_nonce              BLOB NOT NULL,
  api_key_fingerprint        TEXT NOT NULL,
  immich_user_id             TEXT,
  status                     TEXT NOT NULL DEFAULT 'untested',
  last_checked_at            TEXT,
  last_error                 TEXT,
  configured_by_membership_id TEXT NOT NULL,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  CHECK (status IN ('ok', 'unreachable', 'unauthorized', 'untested')),
  CHECK (base_url LIKE 'http://%' OR base_url LIKE 'https://%'),
  FOREIGN KEY (configured_by_membership_id, group_id) REFERENCES memberships (id, group_id)
) STRICT;

CREATE TABLE IF NOT EXISTS albums (
  id                        TEXT NOT NULL PRIMARY KEY,
  group_id                  TEXT NOT NULL REFERENCES groups (id),
  event_id                  TEXT,
  title                     TEXT NOT NULL,
  immich_album_id           TEXT NOT NULL,
  cover_immich_asset_id     TEXT,
  asset_count               INTEGER NOT NULL DEFAULT 0,
  last_synced_at            TEXT,
  sync_status               TEXT NOT NULL DEFAULT 'pending',
  created_by_membership_id  TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT,
  CHECK (sync_status IN ('ok', 'pending', 'error', 'orphan')),
  CHECK (asset_count >= 0),
  UNIQUE (group_id, immich_album_id),
  FOREIGN KEY (event_id, group_id)                 REFERENCES events (id, group_id),
  FOREIGN KEY (created_by_membership_id, group_id) REFERENCES memberships (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_event_unique
  ON albums (event_id) WHERE event_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS album_assets (
  album_id                   TEXT NOT NULL,
  group_id                   TEXT NOT NULL REFERENCES groups (id),
  immich_asset_id            TEXT NOT NULL,
  kind                       TEXT NOT NULL,
  taken_at                   TEXT,
  width                      INTEGER,
  height                     INTEGER,
  duration_ms                INTEGER,
  uploaded_by_membership_id  TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  removed_at                 TEXT,
  PRIMARY KEY (album_id, immich_asset_id),
  CHECK (kind IN ('image', 'video')),
  FOREIGN KEY (album_id, group_id)                  REFERENCES albums (id, group_id),
  FOREIGN KEY (uploaded_by_membership_id, group_id) REFERENCES memberships (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_assets_album ON album_assets (group_id, album_id, taken_at DESC);

-- ============================================================
-- 11. Flux iCal, notifications, e-mails
-- ============================================================

CREATE TABLE IF NOT EXISTS calendar_feed_tokens (
  id                TEXT NOT NULL PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  group_id          TEXT REFERENCES groups (id),
  token_hash        TEXT NOT NULL UNIQUE,
  label             TEXT,
  include_personal  INTEGER NOT NULL DEFAULT 0,
  include_declined  INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  last_used_at      TEXT,
  last_user_agent   TEXT,
  revoked_at        TEXT,
  CHECK (include_personal IN (0, 1)),
  CHECK (include_declined IN (0, 1))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_feeds_user ON calendar_feed_tokens (user_id, revoked_at);

CREATE TABLE IF NOT EXISTS notifications (
  id               TEXT NOT NULL PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  group_id         TEXT REFERENCES groups (id),
  kind             TEXT NOT NULL,
  subject_type     TEXT,
  subject_id       TEXT,
  payload_json     TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  read_at          TEXT,
  email_queued_at  TEXT,
  email_sent_at    TEXT,
  CHECK (json_valid(payload_json)),
  CHECK (kind IN (
    'invitation_received', 'member_joined', 'event_created', 'event_updated',
    'event_cancelled', 'poll_opened', 'poll_closing', 'item_claimed',
    'task_assigned', 'message_posted', 'expense_added', 'accounts_closed'
  )),
  CHECK (subject_type IS NULL OR subject_type IN (
    'group', 'invitation', 'event', 'date_poll', 'shopping_item',
    'event_task', 'thread', 'message', 'expense', 'album'
  ))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  group_id       TEXT NOT NULL,            -- identifiant de groupe, ou '*' pour le réglage global
  channel_email  INTEGER NOT NULL DEFAULT 1,
  digest         TEXT NOT NULL DEFAULT 'instant',
  muted_kinds    TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, group_id),
  CHECK (channel_email IN (0, 1)),
  CHECK (digest IN ('instant', 'daily', 'off')),
  CHECK (json_valid(muted_kinds))
) STRICT;

CREATE TABLE IF NOT EXISTS email_outbox (
  id                   TEXT NOT NULL PRIMARY KEY,
  to_email             TEXT NOT NULL,
  template_key         TEXT NOT NULL,
  payload_json         TEXT NOT NULL,
  locale               TEXT NOT NULL DEFAULT 'fr',
  group_id             TEXT REFERENCES groups (id),
  status               TEXT NOT NULL DEFAULT 'pending',
  attempts             INTEGER NOT NULL DEFAULT 0,
  next_attempt_at      TEXT NOT NULL,
  provider_message_id  TEXT,
  last_error           TEXT,
  created_at           TEXT NOT NULL,
  sent_at              TEXT,
  CHECK (status IN ('pending', 'sent', 'failed', 'abandoned')),
  CHECK (json_valid(payload_json)),
  CHECK (attempts >= 0)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON email_outbox (status, next_attempt_at);
```

### 5.1 Ce fichier a été exécuté

Le SQL ci-dessus est celui du fichier `app/migrations/0001_socle.sql`, **identique** au
caractère près (un test de la suite le compare, et la revue le compare par `diff`). Il a été joué
sur **SQLite 3.54** : 33 tables créées, 40 index, `PRAGMA integrity_check` à `ok`, relance du
fichier sans erreur (idempotence), et des tentatives d'écriture illégitimes **refusées par la
base** :

| Tentative | Refusée par |
|---|---|
| Rattacher un article du groupe B à une liste du groupe A | clé étrangère composite |
| Enregistrer la présence d'un membre de B à un événement de A | clé étrangère composite |
| Un événement « journée entière » portant un instant UTC | `CHECK` de format de date |
| Un instant sans `Z` final (`2026-12-01T20:00:00+`) dans `events`, `personal_events`, `date_poll_options` | `CHECK` de format de date |
| Une fin dont la longueur diffère du début, dans ces trois tables | `CHECK` de format de date |
| Une dépense EUR→EUR avec un taux différent de 1 | `CHECK` de cohérence du taux |
| Passer une appartenance à `removed` sans `ended_at` | `CHECK` croisé statut/date |
| Deux invitations en attente pour la même personne dans le même groupe | index unique partiel |
| Un sondage de A pointant vers un événement de B (`resulting_event_id`) | clé étrangère composite |
| Publier un créneau d'agenda vers un groupe dont on n'est pas membre | clé étrangère composite |
| Une dépense JPY→EUR correctement formée | *acceptée* (contrôle négatif) |

La règle « toute clé étrangère vers un parent à groupe est composite » n'est plus vérifiée par une
liste d'exemples : un test la dérive de `pragma_foreign_key_list`, donc une migration future qui
l'enfreindrait est refusée.

### 5.2 Deux remarques sur ce fichier

- **`PRAGMA foreign_keys` n'est pas persistant.** Le démarrage lit `PRAGMA foreign_keys;` et
  **refuse de servir** si la réponse n'est pas `1` : sans cela, les clés étrangères composites
  du §4.1 — c'est-à-dire la moitié du cloisonnement — seraient décoratives.
- **`date_polls.resulting_event_id` a sa clé étrangère composite** vers `events (id, group_id)`,
  bien que `date_polls` soit créée avant `events` et que `events.source_date_poll_id` pointe en
  retour vers `date_polls` : SQLite accepte une référence vers une table créée plus loin, y compris
  circulaire (la table cible n'est résolue qu'à l'écriture). La conversion d'un sondage s'écrit
  donc dans une transaction : création de l'événement avec `source_date_poll_id`, puis
  `resulting_event_id` du sondage. Un sondage ne peut plus pointer vers l'événement d'un autre groupe.

## 6. Requêtes de référence

**Soldes d'un événement** (groupés par devise de calcul — on n'additionne jamais deux devises) :

```sql
WITH paye AS (
  SELECT payer_membership_id AS membership_id, target_currency_code,
         SUM(amount_target_minor) AS montant
    FROM expenses
   WHERE group_id = :groupId AND event_id = :eventId AND deleted_at IS NULL
   GROUP BY 1, 2
),
du AS (
  SELECT s.membership_id, e.target_currency_code,
         SUM(s.share_target_minor) AS montant
    FROM expense_shares s
    JOIN expenses e ON e.id = s.expense_id AND e.group_id = s.group_id
   WHERE s.group_id = :groupId AND e.event_id = :eventId AND e.deleted_at IS NULL
   GROUP BY 1, 2
)
-- solde = ce qu'il a avancé − sa part, corrigé des remboursements déclarés
SELECT membership_id, target_currency_code,
       COALESCE(paye, 0) - COALESCE(du, 0) + COALESCE(rendu, 0) AS solde_minor
  FROM ( /* union des trois sources, dont settlements */ );
```

**Contrôles d'intégrité** (`npm run verifier:integrite`, lancés par les tests et disponibles en
exploitation) :

```sql
-- 1. Une part dont la somme ne fait pas le total de sa dépense
SELECT e.id FROM expenses e
  JOIN expense_shares s ON s.expense_id = e.id AND s.group_id = e.group_id
 WHERE e.deleted_at IS NULL
 GROUP BY e.id
HAVING SUM(s.share_minor) <> e.amount_minor
    OR SUM(s.share_target_minor) <> e.amount_target_minor;

-- 2. Une ligne métier dont le groupe diffère de celui de son parent
--    (doit être vide par construction : les FK composites l'interdisent)
SELECT i.id FROM shopping_items i
  JOIN shopping_lists l ON l.id = i.shopping_list_id
 WHERE l.group_id <> i.group_id;

-- 3. Un groupe sans administrateur actif
SELECT g.id FROM groups g
 WHERE g.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM memberships m
                    WHERE m.group_id = g.id AND m.role = 'admin' AND m.status = 'active');

-- 4. Un sondage converti qui pointe sur un événement d'un autre groupe
SELECT p.id FROM date_polls p
  JOIN events ev ON ev.id = p.resulting_event_id
 WHERE ev.group_id <> p.group_id;
```

## 7. Ce qui reste ouvert

| # | Question | Qui tranche |
|---|---|---|
| 1 | **La liste des 17 devises** est-elle à élaguer (point ouvert n° 5 du périmètre) ? Sans réponse, les 17 sont insérées et toutes activées : c'est réversible par un `UPDATE`. | Théo |
| 2 | **Quota par groupe** (nombre de membres, d'événements, taille des pièces jointes) : aucune colonne n'est posée. Si l'instance doit être ouverte à des inconnus, il faudra une table `group_quotas`. | Théo |
| 3 | **Journal d'audit** (F7, V2) : table `audit_log (group_id, actor_membership_id, action, target, payload_json)`. Rien en V1, mais les actions sensibles (retrait de membre, suppression d'album, clôture) devraient peut-être y être tracées dès maintenant — c'est 20 lignes de code et ça ne s'ajoute pas rétroactivement. | Théo |
| 4 | **`users.birthday`** est posée pour B8 (V2) mais sa visibilité n'est pas définie (tous les groupes ? par groupe ?). Elle n'est exposée par aucune API en V1. | à trancher avec B8 |
