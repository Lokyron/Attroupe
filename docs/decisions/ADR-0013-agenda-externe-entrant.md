# ADR-0013 — Synchronisation entrante des agendas personnels externes

- **Statut** : acceptée
- **Date** : 2026-11-18
- **Concerne** : `personal_events`, `calendar_sources`, `services/agenda-externe.ts`, `domain/ics-entrant.ts`

## Contexte

L'agenda personnel d'Attroupe se remplit à la main : on saisit ses indisponibilités une par une,
et on choisit, groupe par groupe, ce qui en est visible (`none`, `busy`, `details`). Le modèle de
partage est donc déjà en place et ne bouge pas.

Ce qui manque, c'est l'alimentation automatique : un utilisateur veut que son agenda externe
(Google Agenda, Outlook) remplisse ses indisponibilités tout seul, **sans montrer à ses amis ce
qu'il fait** — seulement qu'il est occupé.

Trois briques existantes déterminent la solution :

- `listerDisponibilitesGroupe` (`db/queries/agenda-personnel.ts`) lit les créneaux pour un groupe en
  **deux requêtes distinctes**, dont celle de `busy` ne sélectionne jamais `title`, `description` ni
  `location_name`. C'est la seule requête du projet dont une erreur serait une fuite entre groupes.
- La synchronisation **sortante** existe déjà (ADR-0010, `http/routes/ical.ts`) et publie les
  créneaux personnels dans le flux iCal auquel l'utilisateur abonne son téléphone.
- `services/requete-epinglee.ts` est le **seul** module autorisé à émettre une requête vers une URL
  fournie par un utilisateur. `DOCUMENTATION.md` §7 précise que la tolérance d'adresse privée
  accordée à Immich « ne vaut pas pour une URL choisie par le client ».

## Décision

### 1. Abonnement à une URL ICS distante, récupérée par le serveur

L'utilisateur colle l'URL ICS de son agenda. Le serveur la récupère périodiquement.
`webcal://` est accepté en saisie et normalisé en `https://`.

**Limite connue, à afficher dans l'interface : les agendas iCloud ne sont pas utilisables.**
Apple ne propose aucune URL privée — seulement un « calendrier public », lisible par quiconque
possède le lien, détails compris. Demander ça pour afficher « occupé » à trois amis serait l'inverse
du but recherché. Les utilisateurs iPhone dont l'agenda est sur iCloud gardent la saisie manuelle,
ou passent par Google Agenda. Ce point est écrit dans l'interface **avant** le champ d'URL, pas dans
une note de bas de page.

| Fournisseur | URL privée | Parcours |
|---|---|---|
| Google Agenda | oui | Paramètres → l'agenda → Intégrer l'agenda → « Adresse secrète au format iCal ». Ordinateur seulement. |
| Outlook / M365 | oui | Calendrier → Calendriers partagés → Publier → droit **« Afficher uniquement ma disponibilité »**. Le seul fournisseur qui garantit la confidentialité à la source. |
| iCloud | **non** | Sans objet : seul le calendrier public existe. |

*Écarté — dépôt manuel d'un fichier `.ics`* : une photographie périmée dès le lendemain, alors que
la saisie manuelle couvre déjà le cas ponctuel. Reporté, pas refusé : l'analyseur étant un module
pur, l'ajouter coûtera une route et un formulaire — et ce serait la seule porte privée pour iCloud.

*Écarté — CalDAV* : OAuth2 chez Google, mot de passe d'application Apple chez iCloud (nous rendant
dépositaires d'un identifiant bien plus large qu'un calendrier), plus un client WebDAV/XML à écrire.
Cohérent avec l'ADR-0010, qui l'avait déjà écarté en sortie.

### 2. Les créneaux importés n'ont aucun texte, et `details` est impossible

Pas « refusé par défaut » : **impossible**, et garanti par la base, pas par le code applicatif.

1. Un créneau importé a `title = ''`, `description IS NULL`, `location_name IS NULL`. Une contrainte
   `CHECK` portée par la colonne `calendar_source_id` l'impose, à l'insertion **et** à la
   modification après coup.
2. Deux déclencheurs refusent `personal_event_shares.visibility = 'details'` sur un créneau importé,
   en insertion comme en mise à jour.
3. `definirPartagesCreneau` renvoie un 409 `agenda.import_sans_details` plutôt qu'une erreur SQLite.

**Piège associé** : `creerCreneauPersonnel` recopie `memberships.default_personal_visibility`. Un
membre ayant réglé `details` pour un groupe verrait l'import échouer en entier. L'import **écrase
donc `details` en `busy`** au moment d'écrire le partage — ramène-au-sûr explicite, testé nommément.

### 3. On ne stocke que les plages horaires

Ni titre, ni description, ni lieu, **ni `UID`** (les `UID` iCalendar contiennent parfois l'adresse
e-mail de l'organisateur ; la stratégie de remplacement intégral les rend inutiles).

L'utilité serait quasi nulle — l'utilisateur voit déjà le détail dans son téléphone, et le rôle
d'Attroupe est de dire « occupé » à ses amis. Le risque, lui, serait permanent : une donnée intime
stockée fuit un jour par une sauvegarde, une page d'exploitation, un réglage mal compris ou un bug
dans l'une des deux requêtes de `listerDisponibilitesGroupe`. *« La colonne n'est jamais écrite »*
est une garantie d'une autre nature que *« la requête ne la sélectionne pas »*.

Les plages qui se chevauchent ou sont espacées de moins de 15 minutes sont **fusionnées** : le
découpage d'une journée est lui-même une information (« il a huit réunions mardi »). Les journées
entières et les créneaux horodatés restent deux familles distinctes, jamais fusionnées entre elles.

### 4. Récupération

- **Horizon** : de J−7 à J+180. Le passé ancien est inutile, et l'horizon borne l'expansion des
  récurrences.
- **Fréquence** : toutes les 2 h par source, en requête conditionnelle (`If-None-Match` /
  `If-Modified-Since`) — la plupart des tours sont donc un 304 sans écriture. Plus un bouton
  « Synchroniser maintenant » (1 fois par 5 min), et une synchronisation **immédiate à la création**,
  seul moyen de valider l'URL et d'annoncer « 127 créneaux importés » ou « injoignable ».
- **Stratégie** : remplacement intégral par source, en une transaction. Pas de `UID`, pas de diff,
  et la suppression d'un événement sur le téléphone se propage gratuitement.
- **Échec** : on **conserve** les créneaux déjà importés (une panne de Google ne doit pas faire
  paraître l'utilisateur libre), recul exponentiel `2 h × 2^(n−1)` plafonné à 24 h, désactivation
  après 10 échecs — ou après 3 si le code est 401/403/404/410, qui signifie une URL révoquée.
- **Plafonds** : 5 sources par compte ; par synchronisation, 1 Mio téléchargés (compteur d'octets
  réel, le `Content-Length` n'est pas cru), 5 000 `VEVENT`, 1 000 occurrences par règle, 2 000 plages
  écrites, 5 s d'analyse, 10 s d'inactivité réseau, 20 s au total.

### 5. Modèle de données

Réutilisation de `personal_events` avec une colonne `calendar_source_id` (NULL = saisi à la main).
Une table séparée obligerait à **dupliquer `listerDisponibilitesGroupe`**, c'est-à-dire à doubler la
surface du risque numéro un du projet. Bénéfice secondaire : les contraintes horaires existantes de
`personal_events` s'appliquent gratuitement aux données importées.

Migration `app/migrations/0004_agenda_externe.sql`. Déclarations obligatoires :
`calendar_sources: 'user_id'` dans `PORTEE_TABLES` (sans quoi le verrou de cloisonnement ignore
purement et simplement la table), le sélecteur de la tâche de fond dans `TEXTES_TRANSVERSES`, et la
table dans `portee-utilisateur.ts`.

**Boucle de rétroaction à casser** : `CORPS_ENSEMBLE_PERSONNEL` (`db/queries/flux.ts`) doit exclure
`calendar_source_id IS NOT NULL`. Sans cette ligne, les créneaux importés repartiraient dans le flux
iCal sortant, et le téléphone se verrait réafficher ses propres rendez-vous en double.

### 6. Analyseur iCalendar écrit à la main

Le serveur a trois dépendances d'exécution. En ajouter une quatrième dont le seul rôle serait
d'analyser une entrée **contrôlée par un tiers hostile**, c'est placer du code non audité là où la
surface d'attaque est maximale — et il faudrait de toute façon écrire par-dessus nos propres bornes.

Le sous-ensemble nécessaire tient en ~650 lignes plus ~500 de tests, parce que l'horizon étant fini,
**on écrit un prédicat et non un générateur** : « cette date correspond-elle à la règle ? », itéré
depuis `DTSTART`. Un prédicat est plus facile à écrire juste, et surtout à tester exhaustivement.
`VTIMEZONE` n'est pas interprété du tout.

Toute règle de récurrence qu'on ne comprend pas **en entier** (`BYSETPOS`, `BYWEEKNO`, `BYYEARDAY`,
`BYHOUR`) est ignorée **et comptée** : on n'invente jamais une occupation, et on ne masque jamais en
silence une occupation qu'on n'a pas su lire. L'utilisateur voit « 3 événements récurrents non pris
en charge » et saisit le créneau à la main.

**Ce qui rendrait cette décision fausse**, et ouvrirait une ADR-0014 pour prendre `ical.js` :
les `TZID` Windows d'Outlook se révèlent majoritaires et le repli produit des décalages inacceptables ;
ou la mise en œuvre dépasse ~800 lignes ; ou l'on décide d'importer aussi vers l'agenda **du groupe**,
où un décalage d'une heure cesse d'être une gêne pour devenir une erreur de données.

### 7. Sécurité

`resoudreEtVerifier` puis `envoyerEpingle`, avec `autoriserPrive: false` **en dur** — sans variable
d'environnement pour l'assouplir, puisque l'URL est choisie par n'importe quel compte. En amont :
`https` seul, **port 443 seul**, ni identifiant ni mot de passe dans l'URL. Aucune redirection n'est
suivie. `Accept-Encoding: identity`, donc aucune décompression n'est écrite nulle part et une bombe
de décompression arriverait comme des octets illisibles.

**Aucune seconde implémentation de requête sortante ne doit être écrite.** C'est par là qu'une SSRF
est revenue dans ce projet.

Une réponse précise à la création n'est pas un oracle SSRF, contrairement à `POST /api/moi/push/test`
volontairement muet : ici `resoudreEtVerifier` refuse toute adresse privée ou réservée **avant** la
connexion, il ne reste donc rien d'interne à sonder, et l'erreur ne renseigne que sur l'Internet
public, qui n'est pas un secret.

L'URL est **chiffrée au repos** (AES-256-GCM, `ATTROUPE_ENCRYPTION_KEY`) comme la clé d'API Immich et
la clé privée VAPID : l'« adresse secrète » de Google donne accès au calendrier complet, détails
compris. Elle ne ressort jamais par l'API — la liste ne rend que `url_host`.

## Conséquences

- Un agenda iCloud n'est pas importable. C'est une limite du fournisseur, pas de l'application, et
  elle doit être dite à l'utilisateur **avant** qu'il cherche son URL.
- La propagation entrante se compte en heures : notre latence est de 2 h au plus, mais celle du
  fournisseur s'y ajoute — Google publie son propre ICS avec parfois plusieurs heures de retard.
  Ce n'est pas un défaut de notre code, c'est le symétrique de ce qui est déjà constaté en sortie.
- Un `TZID` non IANA peut produire un décalage d'une heure. Tolérable parce qu'on ne publie que de
  l'« occupé » ; ce ne le serait pas pour l'agenda d'un groupe.
- Le déclencheur de suppression douce bloquerait un futur `DELETE` de compte sur `personal_events` :
  à traiter le jour où une suppression de compte sera écrite.
- Si `ATTROUPE_ENCRYPTION_KEY` change, les URL deviennent illisibles : source désactivée avec
  `last_status = 'cle_illisible'`, reprise manuelle. Même situation que la configuration push.

## Vérification à la main, non négociable

Le lot 5 a démontré qu'aucun test automatique n'aurait trouvé le bug `webcal://`. Avant d'annoncer
la fonctionnalité : une URL secrète Google produit bien des créneaux ; un événement ajouté sur le
téléphone apparaît au tour suivant ; un événement supprimé disparaît ; et **un ami du groupe voit
« occupé » sans aucun titre**.
