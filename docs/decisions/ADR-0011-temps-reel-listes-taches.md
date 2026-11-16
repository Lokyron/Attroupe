# ADR-0011 — Le flux temps réel, les listes de courses et les tâches

- **Date** : 2026-11-16
- **Statut** : Acceptée (lot 6)
- **Décidé par** : le `dev`, à partir du brief de l'orchestrateur ; à relire en revue

## Contexte

Le lot 6 apporte le critère de réussite n° 3 (« trois personnes cochent en même temps sur trois téléphones et voient les
changements sans recharger »). Il introduit deux choses qu'aucun lot n'avait : une **connexion qui reste ouverte des heures**
(le flux SSE, architecture §3.2) et des **écritures qui se disputent** (preneur d'un article, case cochée).

Toutes les routes précédentes sont courtes : l'appartenance y est relue à chaque requête. Un flux, lui, ne la prouve qu'à
l'ouverture. Sans précaution, quelqu'un retiré du groupe continue de recevoir tout ce qui s'y passe.

## Décisions

1. **Révocation active, en trois couches indépendantes.** (a) *Revérification avant chaque envoi* : le diffuseur appelle,
   avant d'écrire à un abonné, la preuve que celui-ci a fournie à l'ouverture (`toujoursAutorise`), qui relit en base
   l'appartenance active **et** la session — session non révoquée, non échue, *compte ni suspendu ni anonymisé* (la suspension
   s'écrit sur `users` sans toucher `sessions` : c'est le verrou d'identité de l'architecture §5, à rejouer comme celui du groupe) ;
   si elle échoue, rien n'est écrit et le flux est fermé. C'est la couche qui ne
   peut pas être oubliée par une route future, puisqu'elle est dans le diffuseur et non dans les routes. (b) Le *battement de
   cœur* (25 s) passe par le même chemin : un flux révoqué se ferme au battement suivant même s'il ne se passe rien.
   (c) *Fermeture immédiate* quand l'appartenance change par l'API (`retirerMembre`, `quitter`) : `fermerMembre`. Un changement
   de rôle ne ferme rien (le message ne dépend pas du rôle). En cas d'exception pendant la vérification : on ferme.
2. **Message minimal, jamais l'objet métier.** `{ type, ressource, id, parent_id, par, at }`. Le client recharge ce qu'il a le
   droit de voir par les routes, qui passent par le scope. Ainsi, même une indexation fausse du registre de diffusion ne
   ferait fuir que des identifiants, jamais un libellé. Le lot 10 ajoute `message.*` (`ressource: 'message'`, `parent_id` = le
   fil) sans changer ce contrat.
3. **Pas de reprise par `Last-Event-ID`.** Le message est un signal d'invalidation ; le client recharge tout à chaque (re)connexion
   (`onopen`). Un tampon de rejeu serait une seconde structure en mémoire indexée par groupe, donc une seconde occasion de
   se tromper de groupe, pour un bénéfice nul. Aucun `id:` n'est émis (un compteur global ou par groupe révélerait en outre
   l'activité des autres groupes).
4. **Plafond de connexions par compte : 8, refus par 429** (et non éviction de la plus ancienne). Évincer ferait boucler deux
   onglets l'un contre l'autre via la reconnexion automatique d'`EventSource`. `EventSource` ne retente pas sur un statut
   d'erreur : le client rouvre lui-même, avec un délai croissant. `setKeepAlive` sur le socket pour que les connexions mortes
   (demi-ouvertes) soient détectées.
5. **Transactions en `BEGIN IMMEDIATE`** (`db/sql.ts`, `executerEnTransaction`). Un test avec de **vrais processus** sur le même
   fichier a montré qu'avec le `BEGIN` différé, une transaction qui lit puis écrit échoue aussitôt en `SQLITE_BUSY` /
   `SQLITE_BUSY_SNAPSHOT` quand un autre processus a écrit entre-temps, sans que `busy_timeout` joue. Inoffensif avec un seul
   processus (better-sqlite3 est synchrone), mais c'est exactement ce qu'un second processus (sauvegarde, démarrage concurrent)
   déclencherait.
6. **Écritures conditionnelles.** `modifier` / `modifierPar` du scope acceptent des `conditions` (liées, combinées par ET) :
   `UPDATE … WHERE … AND claimed_by_membership_id IS NULL`. La base tranche ; `false` veut dire « course perdue ». Le preneur
   et la case cochée s'écrivent ainsi, jamais « je lis puis j'écris ».
7. **Réordonnancement par voisin.** `PATCH` d'un article avec `after_item_id` (`null` = en tête) : la position devient le milieu
   (entier) des deux voisines, une seule ligne écrite. L'écart initial est de 1024 ; la liste n'est renumérotée que quand il
   n'en reste plus (dix insertions au même endroit). Ordre de lecture : `position`, puis `id` — une collision ne perd rien et
   ne rend pas l'ordre non déterministe.
8. **Réassignation d'une tâche.** Une tâche libre : tout membre actif l'assigne (à soi ou à un autre). Une tâche assignée à
   quelqu'un d'autre : seuls l'assigné actuel, l'auteur de la tâche ou un administrateur la changent ; sinon **403**
   `droit.assignation_requise`. L'écriture est conditionnelle à l'assigné vu : une course perdue donne 409
   `tache.deja_assignee`.
9. **Plafonds.** 8 flux par compte, et un plafond **global** (`ATTROUPE_SSE_MAX_CONNECTIONS`, 200 par défaut) : l'inscription est ouverte,
   N comptes ouvriraient 8×N flux. Après `fermerTout` (arrêt), plus aucune ouverture. 500 articles au plus par liste (409
   `liste.pleine`).
10. **Un article pris par un membre qui a quitté le groupe est libre.** « Finalement non » ne retire que son propre marquage, *sauf* si
   le preneur n'est plus un membre actif : tout membre peut alors libérer ou reprendre l'article (vérifié dans la même transaction,
   écrit sous la condition « toujours à ce preneur-là »). Choisi plutôt que de libérer les marquages dans `retirerMembre` / `quitter` :
   la règle tient aussi pour un retrait écrit autrement qu'en passant par ces deux fonctions.
11. **Suppression d'une liste = cascade logique** : la liste et ses articles reçoivent `deleted_at` dans la même transaction, et
   toute route d'article résout d'abord la liste.

## À retenir pour le lot 10

Ce flux est **par groupe**. Les **notifications sont par compte** (`notifications`, portée utilisateur) et ne doivent **jamais** passer
par lui : un compte qui appartient à plusieurs groupes recevrait, dans le flux de l'un, la notification de l'autre. Les messages de
discussion (`message.*`) peuvent y passer, parce que le modèle ne prévoit aucun fil privé : tout fil appartient à un groupe et se lit par
tous ses membres. Le jour où un fil restreint à certains membres existera, ce contrat de diffusion devra changer.

## Conséquences

- `Contexte.diffuseur` (créé par `index.ts`, qui le ferme à l'arrêt : sinon `server.close()` attendrait indéfiniment).
- `http/middleware/appartenance.ts` exporte `appartenanceActive` : le seul autre endroit, avec `exigerAppartenance`, qui
  fabrique un scope pour prouver l'appartenance.
- Registre de cloisonnement : champ `flux` (route à réponse ininterrompue, ouverte par un vrai socket puis coupée) et trois
  ressources (`liste`, `article`, `tache`). Les routes du lot sont attaquées aussi par une simple membre (Erin), pas seulement
  par des administratrices.
- Aucune ligne ajoutée à `TEXTES_TRANSVERSES` ni à `ACCES_ALTERNATIFS`.
