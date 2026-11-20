# ADR-0014 — Le contexte de groupe et le flux temps réel unique

- **Date** : 2026-11-20
- **Statut** : Acceptée (phase 2 de l'audit UI/UX, point 4)
- **Décidé par** : l'`architecte`, sur brief de l'orchestrateur ; implémenté par le `dev`, relu par le `reviewer`

## Contexte

L'audit `docs/audits/2026-11-18-ui-ux-frontend.md` relève deux symptômes qui n'en font qu'un.

D'abord le **saut de titre**. `EnteteGroupe` n'évite sa propre requête que si on lui passe à la fois `nomGroupe` et
`photosActives` ; sur douze de ses quinze montages, personne ne les passait. Chaque page de groupe affichait donc « Groupe »,
puis le vrai nom une fois la réponse arrivée, et l'onglet « Photos » apparaissait en retard. Pire, la ligne qui lisait le
groupe avalait son erreur (`.catch(() => undefined)`) : une panne de cette requête était invisible.

Ensuite le **plafond de connexions**. `GET /api/groupes/:groupId` était appelé depuis onze endroits, et `useTempsReel`
ouvrait un `EventSource` **par appel du hook**, sans partage : une page d'événement en ouvrait deux à elle seule. Le plafond
serveur étant de 8 flux par compte (ADR-0011, décision 4), quatre onglets d'événement suffisaient à déclencher le 429
`flux.trop_de_connexions`. Le symptôme aurait été attribué au serveur alors qu'il venait du client.

La cause commune : aucune des douze routes de groupe ne savait que les autres avaient déjà lu le même groupe.

## Décisions

1. **Un fournisseur de contexte monté dans `App.tsx`, avec `key={groupId}`.** Il enveloppe les douze routes de groupe et
   porte, pour la durée de la visite, l'unique lecture de `lireGroupe` et l'unique flux SSE. Le changement de groupe
   **démonte** le fournisseur : le flux se ferme et les données de l'ancien groupe sont jetées. Aucune donnée d'un groupe ne
   peut survivre à l'affichage d'un autre — c'est le cloisonnement obtenu par construction plutôt que par vigilance. La
   dépendance `[groupId, canal]` de l'effet est une seconde ceinture si la `key` disparaissait un jour. Les routes hors
   groupe restent dehors.

2. **Le fournisseur ne retarde pas ses enfants.** Les pages se montent tout de suite et lancent leurs lectures **en
   parallèle** de celle du groupe, puis fusionnent les deux états de lecture (`hooks/etatsLecture.ts`). Un fournisseur
   bloquant aurait été plus simple à écrire et aurait produit **deux squelettes successifs** : le sien, puis celui de la page.
   `fusionnerEtats` garde un seul squelette continu, et `premiereErreur` fait qu'une erreur de l'une ou l'autre lecture
   s'affiche. Deux pages font exception à la première entrée dans le groupe, et ne peuvent pas faire autrement : `Albums`
   a besoin de `fonctionnalites.photos` pour savoir s'il y a des albums à lire, et `Groupe` de `mon_role` pour savoir s'il
   doit lire les membres et les invitations. Leur lecture part donc après celle du groupe ; `fusionnerEtats` garde malgré
   tout un seul squelette, puisque la lecture du groupe n'est pas terminée quand la leur démarre.

3. **Un seul flux SSE par groupe, multiplexé par un objet pur.** `api/canalGroupe.ts` ne connaît ni React ni
   `EventSource` : c'est un `Set` d'abonnés et cinq fonctions. Tout ce qui fait la correction du partage est donc
   éprouvable sans navigateur, ce qui compte dans un projet qui n'a aucun outillage de test de composant. Le transport reste
   `ouvrirTempsReel`, inchangé, et avec lui la reconnexion progressive (`RETENTES_MS`), la détection du 401 et le battement
   de cœur : la brique acquise au lot 6 n'est pas réécrite, elle est appelée une fois au lieu de six.

4. **`onOuvert` est appelé à chaque (re)connexion, et aussi à un abonnement tardif.** C'est la décision la plus facile à
   casser en croyant bien faire. ADR-0011 décision 3 pose qu'il n'y a pas de rejeu : le message est un signal
   d'invalidation, et le client recharge tout à chaque `onopen`. Si le multiplexeur n'appelait `onOuvert` qu'une fois, le
   temps réel s'arrêterait **silencieusement** après la première coupure réseau — une panne invisible en développement.
   L'abonné qui s'inscrit après l'ouverture le reçoit immédiatement, sinon il attendrait le prochain message ou la prochaine
   coupure pour se synchroniser. Un abonné qui lève est journalisé, jamais avalé, et ne prive pas les autres du message.

5. **`useTempsReel` est supprimé, pas transformé en façade.** Une façade aurait gardé la signature `(groupId, rappels)`,
   donc l'illusion qu'on peut s'abonner n'importe où : appelée hors du fournisseur, elle aurait dû soit lever, soit rouvrir
   une connexion — c'est-à-dire reconstituer le bug qu'on retire. La supprimer fait **échouer la compilation** sur chaque
   site non migré. De même, `useGroupe()` lève hors du fournisseur : ce n'est pas une erreur d'exécution récupérable mais
   une faute de montage, et un repli silencieux la transformerait en page vide inexplicable.

6. **`EnteteGroupe` devient purement présentationnel**, et perd trois props : `groupId`, `nomGroupe`, `photosActives`.
   Retirer `groupId` est délibéré — le compilateur signale alors tout en-tête qu'on tenterait de monter hors d'une route de
   groupe. Le nom s'affiche dès le premier rendu grâce à `nomInitial`, que `App.tsx` tire de `moi.groupes`, déjà en mémoire.

7. **Le flux s'ouvre à l'entrée dans le groupe**, même sur une page qui n'a aucun abonné. Le coût est un flux au repos et son
   battement de 25 s. L'alternative — ouvrir à la première inscription, fermer à la dernière désinscription — ferait
   **battre** la connexion à chaque navigation interne, puisque l'ancienne page se démonte dans le même commit que la
   nouvelle se monte : le compte d'abonnés passerait transitoirement à zéro. Une connexion par onglet reste, dans tous les
   cas, inférieure ou égale à l'existant.

## Conséquences

- Onze lectures de `lireGroupe` deviennent une par entrée dans un groupe, et zéro lors d'une navigation interne. Six flux SSE
  deviennent un par onglet. La marge sous le plafond de 8 double de fait sur les pages d'événement.
- Chaque abonné reçoit **tous** les messages du groupe et filtre lui-même. Ce n'est pas nouveau : chaque flux d'avant était
  déjà par groupe et portait déjà tous ses messages. Mais les six filtres sont désormais les seuls garde-fous, et ils ont été
  recopiés à l'identique, caractère par caractère : un filtre « simplifié » au passage ferait recharger une page sur des
  événements qui ne la concernent pas, ou — pire — cesser de recharger.
- C'est le **premier contexte React du projet**. Il y en a un, il porte le groupe courant, et il n'y a pas de second hook
  « groupe chargé garanti » : `groupe` est `DetailGroupe | null`, à lire sous garde. Une seule porte d'entrée, comme pour
  `useLecture`.
- `fusionnerEtats` et `creerCanalGroupe` sont testés unitairement (`app/tests/unite/etats-lecture.test.ts`,
  `canal-groupe.test.ts`). Le reste — nombre de connexions dans l'onglet Réseau, absence de clignotement, squelette unique,
  reprise après coupure — n'est vérifiable qu'à la main, faute d'outillage de test de composant.

## Le cloisonnement n'est pas affaibli

Le contexte ne contient que ce que `GET /api/groupes/:groupId` a déjà rendu **pour ce groupe et pour ce compte**, cloisonné
côté serveur. Il est détruit avec son fournisseur au changement de groupe, n'introduit aucun cache inter-groupes, toutes les
routes continuent de recevoir leur `groupId` explicite, et le flux reste indexé par groupe côté serveur avec sa
revérification d'appartenance avant chaque envoi (ADR-0011, décision 1). Aucun filtre n'est retiré ni déplacé.

## Alternatives écartées

- **Un registre de connexions au niveau du module, avec comptage de références.** Pas de contexte à monter, mais un état
  global indexé par groupe — donc une structure de plus où se tromper de groupe, exactement ce qu'ADR-0011 décision 2 évite
  côté serveur. Et le comptage de références ramène le battement de connexion décrit en décision 7.
- **Un fournisseur bloquant**, qui n'affiche ses enfants qu'une fois le groupe lu. Plus court de dix lignes, et deux
  squelettes successifs sur chaque page : c'est l'inverse du défaut qu'on corrige.
- **Un cache de groupe dans `api/groupes.ts`.** Le plus petit changement possible, et le pire : un cache dont rien ne garantit
  l'invalidation au changement de groupe, c'est-à-dire la seule chose qu'on ne veut pas risquer ici.
- **Faire porter `fonctionnalites.photos` par `GET /api/moi`**, pour que l'onglet Photos ne manque jamais au premier rendu.
  C'est une modification serveur ; elle reste possible plus tard. En attendant, l'onglet apparaît une fois par entrée dans le
  groupe, et il est absent plutôt qu'affiché à faux.
