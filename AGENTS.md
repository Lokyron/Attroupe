# Attroupe — consignes pour tout agent de code

> Ce fichier s'adresse à **n'importe quel assistant de code** qui travaille sur ce dépôt :
> Antigravity, Gemini, Codex, Cursor, ou Claude Code hors de sa propre configuration.
> Claude Code lit en plus [`CLAUDE.md`](CLAUDE.md) (mêmes règles, plus son système de
> sous-agents). En cas de contradiction entre les deux, **ce fichier et `CLAUDE.md` disent la
> même chose** : si ce n'est pas le cas, c'est un bug de documentation, signale-le.

Le projet change de main : le propriétaire alterne entre plusieurs assistants selon ses limites
d'usage. Tu reprends donc un travail commencé par un autre, et un autre reprendra le tien. Les
trois sections suivantes existent pour que cette couture ne coûte rien.

## 1. Les deux règles qui ne se discutent pas

1. **Cloisonnement des groupes.** Chaque table métier porte son groupe, et **chaque** requête
   filtre dessus. Un filtre oublié est une fuite de données entre groupes — le pire incident
   possible pour ce produit. Le dispositif n'est pas la discipline : ce sont cinq verrous
   décrits dans [`docs/decisions/ADR-0006`](docs/decisions/ADR-0006-cloisonnement-structurel.md),
   dont deux font échouer la compilation et un l'écriture en base. Toute route porte un test qui
   prouve qu'un membre du groupe A ne peut ni lire ni écrire une ressource du groupe B, **même en
   forgeant l'identifiant**. Une route absente du registre
   (`app/tests/cloisonnement/registre.ts`) casse l'intégration continue, donc la publication.
2. **Aucun flux bancaire.** On affiche qui doit combien à qui ; les remboursements se font hors
   de l'application. Pas d'API de paiement, pas de cagnotte, pas d'IBAN stocké, jamais. Un test
   (`app/tests/schema/pas-de-bancaire.test.ts`) refuse jusqu'au vocabulaire en base et dans le
   code.

## 2. Lis ça avant d'écrire une ligne

| Fichier | Ce qu'il contient |
|---|---|
| [`DOCUMENTATION.md`](DOCUMENTATION.md) | Fiche de reprise : stack, arborescence, environnement, endpoints, hébergement |
| [`Dossier de conception/02 - Perimetre et jalons.md`](Dossier%20de%20conception/02%20-%20Perimetre%20et%20jalons.md) | **Ce que la V1 doit faire, et ce qu'elle ne doit pas faire.** C'est la référence : en cas de désaccord avec le menu des fonctionnalités, c'est lui qui gagne |
| [`Dossier de conception/04 - Architecture.md`](Dossier%20de%20conception/04%20-%20Architecture.md) | L'architecture, et au §4 le détail du cloisonnement |
| [`docs/decisions/`](docs/decisions/) | Une ADR par décision structurante. **Elles sont prises : ne les re-débats pas**, et n'en contredis aucune sans en écrire une nouvelle |
| [`Avancement du projet/AVANCEMENT.md`](Avancement%20du%20projet/AVANCEMENT.md) | Où on en est, et les défauts déjà rencontrés avec leur leçon |
| [`docs/audits/2026-11-18-ui-ux-frontend.md`](docs/audits/2026-11-18-ui-ux-frontend.md) | L'audit de l'interface et son plan d'action priorisé. **Les phases 1, 2, 2 bis, 2 ter et 3 sont appliquées** ; ce qui reste est listé au §9 |

## 3. Ce qui est déjà passé à travers — ne le refais pas

Les lots 7 à 12 ont été écrits sans relecture, puis audités. Voici les quatre défauts trouvés.
Ils sont corrigés ; ils sont listés ici parce que **chacun est un piège de ce projet**, pas une
étourderie isolée.

1. **Une URL fournie par le client est une primitive de requête sortante.** L'endpoint
   d'abonnement Web Push n'était validé que comme URL `http(s)`, et la route de test postait
   dessus en renvoyant le résultat : un scanner du réseau local, avec oracle de réponse,
   utilisable par n'importe quel compte, sur une instance exposée sur Internet. Le projet avait
   déjà tout le dispositif anti-SSRF, écrit pour Immich — il n'avait simplement pas été réutilisé.
   **Avant tout appel sortant vers un hôte dont l'URL vient de l'extérieur**, passe par
   `app/server/services/requete-epinglee.ts` : une seule résolution DNS, connexion épinglée sur une
   adresse déjà vérifiée, refus dès qu'une adresse résolue n'est pas autorisée, aucune redirection
   suivie. Son paramètre `autoriserPrive` est **obligatoire** — Immich le met à
   `ATTROUPE_IMMICH_ALLOW_PRIVATE`, le push à `false` en dur. **N'en écris pas une seconde
   implémentation** : ce code a déjà été dupliqué une fois, et les deux copies ont divergé.
2. **Un test vert ne prouve rien s'il ne joue pas l'attaque.** Le registre de cloisonnement
   déclarait bien la ressource `utilisateur`, et le test passait — mais dans le monde de test, un
   seul compte avait un avatar, donc le 404 venait de l'absence de photo et non de la cloison.
   La garde manquait, le test était vert. **Vérifie tes tests de cloisonnement en retirant la
   garde** : s'ils ne deviennent pas rouges, ils ne testent rien.
3. **Jamais d'addition implicite de deux devises.** La clôture d'un événement sommait des
   montants sans regarder leur code devise : 50 € puis 30 $ donnaient 8000 « USD ». Les montants
   sont des **entiers d'unités mineures** avec leur code ISO 4217, jamais des flottants, et
   `additionnerMontants` lève si les devises diffèrent — utilise-la plutôt qu'un `+`
   ([`ADR-0004`](docs/decisions/ADR-0004-depenses-devises.md)).
4. **Une assertion de recensement se met à jour avec le code.** Sept tests étaient rouges parce
   qu'ils comptaient les tables du schéma et nommaient la dernière migration : une nouvelle
   migration les périme mécaniquement. Quand tu ajoutes une migration, cherche ce qui compte ou
   nomme, et mets-le à jour dans le même changement.

5. **Un ratio de contraste se calcule sur le fond composé, jamais sur la surface nominale.**
   Quatre tokens de texte paraissaient conformes parce qu'ils avaient été mesurés sur du blanc —
   or le blanc n'existe nulle part dans l'application : les tuiles sont des dégradés posés sur
   `--surface`. Sur le vrai fond, trois d'entre eux tombaient entre 3,80 et 3,98 pour du texte de
   0,7 rem, donc sous l'AA. Mesure la couleur effectivement rendue
   ([`ADR-0015`](docs/decisions/ADR-0015-design-system-et-cible-navigateur.md)).
6. **Côté serveur, un plafond par défaut n'est pas une limite anodine.** Le tableau de bord
   appelait son API sans fenêtre de dates ; sans fenêtre, le serveur rend au plus 12 événements de
   groupe et 8 personnels **tous groupes confondus**, contre 200 avec
   (`db/queries/tableau-de-bord.ts`). Un appel qui « marche » peut tronquer en silence : lis la
   requête avant d'omettre un paramètre.
7. **Les écritures qui font bouger un solde doivent notifier.** C'était le défaut structurel du
   module dépenses : seule la création notifiait. Modifier, supprimer, créer et confirmer un
   règlement notifient désormais, par `notifierMouvementSolde` (`app/server/services/depenses.ts`).
   Toute nouvelle écriture de solde doit passer par le même chemin.

## 4. Conventions

- **Français** partout : réponses, commentaires de code, messages de commit, documentation. Les
  identifiants du code (variables, fonctions, tables) restent en anglais, sauf si le code
  existant fait l'inverse — et il le fait souvent côté serveur, où les services sont nommés en
  français. Suis le fichier dans lequel tu écris.
- **Typage strict.** Pas de `any`, pas de `as` sur une donnée qui sort de la base ou du réseau
  (valide avec Zod), pas d'erreur avalée silencieusement.
- **Pas de dépendance nouvelle** sans que ce soit demandé ou justifié par une ADR. Le Web Push,
  par exemple, est implémenté sans librairie, à la main et conformément aux RFC 8291/8292.
- **Les secrets vivent dans `.env`** (jamais versionné). `.env.example` liste **toutes** les clés
  lues par `app/server/config/env.ts`, avec des valeurs factices. Si tu ajoutes une variable,
  elle va dans les deux, et dans `DOCUMENTATION.md` §4.
- **`db/` est le seul dossier autorisé à écrire du SQL**, une règle ESLint l'impose. `db/` ne doit
  jamais appeler le réseau ni importer `services/`.
- **Les tests s'écrivent avec le code et se lancent.** Un échec se rapporte avec sa sortie.
- **Pas de seuil dupliqué entre CSS et JavaScript.** Le CSS porte le seuil (la règle `@container semaine`
  de `app/client/src/styles.css`), et le JavaScript lit son **effet** (`scroll-snap-type` via
  `getComputedStyle`, fonction `unSeulJour` de `GrilleSemaine.tsx`) au lieu de recopier la valeur. Une
  seconde copie du seuil finit toujours par diverger.
- **La feuille « Créer » a deux déclencheurs pour une seule instance.** Le bouton du bandeau du bas et celui
  de la barre latérale ouvrent la même `FeuilleCreation`. `boutonsOuvrants` (`App.tsx`) donne au focus le
  déclencheur d'origine pour le retour, et `premierVisible` (`lib/retour-focus.ts`) retient le premier visible
  si l'autre est masqué par un redimensionnement. Ne pas monter une seconde feuille pour un second bouton.

## 5. Vérifier son travail

```bash
npm run lint
npm run typecheck
npm test -- --maxWorkers=4
npm run build
```

Les quatre doivent passer : ce sont exactement les étapes de l'intégration continue, et aucune
image n'est publiée si l'une échoue.

> **La saturation des ports éphémères est corrigée (20/11/2026) — ne la réintroduis pas.** Appelé
> avec une fonction Express, `supertest` monte un vrai serveur TCP **par requête**. Le client de
> test (`app/tests/fixtures/comptes.ts`) en émettait **16 251 pour la seule suite de
> cloisonnement**, dont ~70 % pour construire les décors (123 routes au registre, 92 requêtes par
> monde) : autant de sockets laissés 30 s en `TIME_WAIT` sur les 16 384 ports éphémères de macOS
> (49152-65535). Pic mesuré **16 260 sur 16 384**, soit 2 % de marge. On obtenait des dizaines de
> faux `connect EADDRNOTAVAIL` et `listen EADDRNOTAVAIL`, variables d'une exécution à l'autre — on a
> vu 7, 43, 49, 129 et 154 échecs **pour le même code** — et trois tests sont tombés parce que
> **deux requêtes** avaient été ajoutées à un décor.
>
> `decor()` monte désormais **un seul serveur d'écoute par décor**, partagé par tous ses clients,
> fermé dans `nettoyer()`, et `Client.envoyer` le vise par son URL avec un `http.Agent` en
> `keepAlive`. **Mesure avant / après sur `app/tests/cloisonnement`, à ports drainés :
> 16 260 → 328 sockets en `TIME_WAIT` (÷ 50), et la suite passe de 24,4 s à 16,2 s.** La marge est
> passée de 2 % à 98 % : une quinzaine de routes de plus au registre ne fait plus tomber la suite.
>
> Deux pièges, documentés sur place dans `comptes.ts` — lis le commentaire avant d'y toucher :
>
> - **`maxSockets: 80` de l'agent est encadré des deux côtés.** En haut par `kern.ipc.somaxconn`,
>   qui vaut **128** sur macOS : la rafale de 384 requêtes simultanées de
>   `app/tests/integration/listes-concurrence.test.ts` déborde la file d'acceptation du serveur — que
>   better-sqlite3, synchrone, n'a pas le temps de vider — et le noyau répond par un RST, donc un
>   `ECONNRESET`. En bas par `app/tests/integration/auth-securite.test.ts` (« la file de hachage
>   pleine ne débite pas la cadence »), qui a besoin de **37 requêtes réellement en vol** —
>   `MAX_PARALLELE` 4 + `MAX_EN_ATTENTE` 32, puis une de plus (`app/server/services/mot-de-passe.ts`).
>   Sous ce seuil, l'agent les met en file côté client, le 503 attendu ne se produit jamais et **la
>   preuve devient verte sans rien prouver** ; le test en lance 80, et 80 laisse donc de la marge.
>   C'est ce seuil de 37 qu'il faut suivre, pas le nombre de requêtes du test.
> - **Le serveur est `unref`é** : un décor dont `nettoyer()` n'est pas appelé ne doit pas retenir le
>   processus de test.
>
> **En pratique, ce qui marche** : lancer les trois répertoires séparément **et espacés**. La
> référence verte au 20/11/2026 est **913 schéma + unité, 461 cloisonnement (1 ignoré),
> 456 intégration = 1 830 tests**.
>
> ```bash
> npx vitest run app/tests/schema app/tests/unite
> npx vitest run app/tests/cloisonnement
> npx vitest run app/tests/integration
> ```
>
> Ne lance **jamais** `npx vitest run` sans chemin. `--maxWorkers=1` reste l'arbitre en cas de
> doute : lent, mais son résultat ne se discute pas. Et avant de classer un échec comme « c'est
> l'environnement », vérifie `netstat -an | grep -c TIME_WAIT` : on est maintenant censé rester
> sous le millier, donc **quelques milliers de sockets sont le signe d'une régression, pas du
> décor de la machine**.

**Trois tests portent un délai explicite, et ce n'est pas un contournement.** Ils sont lents par
construction (un verrou de base de données, deux mesures de temps constant sur l'authentification)
et échouaient au délai par défaut de 5 s alors qu'ils passent seuls. Un garde-fou de sécurité qui
« échoue » par dépassement de délai est le pire des signaux : il apprend à ignorer un rouge. Le
délai est commenté sur place — ne le retire pas sans lire le commentaire
(`app/tests/cloisonnement/verrou-db.test.ts`, `app/tests/integration/auth-securite.test.ts`).

## 6. Git et déploiement

- **Branche de travail par sujet.** Jamais de commit direct sur `main` sans demande explicite.
- `main` → image `:latest` → **conteneur 112 (production)**. `beta` → image `:beta` →
  **conteneur 113 (pré-production)**. Un push sur l'une de ces deux branches **publie une image**
  ([`ADR-0005`](docs/decisions/ADR-0005-deploiement.md)) : ce n'est pas un geste anodin.
- **Le 112 n'est pas déployé** et attend le nom de domaine définitif. Ne l'active pas de ta propre
  initiative.
- Publier n'est pas déployer : le conteneur doit faire `docker compose pull && up -d`. Et une
  migration se joue au démarrage, dans un seul sens — **sauvegarde d'abord**
  (`scripts/sauvegarde.sh`, ou un snapshot du conteneur).
- Messages de commit en **français**, à l'impératif, sujet sous 72 caractères, corps qui explique
  *pourquoi*.
- **Ne commite et ne pousse que si le propriétaire le demande.**

## 7. Tenir la documentation à jour

Ce n'est pas de la politesse : c'est ce qui permet au prochain agent de ne pas refaire le même
travail. Avant de modifier l'infrastructure ou l'architecture, **lis la doc d'abord** (anti-doublon),
mets-la à jour ensuite.

| Fichier | Quand |
|---|---|
| `DOCUMENTATION.md` | Changement de stack, d'arborescence, d'environnement ou d'endpoint |
| `Dossier de conception/` | Vision, périmètre, règles métier, modèle de données |
| `Avancement du projet/AVANCEMENT.md` | À chaque jalon terminé, avec les défauts rencontrés et leur leçon |
| `docs/decisions/` | Une ADR par décision structurante (`ADR-000N-sujet.md`) |

Si tu livres une fonctionnalité qui n'était pas au périmètre, **ne laisse pas le code et le
document se contredire** : soit tu retires le code, soit tu écris une ADR qui déplace la
fonctionnalité et tu corriges le périmètre. C'est ce qui a été fait pour le push navigateur
([`ADR-0012`](docs/decisions/ADR-0012-push-navigateur.md)).

## 8. Quand quelque chose cloche

Ce projet est auto-hébergé chez son propriétaire, avec de vrais bêta-testeurs sur
`beta.attroupe.fr`. Si tu trouves une faille, une fuite entre groupes ou un flux d'argent faux :
**dis-le plutôt que de le contourner**, et ne le corrige pas en silence au milieu d'autre chose.
Un rapport n'est pas une preuve — relis le diff, lance les tests, et rapporte ce que tu as
réellement vérifié par opposition à ce que tu supposes.

## 9. Où on en est — état au 20 novembre 2026

Branche de travail : `beta`. Les trois dettes bloquantes, la phase 2 et la phase 3 de l'audit sont
**appliquées**. La phase 3 avait été annoncée comme appliquée avant vérification : deux de ses douze
points n'étaient pas faits du tout (mémoïsation, état dans l'URL) et sept l'étaient partiellement.
Ils ont été soldés depuis. Les défauts trouvés en relecture sont corrigés :
- le lien d'évitement `#contenu-principal` renvoyait à l'accueil, parce que le routeur lisait tout
  fragment comme une route (garde `estFragmentDeRoute`, `app/client/src/lib/fragment-route.ts`) ;
- des contrastes du mode sombre étaient sous le seuil AA : le trait de focus et le texte utilisaient
  `--primaire` (il faut `--primaire-trait` et `--primaire-texte-survol`) ;
- l'héritage des préférences de notification : une ligne de groupe copiait le réglage global à sa
  création puis le primait en bloc. Désormais `NULL` veut dire « hérite de `'*'` », champ par champ
  (migration `0008`).

Les contrôles (`typecheck`, `lint`, `build`, tests) sont à relancer avant toute publication ; les
chiffres de tests sont consignés dans `Avancement du projet/AVANCEMENT.md`.

**Ce qui a été livré depuis `678ec6f`** :
1. **`muted_kinds` lue dans `notifierMembresGroupe`** après le filtre SQL (`app/server/db/queries/notifications.ts`).
2. **Notifications sur les mouvements de solde** : `modifierDepenseService` (`expense_updated`),
   `supprimerDepenseService` (`expense_deleted`), `creerRemboursementService`
   (`settlement_created`) et `confirmerRemboursementService` (`settlement_confirmed`).
3. **Migration `0006_notifications_reglement.sql`** (reconstruction de `notifications` avec
   extension des `CHECK`) et **migration `0007_listes_type.sql`** (colonne `shopping_lists.kind`,
   sortie du type de liste hors du titre).
4. **Fin de la phase 2** : validation champ par champ des dépenses et règlements (`Depenses.tsx`),
   remboursements actionnables (préremplissage depuis les suggestions, mention explicite d'absence
   de flux bancaire, annulation d'un règlement non confirmé via `DELETE /api/groupes/:g/remboursements/:id`),
   paramètres et suppression de groupe (`PATCH`/`DELETE /api/groupes/:g`), et pagination/bornage
   des listes (`Depenses.tsx`, `Agenda.tsx`, `GrilleMois.tsx`, `Compte.tsx`, `Notifications.tsx`).

**Phase 3 appliquée** :
- **Mode sombre** (`prefers-color-scheme: dark` dans `styles.css`, avec redéfinition du bloc
  `@supports` des voiles photo et `<meta name="theme-color" media="...">` dans `index.html`).
- **Accessibilité structurelle & routage** (`App.tsx`) : lien d'évitement `#contenu-principal`,
  `<h1>` unique sur mobile et bureau, trois `<nav>` aux libellés distincts, `document.title`
  par route, remise à zéro du scroll et déplacement du focus au `hashchange`, route
  `introuvable`, et lien code source AGPL-3.0 dans le pied de page.
- **Responsive tablette** (`styles.css`) : `.barre-kpis` en 4 colonnes dès 768 px,
  `.grille-bento-groupe` à 1280 px, et `.nav-mobile` bornée entre 640 px et 1023 px.
- **Finitions** : `<ChampFuseau>` (`<input list>` + `<datalist>` `Intl.supportedValuesOf('timeZone')`)
  partout, `lib/liens.ts` (suppression de la dépendance de `TachesEvenement` vers `pages/Listes`),
  bouton « Créer l’album de la soirée » sur `Evenement.tsx`, note `service_email === 'non_configure'`
  dans `Groupe.tsx`, et indicateur de reconnexion SSE silencieux à l'ouverture dans `Liste.tsx`.

**Deux points qui appartiennent au propriétaire, pas à toi** : le refus d'invitation (aujourd'hui
« Mettre de côté » oublie le lien sur l'appareil, rien de plus ; un vrai refus demande une route
serveur, et il n'est pas tranché qu'on la veuille), et le fait que **rien n'a jamais été ouvert sur
un vrai téléphone** — le critère n° 2 de la vision, « une URL collée dans le calendrier d'un
téléphone fait apparaître les soirées », n'a pas été validé à la main. Ne les décide pas seul.

**Non vérifié en navigateur** : le comportement sous React StrictMode (le contexte de groupe et le
flux SSE unique n'ont été éprouvés que sur un build de production).
