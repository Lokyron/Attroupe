# 00 — Vision — Attroupe

> État : premier brief recueilli le 2026-11-15. Les points marqués **(à trancher)** attendent
> une réponse avant qu'on écrive du code.

## Le problème

Un groupe d'amis s'organise aujourd'hui dans une bouillie de canaux : un groupe WhatsApp pour
décider d'une date, une note partagée pour les courses, un album photo que personne ne retrouve,
et un agenda que chacun tient dans son coin. Résultat : les soirées se décident mal, on achète
trois fois les mêmes chips, et les photos de la dernière sortie restent sur trois téléphones.

Les applications grand public qui résolvent ça — **FamilyWall**, **Cozi** — sont pensées
*famille* (parents, enfants, école, courses du foyer), fermées, et hébergées chez l'éditeur.
Côté libre, **OpenFamily** (AGPL, auto-hébergeable) couvre le même terrain familial : listes,
tâches, agenda, recettes, menus, budget du foyer.

Il n'existe pas d'équivalent orienté **bande de potes**, où l'unité de base n'est pas le foyer
mais le groupe d'amis, et l'objet central pas « la semaine de la famille » mais **la soirée ou
la sortie qu'on monte ensemble**.

## Le nom

**Attroupe** — de « s'attrouper ». Un verbe comme nom, parce qu'il dit l'action plutôt que
l'ambiance : il couvre aussi bien une rando qu'une soirée. Nom de code interne et clin d'œil
dans l'interface : **ACB** (« App des Culs Brisés », le groupe d'origine).

Choisi pour sa disponibilité, vérifiée le 2026-11-15 : `attroupe.fr`, `attroupe.com` et
`attroupe.io` libres, aucun dépôt GitHub de ce nom, aucun compte `github.com/attroupe`, aucune
application dans les boutiques, aucun site vivant.

Deux noms écartés avant lui : **Rameute**, abandonné parce qu'un site intitulé « Rameute »
existe déjà (`rameute.fr`, enregistré le 22 octobre 2026, et `rameute.com` le 12 novembre
2026) ; **Sauterie**, **Chahut** et **Boucan**, écartés pour leur registre ou leurs noms déjà
occupés sur GitHub.

Restent à vérifier à la main avant la première publication : les bases de marques INPI et
EUIPO (classes 9, 38 et 42), qui ne sont pas consultables automatiquement.

## Ce que l'application fait

Elle réunit en un seul endroit ce dont un groupe d'amis a besoin pour se voir : un **planning
commun** (plus un agenda personnel), les **soirées et sorties** qu'on planifie à plusieurs avec
leur **liste de courses où chacun coche ce qu'il apporte**, le **partage des dépenses** qui
suit, et les **albums photos** qui en restent après.

Chaque projet du groupe — une soirée, un week-end, une idée en l'air — a son **propre fil de
discussion** : on ne mélange plus la préparation du nouvel an avec celle du match de samedi.

## Principe directeur — ne pas perturber les habitudes

C'est la contrainte la plus structurante : **personne ne va changer sa façon de se servir de son
téléphone pour une app de groupe.** Donc l'application se branche sur ce qui existe déjà au lieu
de demander qu'on vienne chez elle :

- le planning commun s'**abonne** depuis le calendrier natif du téléphone (iCal/CalDAV) : les
  soirées apparaissent dans l'agenda que la personne consulte déjà ;
- les photos vivent dans **Immich** (l'alternative libre à Google Photos), qui tourne **à
  part** et que chaque groupe branche par API : on garde l'app photo qu'on utilise déjà au
  quotidien, et les albums des soirées se construisent dedans ;
- les notifications passent par les canaux déjà utilisés (push navigateur, e-mail, et
  éventuellement un bot de messagerie) ;
- l'app s'installe en **PWA** : pas de passage par un store.

## Ce qu'elle ne fait pas

- Pas une messagerie : on ne remplace pas le groupe WhatsApp/Signal, on s'y greffe.
- Pas un réseau social ouvert : l'accès se fait sur invitation, il n'y a pas de découverte
  d'inconnus, pas de flux algorithmique.
- Pas une app de gestion de foyer : pas de suivi scolaire, pas de corvées du ménage, pas de
  budget familial mensuel.
- Pas de dépendance à un service en ligne payant pour fonctionner.

## Utilisateurs et rôles

| Rôle | Ce qu'il peut faire |
|---|---|
| **Membre** | Voir le groupe, créer des événements, proposer des idées, cocher ce qu'il apporte, déposer des photos |
| **Organisateur** d'un événement | Modifier son événement, sa liste de courses, clôturer les comptes |
| **Administrateur du groupe** | Inviter et retirer des membres de *son* groupe, le renommer, le supprimer |
| **Administrateur de l'instance** | Exploitation : comptes, quotas, sauvegardes, mises à jour. Ne voit pas le contenu des groupes |

**Décidé** : l'instance héberge **plusieurs groupes indépendants et étanches**. Chacun crée son
groupe, y invite ses amis, et ne voit rien des autres. Une même personne peut appartenir à
plusieurs groupes (la bande, les collègues, la coloc) et bascule de l'un à l'autre.
Voir [`ADR-0002`](../docs/decisions/ADR-0002-multi-groupes.md).

## Critères de réussite

La v1 est bonne si, pour une vraie soirée du groupe :
1. la date s'est décidée dans l'app (sondage → événement) plutôt que dans le fil de discussion ;
2. l'événement est apparu tout seul dans le calendrier du téléphone de chacun ;
3. la liste de courses a été remplie et cochée par au moins trois personnes différentes ;
4. les photos du soir se sont retrouvées dans le bon album sans que personne n'ouvre l'app pour
   les y mettre ;
5. trois mois après, le groupe s'en sert encore.

## Contraintes

- **Auto-hébergement** sur le **homelab** (PVE personnel) : conteneur **112**
  (`10.1.20.112`) pour la production, conteneur **113** (`10.1.20.113`), identique, pour la
  pré-production sur l'image `beta`. Les projets Cazalia n'ont rien à voir avec celui-ci.
- **Installation par une seule commande Docker**, et image publiée pour que d'autres puissent
  l'installer.
- **Mise à jour à la main**, volontairement : pas de bouton dans l'interface. Les images sont
  construites par l'intégration continue à chaque poussée, et la mise à jour se fait par un
  `docker compose pull && up -d` lancé par l'administrateur. Deux canaux, deux branches, deux
  piles : `main` → production, `beta` → pré-production.
- **Dépôt GitHub public dès le départ** : aucune donnée, aucun secret, aucune photo dans le
  dépôt. Licence **AGPL-3.0**. Les images sont construites par l'intégration continue et
  publiées sur **GHCR** (`ghcr.io/lokyron/attroupe`), étiquetées `latest` et `beta` : le serveur
  ne compile rien.
- **Vie privée** : des photos de personnes identifiables et des agendas personnels, hébergés
  chez un particulier. Pas de tracking, pas d'analytics tiers, chiffrement en transit, et une
  politique de suppression claire.
- **Mobile d'abord** : tout se consultera depuis un téléphone, debout, dans un bar.
- **Interface en français**, textes sortis du code dans un fichier de traduction pour qu'une
  autre langue reste possible sans tout reprendre.
- **Accès par Internet**, derrière le Nginx Proxy Manager existant, sur un sous-domaine
  **(à trancher)**.
- **Inscription ouverte** : n'importe qui crée son compte et son groupe. Un membre existant
  s'ajoute à un autre groupe par son nom d'utilisateur ou son e-mail, sans recréer de compte —
  l'ajout crée une **invitation qu'il accepte**, jamais une adhésion d'office.
- **Aucun flux bancaire.** Les dépenses sont suivies et réparties dans l'application ; les
  remboursements se font exclusivement en dehors.
- **Plusieurs devises** : le groupe part parfois en voyage.
- **E-mails** envoyés via **Brevo** (compte personnel dédié à ce projet).
