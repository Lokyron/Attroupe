# ADR-0017 — Un seul réglage de compte pour la visibilité de l'agenda personnel

- **Statut** : acceptée
- **Date** : 2026-11-20
- **Décidé par** : l'architecte, sur une direction tranchée par l'orchestrateur
- **Concerne** : `users`, `memberships.default_personal_visibility`, `personal_event_shares`,
  `db/queries/agenda-personnel.ts`, `db/sql.ts`, `db/scope.ts`, `pages/Compte.tsx`, `pages/Agenda.tsx`

## Contexte

La visibilité de l'agenda personnel se règle aujourd'hui à **deux endroits**, et les deux sont
exposés à l'utilisateur :

- un défaut **par appartenance** : `memberships.default_personal_visibility`, TEXT NOT NULL
  DEFAULT `'busy'`, `CHECK IN ('none','busy','details')` (`app/migrations/0001_socle.sql:140`
  et `:147`), réglé par `PUT /api/groupes/:groupId/ma-visibilite`
  (`app/server/http/routes/groupes.ts:117`) et affiché dans `app/client/src/pages/Agenda.tsx:170-176` ;
- un partage **par créneau et par groupe** : `personal_event_shares`
  (`app/migrations/0001_socle.sql:362-373`), PK `(personal_event_id, group_id)`,
  `CHECK (visibility IN ('busy','details'))`, l'absence de ligne valant « pas partagé ».
  Réglé par `PUT /api/moi/agenda/:id/partages` (`app/server/http/routes/moi.ts:347-351`) et
  affiché par un `<select>` **par groupe et par créneau** dans `app/client/src/pages/Compte.tsx:461-476`.

Le coût de ce modèle pour l'utilisateur est un produit : un compte dans 3 groupes avec 200 créneaux
importés d'un agenda externe, c'est **600 réglages** possibles. Personne ne les tient. Et depuis
l'ADR-0013, la plupart des créneaux ne sont plus saisis à la main mais importés par lot
(`remplacerCreneauxImportes`, `app/server/db/queries/agenda-externe.ts:202-245`) : le réglage par
créneau est devenu un réglage que l'utilisateur n'a jamais demandé, sur des lignes qu'il n'a jamais
créées.

Le besoin, dans les mots de l'utilisateur : « un seul réglage, mon calendrier personnel est visible
de moi seul, les autres voient seulement occupé, et ça s'applique à tout, maintenant et plus tard ».

Deux faits de code cadrent la solution :

- `listerDisponibilitesGroupe` (`app/server/db/queries/agenda-personnel.ts:274-335`) est **la seule**
  lecture de l'agenda d'un compte par un autre membre. Elle procède en deux requêtes : celle de
  `'busy'` ne sélectionne jamais `p.title`, `p.description` ni `p.location_name` (ADR-0013 §2).
- `creneauxOccupes` (`app/server/db/scope.ts:187-202`) fait la même jointure
  `personal_event_shares ⋈ personal_events` **sans filtrer sur `visibility`**, et n'a **aucun appelant
  de production** : les seuls usages sont `app/tests/cloisonnement/portee-utilisateur.test.ts:94-116`
  et le bouchon de `scope-compilation.test.ts:45`.

L'ADR-0013 acte que le modèle `none`/`busy`/`details` par groupe « est déjà en place et ne bouge
pas ». Cette ADR ne le démolit pas : elle lui ajoute un plafond au-dessus, et retire de l'interface
les deux réglages que l'utilisateur ne veut plus voir.

## Décisions

### 1. Le réglage vit sur `users`, et vaut pour tout l'agenda personnel

```sql
-- app/migrations/0009_visibilite_agenda_personnel.sql
ALTER TABLE users ADD COLUMN personal_agenda_visibility TEXT NOT NULL DEFAULT 'busy'
  CHECK (personal_agenda_visibility IN ('none', 'busy', 'details'));
```

`0009` est le prochain numéro libre (`0008_preferences_notifications_heritage.sql` est le dernier).
Un `ALTER TABLE … ADD COLUMN` avec `CHECK` porté par la colonne, comme en `0004` et `0005` : pas
d'`ADD CONSTRAINT`, pas de reconstruction de table.

Le nom est **distinct** de `default_personal_visibility` à dessein : deux colonnes homonymes dans
deux tables, dont l'une plafonne l'autre, est une confusion garantie en revue.

**Une seule colonne pour les créneaux importés et les créneaux saisis à la main.** Rejeté
explicitement : un réglage par famille. L'utilisateur parle de « mon calendrier personnel » comme
d'un tout ; et le plancher des créneaux importés est **déjà structurel** — le `CHECK` de
`0004_agenda_externe.sql:46` leur impose `title = ''`, les deux déclencheurs de `:54` et `:62`
refusent `visibility = 'details'`, et leurs textes réels ne vivent que chiffrés
(`details_cipher`, `0005`), hors d'atteinte de la requête de groupe. Un second réglage ne
protégerait donc rien de plus et réintroduirait la combinatoire qu'on supprime.

### 2. L'amorçage ne peut que restreindre

La même migration amorce la colonne avec le choix le **plus restrictif** que le compte avait déjà
exprimé groupe par groupe :

```sql
UPDATE users SET personal_agenda_visibility = COALESCE((
  SELECT m.default_personal_visibility
    FROM memberships AS m
   WHERE m.user_id = users.id AND m.status = 'active'
   ORDER BY CASE m.default_personal_visibility WHEN 'none' THEN 0 WHEN 'busy' THEN 1 ELSE 2 END
   LIMIT 1
), 'busy');
```

Les migrations passent par `connexionBrute(base).exec` (`app/server/db/migrate.ts:138`), donc hors du
verrou n° 5 : la sous-requête y est licite, elle ne le serait pas dans `db/queries/`.

**La migration ne touche aucune ligne de `personal_event_shares`.** Aucune promotion, aucune
suppression, aucun remplissage. Conséquence voulue : le jour de la mise à jour, **rien ne devient
visible qui ne l'était pas**. Un compte qui avait réglé un groupe sur `none` se retrouve plafonné à
`none` partout — une restriction, jamais une ouverture, et une restriction qu'il lève en un clic.

### 3. Le plafond s'applique à la lecture, par un minimum sur l'ordre `none < busy < details`

Nouveau module pur, `app/server/domain/visibilite-personnelle.ts` :

```ts
export const RANG_VISIBILITE = { none: 0, busy: 1, details: 2 } as const;
export function plafonner(plafond: VisibilitePartage, demandee: VisibilitePartage): VisibilitePartage;
```

`plafonner` est le **minimum** des deux rangs. Il n'y a pas d'autre fonction de combinaison, et
aucun chemin n'a le droit d'en écrire une seconde.

`listerDisponibilitesGroupe` garde ses **deux textes SQL** (l'invariant ADR-0013 §2 — le texte
`'busy'` ne nomme jamais une colonne de texte — est non négociable), mais le choix du texte se fait
désormais sur la visibilité **effective**, et le filtre est une table des cas du treillis, exécutée
avec le même gabarit de `WHERE` :

| `u.personal_agenda_visibility` | `s.visibility` | effectif | texte exécuté |
|---|---|---|---|
| `none` | — | `none` | aucun (pas de requête) |
| `busy` | `busy` | `busy` | texte sans colonnes de texte |
| `busy` | `details` | `busy` | texte sans colonnes de texte |
| `details` | `busy` | `busy` | texte sans colonnes de texte |
| `details` | `details` | `details` | texte avec `title`, `description`, `location_name` |

Donc : le gabarit `tablesEtFiltres` garde son `JOIN users AS u` (déjà présent, ligne 288) et gagne
deux conjoints liés — `AND u.personal_agenda_visibility = ? AND s.visibility = ?` ; le texte
« occupé » est exécuté **trois fois** (trois couples de paramètres), le texte « détails » une fois.
Quatre exécutions d'un seul gabarit, dont la table de correspondance est engendrée par `plafonner` :
un test unitaire vérifie que la table des quatre couples est exactement le minimum du treillis, donc
qu'elle ne peut pas diverger de la fonction pure.

**Pourquoi pas un `CASE` dans le `WHERE`, ni un `OR`** : le verrou n° 5 les refuse tous les deux
(`app/server/db/sql.ts:318` — « CASE admis seulement dans la liste de sélection ou ORDER BY » — et
`or` est dans `MOTS_INTERDITS`). Quatre exécutions d'un gabarit prouvé filtré valent mieux qu'un
assouplissement de la garde.

### 4. Verrou n° 6 : le plafond est rendu obligatoire par la garde du SQL brut

C'est le cœur de l'ADR. Une fonction de combinaison correcte ne garantit rien si un futur chemin de
lecture ne l'appelle pas. On obtient donc la garantie **par construction**, dans l'esprit de
l'ADR-0006 (verrous empilés) et de l'ADR-0014 : la garde de `app/server/db/sql.ts` refuse la requête.

Règle à ajouter dans `diagnostiquer`, à la suite du calcul de `liensPartage`
(`app/server/db/sql.ts:379` et `:529-546`, la propagation qui couvre `personal_events` par ses
partages) :

> Une requête qui référence à la fois `personal_event_shares` et `personal_events` est **refusée**
> sauf si elle porte, en conjoint direct d'un `WHERE` ou d'un `ON`, un filtre lié
> `<alias de users>.personal_agenda_visibility = ?`, et le rapprochement
> `<alias de users>.id = <alias de memberships>.user_id`.

Le nom de colonne est **inscrit en dur** dans la garde, comme les colonnes de portée de
`PORTEE_TABLES` : c'est le même genre d'objet, une invariance du schéma que le code ne négocie pas.
Un refus arrive partout, production comprise, puisque le texte est statique.

Ce que cette règle atteint exactement, vérifié requête par requête :

- elle **exige** le plafond sur la seule forme dangereuse, celle où un membre lit l'agenda d'un
  autre : la jointure `shares ⋈ events`. C'est aujourd'hui `listerDisponibilitesGroupe` et
  `creneauxOccupes`, et rien d'autre ;
- elle **n'entrave pas** les lectures légitimes de `personal_events` seule : la garde de propriété
  de `scope.ts:176`, `app/server/db/queries/agenda-externe.ts:181` et `:227`, et
  `CORPS_ENSEMBLE_PERSONNEL` (`flux.ts:192`) ne joignent pas `personal_event_shares` ;
- elle **n'entrave pas** les écritures de partage (`scope.upsert('personal_event_shares', …)`
  engendre une requête sur une seule table).

Un futur développeur qui écrit une nouvelle lecture des disponibilités d'un groupe se heurte donc à
`ErreurRequeteSansGroupe` au premier `preparer`, et non à une revue qu'il pourrait passer.

### 5. À l'écriture, le réglage de compte remplace `default_personal_visibility`

`creerCreneauPersonnel` (`agenda-personnel.ts:150-171`) et `remplacerCreneauxImportes`
(`agenda-externe.ts:202-245`) cessent de lire `memberships.default_personal_visibility`. Ils écrivent,
pour chaque appartenance active :

- créneau saisi à la main : `plafonner(reglageDuCompte, 'details')` ;
- créneau importé : `plafonner(reglageDuCompte, 'busy')` ;
- réglage à `none` : **aucune ligne** (comportement identique à l'actuel `'none'`).

Le piège nommé dans l'ADR-0013 §2 (« un membre ayant réglé `details` pour un groupe verrait l'import
échouer en entier ») disparaît de lui-même : le plancher importé est appliqué par `plafonner`, et les
deux déclencheurs restent le filet.

**Réalignement à l'enregistrement du réglage** : quand l'utilisateur sauve son réglage et qu'il
n'est pas `none`, le service met les lignes existantes à la valeur correspondante (`details` pour les
créneaux manuels, `busy` pour les importés), en créant celles qui manquent pour ses appartenances
actives. Ce réalignement **n'est pas le dispositif de sécurité** — le plafond de la décision 3 l'est,
et une ligne oubliée par le réalignement reste bornée par lui. Il n'existe que pour que *élargir* le
réglage prenne effet sur les créneaux déjà en base. Il ne supprime **jamais** une ligne : passer à
`none` ne détruit rien, le plafond masque, et revenir en arrière est sans perte.

### 6. `default_personal_visibility` devient dormante ; sa route disparaît

La colonne **reste** dans le schéma (la retirer serait une reconstruction de table, et elle est le
point d'accroche d'un éventuel affinage par groupe plus tard : `personal_event_shares` reste par
groupe, donc un tel affinage ne demandera aucune migration). Mais **plus aucun chemin ne la lit ni
ne l'écrit**, et c'est la condition pour qu'elle ne mente pas.

En conséquence, `PUT /api/groupes/:groupId/ma-visibilite` est **supprimée** : route
(`groupes.ts:117-119`), service `changerMaVisibiliteDefaut`, requêtes `lireMaVisibiliteDefaut` /
`modifierMaVisibiliteDefaut` (`agenda-personnel.ts:229-238`), ligne 215 du registre de cloisonnement,
appel client. Garder une route qui écrit une colonne que personne ne lit, c'est reproduire exactement
le défaut corrigé par l'ADR-0016 : un réglage dont l'utilisateur croit qu'il agit.

`PUT /api/moi/agenda/:id/partages` est **supprimée** pour la même raison, et pour une raison de plus :
sans contrôle d'interface, une ligne abaissée par créneau devient un état invisible, impossible à
diagnostiquer par l'utilisateur. Sont retirés : la route (`moi.ts:347-351`),
`definirPartagesDansMonAgenda` (`services/agenda-personnel.ts:103-117`), `definirPartagesCreneau`
(`agenda-personnel.ts:195-224`), `schemaPartagesCreneau`, la ligne 148 du registre, et
`definirPartages` dans `app/client/src/api/agenda-personnel.ts:130-132`.

Le champ `partages` du créneau rendu par l'API disparaît aussi (`api/agenda-personnel.ts:26` et `:82`,
`CreneauPersonnelAvecPartages`, `partagesParCreneau`) : il serait désormais identique pour tous les
créneaux, donc du bruit. Client et serveur sont livrés ensemble, il n'y a pas de compatibilité à
tenir.

### 7. `creneauxOccupes` est supprimée

Elle n'a aucun appelant de production, elle ne filtre pas `visibility`, et le verrou n° 6 la
refuserait désormais au `preparer`. Trois raisons concordantes : on retire
`app/server/db/scope.ts:121-123` (le type), `:187-202` (la mise en œuvre), `:220` (l'exposition), le
bouchon de `scope-compilation.test.ts:45` et les assertions de
`portee-utilisateur.test.ts:94-116`, dont la valeur de preuve est transférée vers
`listerDisponibilitesGroupe` (décision 10).

Garder une seconde jointure `shares ⋈ events` « au cas où », c'est garder la porte par laquelle la
fuite entrera : c'est déjà le chemin qui ignore `visibility` aujourd'hui.

### 8. Le flux iCal sortant ne contourne rien, et ne doit pas être plafonné

Vérifié : `evenementsPersonnelsFlux` et `empreintePersonnelleFlux` (`flux.ts:204-242`) lisent
`personal_events` par `p.user_id = ?`, et cette portée est construite par
`creerPorteeUtilisateur(contexte.base, jeton.user_id)` dans
`app/server/http/middleware/jeton-flux.ts:92`, c'est-à-dire **le compte propriétaire du jeton**.
`calendar_feed_tokens.group_id` ne restreint que la partie *événements de groupe* du flux ; la partie
personnelle est toujours « mon agenda, à moi ». Aucun créneau d'un autre membre n'entre jamais dans
un flux.

**Donc : aucun changement, et surtout pas de plafond appliqué ici.** Plafonner le flux reviendrait à
renvoyer au téléphone de l'utilisateur ses propres rendez-vous sans titre, c'est-à-dire à refaire
l'erreur que la révision du 2026-11-18 de l'ADR-0013 a corrigée.

Deux points à ne pas confondre avec une fuite, mais à dire :

1. l'URL du flux est un **secret porteur** (ADR-0010) ; l'utilisateur qui la partage partage ses
   propres détails. Ce n'est pas le réglage de groupe qui est contourné, c'est un secret personnel
   qui est donné ;
2. le libellé de l'interface ne doit donc **pas** promettre « personne ne voit mes détails » : il
   parle des **membres de mes groupes**. Formulation imposée à la décision 9.

### 9. Interface : un contrôle, trois options, et deux sélecteurs qui disparaissent

Dans `app/client/src/pages/Compte.tsx`, section « Mon agenda personnel », **un seul**
`<select>` au-dessus de la liste des créneaux, servi par `PATCH /api/moi/profil` (le réglage rejoint
`display_name`, `time_zone` et `birthday` dans `schemaProfil` et `ModificationProfil`,
`db/queries/comptes.ts:462-466` — c'est un réglage de compte, il appartient au profil, pas à une
nouvelle route) :

- libellé : **« Ce que les membres de mes groupes voient de mon agenda personnel »** ;
- `none` → **« Rien — mon agenda n'est visible que de moi »** ;
- `busy` → **« Seulement que je suis occupé (sans titre, ni lieu, ni description) »** *(défaut)* ;
- `details` → **« Les détails : titre, lieu et description »**, avec la mention
  « sauf les créneaux importés d'un agenda externe, qui restent sans détail ».

Une phrase sous le contrôle : « Ce réglage s'applique à tous les créneaux de votre agenda personnel,
présents et à venir, dans tous vos groupes. »

Disparaissent : les `<select>` par groupe et par créneau (`Compte.tsx:461-476`, et la règle CSS
`.agenda-visibilite-champ` si elle ne sert plus ailleurs), le sélecteur « Ma visibilité par défaut
dans ce groupe » (`Agenda.tsx:170-176`) et les clés i18n devenues mortes
(`agenda_perso.partages_titre`, `disponibilites.ma_visibilite`, `disponibilites.visibilite_*`).

**Le défaut par groupe n'est plus réglable nulle part.** C'est le but : l'utilisateur a demandé un
réglage, pas un réglage de moins.

### 10. Tests

| Fichier | Test | Ce qu'il prouve |
|---|---|---|
| `app/tests/cloisonnement/agenda-personnel-plafond.test.ts` *(nouveau)* | « un membre d'un autre groupe ne voit que « occupé » quand le plafond est à busy, même si la ligne de partage dit details » | Le cœur. On écrit directement en base `personal_event_shares.visibility = 'details'` sur un créneau manuel, `users.personal_agenda_visibility = 'busy'`, et on vérifie que `GET /api/groupes/:groupId/disponibilites` rend `visibility: 'busy'` et `title`, `description`, `location_name` **à `null`** |
| idem | « le plafond none masque un créneau dont la ligne de partage existe » | `personal_agenda_visibility = 'none'` → liste vide, ligne de partage présente |
| idem | « une lecture de personal_event_shares jointe à personal_events sans filtre de plafond est refusée par la garde » | Le verrou n° 6 lui-même, par `diagnostiquer` sur un texte forgé — à ranger à côté de `verrou-db.test.ts` |
| `app/tests/integration/agenda-personnel.test.ts` *(étendu)* | « le réglage de compte s'applique à un créneau créé APRÈS le réglage » | On règle `busy`, **puis** on crée un créneau par `POST /api/moi/agenda`, puis un autre membre lit : `busy` sans texte. Aucun appel de réglage entre les deux |
| idem | « abaisser le réglage masque immédiatement les créneaux déjà importés » | Import ICS, puis passage à `none`, puis lecture par un autre membre : vide |
| idem | « élargir à details réaligne les créneaux manuels existants, et laisse les importés à occupé » | Décision 5, les deux moitiés |
| `app/tests/unite/agenda-personnel.test.ts` *(étendu)* | « la table des couples (plafond, partage) de listerDisponibilitesGroupe est exactement le minimum du treillis » | Qu'on ne peut pas faire diverger la table SQL de `plafonner` |
| idem | « plafonner est un minimum sur none < busy < details » | Les 9 couples, exhaustifs |
| `app/tests/cloisonnement/registre.test.ts` | mise à jour | Les deux routes retirées ne figurent plus au registre, et sa complétude tient |
| `app/tests/cloisonnement/portee-utilisateur.test.ts` | mise à jour | Les assertions `creneauxOccupes` remplacées par des assertions `listerDisponibilitesGroupe` |

Un test de schéma existe déjà pour `PORTEE_TABLES` ; il faut y ajouter la vérification que
`users.personal_agenda_visibility` existe, puisque le verrou n° 6 en dépend par son nom.

### 11. Ordre d'implémentation

1. **Migration** `app/migrations/0009_visibilite_agenda_personnel.sql` : la colonne (décision 1), puis
   l'amorçage (décision 2). Lancer les migrations sur une copie de la base de développement et
   vérifier à la main les valeurs amorcées.
2. **Domaine** : `app/server/domain/visibilite-personnelle.ts` (`RANG_VISIBILITE`, `plafonner`) et son
   test unitaire exhaustif. Rien d'autre ne bouge à cette étape.
3. **Lecture** : `listerDisponibilitesGroupe` (décision 3) — gabarit de `WHERE` enrichi, quatre
   exécutions, table des couples engendrée depuis `plafonner`.
4. **Verrou n° 6** : la règle dans `app/server/db/sql.ts` (décision 4) et son test. À faire **après**
   l'étape 3, sinon l'étape 3 ne prépare plus ses propres requêtes.
5. **Suppression de `creneauxOccupes`** (décision 7) : `db/scope.ts` et les deux tests concernés.
6. **Écriture** : `creerCreneauPersonnel`, `remplacerCreneauxImportes`, et le réalignement à
   l'enregistrement du réglage (décision 5).
7. **Profil** : `schemaProfil`, `ModificationProfil`, `modifierProfil`, `lireProfil` (la colonne entre
   dans le `SELECT` de `comptes.ts:453`), et `GET /api/moi`.
8. **Retraits serveur** (décision 6) : les deux routes, leurs services, leurs requêtes, leurs schémas,
   les deux lignes du registre de cloisonnement.
9. **Client** : `api/compte.ts` (le champ dans `ProfilCompte` et `modifierProfil`), le contrôle unique
   de `Compte.tsx` (décision 9), les retraits dans `Compte.tsx` et `Agenda.tsx`,
   `api/agenda-personnel.ts`, `i18n/fr.json`.
10. **Tests** (décision 10), puis la suite complète.
11. **Documentation** : `DOCUMENTATION.md` (endpoints retirés, nouveau champ de profil),
    `Dossier de conception/03 - Modele de donnees.md` §3.6,
    `Dossier de conception/04 - Architecture.md` §4 (le verrou n° 6),
    `Avancement du projet/AVANCEMENT.md`.

## Conséquences

- **Le réglage est honnête dans le sens restrictif** : abaisser s'applique instantanément à tous les
  créneaux, présents, à venir, et aux lignes de partage déjà écrites, sans migration de données.
  C'est le sens que l'utilisateur a demandé.
- **Dans le sens permissif, il dépend d'un réalignement** (décision 5), qui est du confort et non une
  garantie. Si le réalignement échouait partiellement, l'effet serait « il manque des détails », pas
  une fuite.
- **Le verrou n° 6 refusera du SQL légitime** un jour : une page d'exploitation, une statistique, un
  export. C'est le comportement voulu d'une garde fermée (`db/sql.ts:11-13`) ; la réponse est
  d'écrire autrement, jamais d'élargir la règle.
- **Trois exécutions pour le texte « occupé »** au lieu d'une : trois requêtes indexées
  (`idx_pes_group`) sur une fenêtre de calendrier. Négligeable, et c'est le prix du refus du `OR`
  par le verrou n° 5.
- **`memberships.default_personal_visibility` devient une colonne morte.** Elle doit être signalée
  comme telle dans le modèle de données, sinon elle sera relue par erreur dans six mois.
- **Un cas de perte de nuance, assumé** : un compte qui avait réglé `details` partout et abaissé
  quelques créneaux à la main voit ces créneaux repasser en `details` au premier enregistrement du
  réglage. C'est la nuance par créneau qu'il a demandé à supprimer ; elle ne survit pas à la
  disparition du contrôle qui la portait.
- **Le réalignement peut rouvrir un partage que l'utilisateur avait fermé** : il *crée* aussi les lignes manquantes. Un créneau
  qu'un compte avait mis à « Ne pas partager » pour un groupe donné (absence de ligne) redevient visible pour ce groupe, au niveau du
  réglage, au premier enregistrement du réglage global quand il n'est pas `none`. La décision 5 le prévoit (« en créant celles qui
  manquent ») ; c'est le prix de « un seul réglage, qui s'applique à tout ». Passer ensuite à `none` masque de nouveau, sans perte.
- **Le flux iCal reste plus bavard que le réglage** : il porte les détails du propriétaire, par
  construction. Le libellé de l'interface le prend en compte en nommant « les membres de mes
  groupes » et non « les autres ».

## Ce que la vérification automatique ne couvre pas

À faire à la main avant d'annoncer la fonctionnalité, avec deux comptes dans un même groupe :

1. régler `busy`, et constater depuis l'autre compte que l'agenda de groupe n'affiche **aucun**
   titre, lieu ni description — ni dans la vue mois, ni dans la vue liste, ni dans une infobulle ;
2. régler `none`, et constater que les créneaux disparaissent complètement de la vue de l'autre ;
3. régler `details`, et constater que les créneaux **importés** restent sans titre alors que les
   créneaux saisis à la main en portent un ;
4. vérifier que son propre flux iCal, dans l'application de calendrier du téléphone, continue
   d'afficher ses titres quel que soit le réglage.

Le lot 5 a montré qu'aucun test automatique n'aurait trouvé le bug `webcal://` ; le point 1 est de
la même famille — une fuite de titre peut venir d'un composant d'affichage, pas de la requête.

## Alternatives écartées

- **Réécrire les lignes de `personal_event_shares` à chaque synchronisation, sans plafond à la
  lecture.** Écartée par l'orchestrateur, et à juste titre : la garantie reposerait alors sur
  l'exhaustivité d'une réécriture. Toute ligne oubliée — nouveau chemin d'import, transaction
  interrompue, créneau créé par un code futur — serait une fuite silencieuse. Un plafond à la
  lecture, lui, n'a rien à oublier.
- **Supprimer `personal_event_shares` et ne garder qu'un réglage global.** Ce serait démolir le
  modèle par groupe que l'ADR-0013 déclare stable, perdre la possibilité de « pas partagé avec ce
  groupe-là », et imposer une migration destructive. Le plafond obtient le même résultat visible
  sans rien détruire.
- **Faire du réglage de compte un remplacement et non un minimum** (le réglage dicte, la ligne ne
  compte plus que par sa présence). Plus simple à expliquer, mais `personal_event_shares.visibility`
  deviendrait une colonne sans signification, les deux déclencheurs de `0004` décoratifs, et la
  défense en profondeur disparaîtrait : une erreur sur le réglage exposerait directement les titres.
  Le minimum conserve deux barrières indépendantes.
- **Appliquer le plafond dans le service plutôt qu'en SQL.** Un filtrage en TypeScript après lecture
  violerait l'invariant de l'ADR-0013 §2 : les titres auraient quitté SQLite. Et rien n'obligerait un
  futur appelant à passer par ce service.
- **Vider les colonnes de texte en base quand le réglage passe à `busy`.** Irréversible, et elle
  punirait le propriétaire d'avoir restreint ses amis — exactement l'erreur corrigée par la révision
  du 2026-11-18 de l'ADR-0013.
