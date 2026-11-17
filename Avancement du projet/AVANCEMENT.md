# Avancement — Attroupe

> Un bloc par jalon. Le plus récent en haut. On y note ce qui est **fait et vérifié**,
> pas ce qui est prévu (le prévu vit dans le dossier de conception).

## 2026-11-17 — Relecture de la livraison : une SSRF, une addition de devises, une lecture inter-groupes

Les lots 7 à 12 avaient été écrits par un autre assistant, dans une copie de travail, et n'avaient jamais été
relus. La relecture a trouvé **trois défauts dont aucun test ne parlait**, et sept défauts mineurs. Les deux
règles non négociables, elles, tenaient : aucune fuite inter-groupes sur le contenu métier, aucun flux bancaire.

**Ce qui était cassé.**
1. **SSRF exploitable par n'importe quel compte.** `POST /api/moi/push/abonnement` ne validait l'`endpoint` que
   comme une URL `http(s)` ; `POST /api/moi/push/test`, sans cadence, postait dessus et **renvoyait le résultat**.
   Sur une instance exposée sur Internet avec inscription ouverte, c'était un scanner du réseau local avec oracle
   de réponse. Corrigé : `https` et port 443 seuls, hôte résolvant uniquement vers des adresses publiques, DNS
   épinglé entre la vérification et la connexion, revérification avant chaque envoi, redirections non suivies,
   plafond de 10 appareils, cadence `push`, et accusé **neutre** en 202. `ATTROUPE_IMMICH_ALLOW_PRIVATE` ne
   s'applique pas au push. Le classifieur d'adresses partagé avec Immich refuse en plus NAT64 à préfixe local,
   SIIT et Teredo, et extrait l'IPv4 embarquée du 6to4.
2. **La clôture d'un événement additionnait deux devises.** `cloturerEvenementService` sommait
   `amount_target_minor` sans regarder `target_currency_code` : 50 € puis 30 $ donnaient 8000 étiquetés « USD »,
   exactement l'addition implicite que l'ADR-0004 interdit. Le total est désormais calculé dans la seule devise de
   la clôture, les autres gardant leur ardoise, et un dépassement d'entier donne 422 au lieu de 500.
3. **La photo de profil de n'importe quel compte était lisible sans groupe commun.** Un ancien membre du
   groupe B gardait les identifiants vus pendant son passage. `lireAvatarUtilisateur` prend maintenant la portée
   appelante et exige un groupe **actif** commun — 404, jamais 403. Le test de cloisonnement passait à vide sur
   cette ressource : seule Alice avait un avatar dans le monde de test, donc le 404 venait de l'absence de photo
   et non de la cloison. Bob en a un désormais, et l'attaque est réellement jouée.

**Autres corrections.** Les sondages n'avaient aucun contrôle de droit (tout membre modifiait, annulait ou
convertissait le sondage d'un autre) : réservé à l'auteur ou à un administrateur, le vote restant ouvert. `db/`
n'appelle plus le réseau et l'envoi push part après le commit, au lieu de partir depuis l'intérieur de la
transaction avec l'erreur avalée. La clé privée VAPID est chiffrée comme la clé Immich, au lieu d'être en clair à
côté d'elle. Un flux Immich de plus de 4 s n'arrive plus tronqué. Un endpoint push est réattribué au compte qui
l'enregistre, ce qui débloque le navigateur partagé.

**Deux leçons.**
- **Un test vert ne prouve rien s'il ne joue pas l'attaque.** Le registre de cloisonnement déclarait bien la
  ressource `utilisateur` ; c'est le monde de test qui rendait l'attaque impossible à échouer. Un test de
  cloisonnement doit échouer quand on retire la garde — à vérifier en la retirant.
- **Une URL fournie par le client est une primitive de requête sortante.** Le projet avait déjà tout le
  dispositif anti-SSRF, écrit pour Immich. Il n'a pas été réutilisé pour le push parce que rien ne rappelait de le
  faire. Désormais le classifieur est partagé.

**Écarts au périmètre, consignés plutôt que laissés en contradiction.** Le push navigateur et la détection des
disponibilités (B6) étaient en V2 et ont été livrés ; le journal ne mentionnait même pas le push. Plutôt que de
jeter du code qui marche ou de laisser le document mentir, ils passent en V1 par
[`ADR-0012`](../docs/decisions/ADR-0012-push-navigateur.md). Les trois variables `ATTROUPE_VAPID_*`, lues par
`env.ts` mais absentes de `.env.example`, y sont ajoutées, et les routes push sont enfin dans `DOCUMENTATION.md`.

**Vérifié** : `lint`, `typecheck`, `build`, et la suite complète à **1387 tests verts** sur 68 fichiers (1 ignoré).
Les 7 tests qui échouaient étaient des assertions périmées, pas des régressions : la migration `0003` ajoute deux
tables et un index, et la liste des membres porte un champ de plus.

> Au passage, sur cette machine : lancer les 68 fichiers de test en parallèle épuise les ports éphémères de macOS
> et produit des dizaines de faux `EADDRNOTAVAIL`. `npm test -- --maxWorkers=4` donne un résultat fiable.

## 2026-11-17 — Lots 7 à 12 livrés : finition (version, PWA, sauvegarde, exploitation)

Les lots 7 à 11 (sondages de dates, agenda personnel et partages, notifications, dépenses et clôtures,
fils de discussion et photos Immich) ainsi que le **lot 12 (finition)** sont implémentés :
- **Version et exploitation** : `GET /api/version` (nom, version, `ATTROUPE_TAG`, dernière migration
  `schema_migrations`), déclarée au registre de cloisonnement ; côté client `api/version.ts`, pied de page
  discret dans `App.tsx` et page `#/exploitation` (`Exploitation.tsx`) affichant version, tag, migration,
  `/api/sante` et `service_email`.
- **PWA installable** : `app/client/public/manifest.webmanifest`, icônes SVG et PNG (`192x192`, `512x512`)
  dans `app/client/public/icons/`, service worker `app/client/public/sw.js` (coquille en cache, réseau direct
  sans cache pour `/api/*`, `/ical/*`, `/media/*`), balises dans `index.html` et enregistrement dans `main.tsx`.
- **Option `include_personal` iCal** : exposée dans `api/flux.ts` et dans le formulaire d'abonnement de `Compte.tsx`.
- **Sauvegarde et restauration** : `scripts/sauvegarde.sh` (`VACUUM INTO` cohérent sous WAL + dossier `fichiers/`
  en `.tar.gz` horodaté) et `scripts/restauration.sh` (`PRAGMA integrity_check`, garde `--force`, nettoyage `-wal`/`-shm`).

## 2026-11-16 — Trois défauts d'interface, et une prémisse du cahier des charges invalidée

Suite de l'essai sur un vrai iPhone. Le lien `webcal://` du matin avait rendu l'abonnement **possible** (agent
`dataaccessd` dans les journaux du proxy, premier abonnement iOS réellement vivant) ; l'essai complet a montré qu'il
n'était pas encore **utilisable**, et a invalidé une affirmation de l'architecture.

**Trois défauts, tous d'interface, aucun visible par un test.**
1. L'adresse `webcal://` n'était affichée nulle part. On configure depuis un ordinateur, on copie la seule adresse
   visible — l'`https` — on l'ouvre sur le téléphone, et on obtient un **import figé**. C'est exactement le chemin
   emprunté par l'utilisateur, malgré le paragraphe d'explication déjà présent. Elle est désormais affichée en texte
   copiable, sous le titre « Adresse à envoyer sur votre téléphone ».
2. Rien ne disait que **Google Agenda ne sait pas s'abonner depuis son application mobile** : l'option n'y existe
   pas, il faut `calendar.google.com` depuis un ordinateur, une fois, et l'abonnement redescend ensuite par le compte
   Google. Un bouton explicitement étiqueté « depuis un ordinateur » ouvre maintenant la boîte de dialogue.
3. Le champ de nom proposait « Mon téléphone » en gris : un texte d'exemple qui ressemblait à une valeur saisie, si
   bien que les abonnements finissaient sans nom. Le chemin du `label` était correct de bout en bout (le `dev` l'a
   vérifié, des tests le couvraient déjà) : c'était un piège d'interface, pas un défaut de code. Le texte d'exemple
   est préfixé.

**La prémisse invalidée.** §7.1 affirmait depuis le lot 5 qu'un événement servi en `STATUS:CANCELLED` **disparaît**
du calendrier du téléphone. C'est faux : il **reste affiché, barré**. Ce qui le ferait disparaître, c'est de
l'omettre du flux, un abonnement iCal étant un remplacement complet par son contenu. Le texte d'origine est
conservé avec un amendement daté pour que l'erreur reste visible, et le comportement est gardé **par choix** : une
soirée barrée informe (« elle est annulée, ne te déplace pas »), une soirée évaporée laisse perplexe. L'utilisateur
l'a formulé ainsi, et c'est son argument qui a tranché.

**Une proposition retirée.** Je voulais faire disparaître du flux les annulés dont la date est passée, pour éviter
l'accumulation de fantômes barrés. Vérification faite dans les deux requêtes de fenêtrage : c'est inutile. Un
événement annulé est servi par l'ensemble « modifiés depuis », donc barré environ **trois mois**, puis il sort du
flux de lui-même. L'accumulation était déjà bornée ; je proposais un correctif pour un problème que le code
résolvait. Consigné dans l'ADR-0010 pour que le débat ne soit pas rouvert.

**Vérifié par exécution de ma part** : 1 124 tests, lint, typecheck et build verts, et le paquet JavaScript
**réellement servi** par `https://beta.attroupe.fr` contient les cinq nouveaux textes et le lien
`calendar.google.com/calendar/r?cid=`. `POST /api/moi/flux-ical` rend `url` et `url_webcal` sur le même jeton, et le
libellé revient correctement. Mes jetons de contrôle sont révoqués ; le seul abonnement actif est celui de l'iPhone.

**Non éprouvé** : le comportement réel du lien Google chez Google (seule sa construction est testée), et le rendu du
panneau à l'écran — il empile maintenant beaucoup de blocs, avec des `h4` sans style dédié.

## 2026-11-16 — Le défaut qu'aucun test ne pouvait trouver : le lien `webcal://`

En éprouvant la bêta sur un vrai iPhone, l'abonnement iCal s'est révélé **inutilisable**, alors que le serveur était
irréprochable : `HEAD`, `OPTIONS` et `GET` en 200, `text/calendar; charset=utf-8`, `ETag` et `304`, `VCALENDAR`
conforme au pliage à 75 octets près, DNS public correct, service joignable depuis Internet. Tout vert, 1 118 tests
passés — et la fonctionnalité ne marchait pas.

**La cause** : l'application ne donnait qu'une URL en `https://`. Sur iOS, un lien `https` vers un `.ics` fait
*télécharger* le fichier et propose « ajouter les événements » : c'est une **copie figée**, jamais rafraîchie. Seul le
schéma **`webcal://`** fait créer un **abonnement**. Le mot `webcal` n'existait nulle part dans le dépôt.

**Comment ça s'est vu** : les journaux du proxy. Les événements apparaissaient bien sur le téléphone, mais aucun agent
de calendrier n'avait **jamais** requis le flux — uniquement Safari. Et un événement ajouté ensuite n'apparaissait
pas. Le journal a donc départagé « ça a l'air de marcher » et « ça marche », ce qu'aucune capture d'écran n'aurait
fait.

**Corrigé** : `POST /api/moi/flux-ical` renvoie `url` **et** `url_webcal`, l'interface fait du lien `webcal://` son
action principale (un vrai `href`, sans JavaScript : c'est le navigateur qui doit passer la main au Calendrier), avec
le texte qui explique la différence entre abonnement et copie figée, et un avertissement sur Google Agenda — dont la
première récupération dort souvent plusieurs heures, puis rafraîchit toutes les 8 à 24 h sans moyen de forcer.
Le jeton reste affiché **une seule fois** : un lien perdu se révoque et se recrée, ce que l'interface dit désormais
au lieu de le laisser deviner. 1 122 tests. Déployé sur le 113 et vérifié sur l'instance : les deux champs sont
rendus, ils portent le même jeton, et la liste des abonnements ne laisse filtrer ni jeton, ni `webcal`, ni `/ical/`.

**La leçon, et elle vaut pour la suite du projet.** J'ai répété cinq lots de suite que l'interface n'avait jamais été
ouverte, sans pouvoir dire ce que ça cachait. Voilà ce que ça cachait : un serveur parfait livrant une fonctionnalité
morte, parce que la chaîne donnée à l'utilisateur portait le mauvais schéma. **Aucun test automatique de ce dépôt ne
pouvait le trouver** — il fallait un vrai téléphone, et il en faudra un à chaque lot qui produit quelque chose qu'un
appareil doit consommer (lot 11 et les photos, lot 12 et la PWA installable).

**Reste à éprouver** : l'annulation. Un événement annulé doit **disparaître** du téléphone (`STATUS:CANCELLED`) et non
y rester figé. C'est la seconde moitié du critère n° 2, toujours pas vérifiée à la main.

## 2026-11-16 — Mise en service de la bêta et première validation réelle

Conteneurs **112** (`attroupe`, `10.1.20.112`) et **113** (`attroupe-beta`, `10.1.20.113`) créés sur `PVE-TXLHOME`
aux conventions du homelab, Docker vérifié par exécution dans les deux. La bêta tourne sur le 113 derrière
`https://beta.attroupe.fr` (certificat `*.attroupe.fr` par défi DNS OVH). Détails dans `DOCUMENTATION.md` §3 bis.

**Les deux critères de la vision qui n'avaient jamais été éprouvés hors des tests le sont enfin**, sur l'instance
réelle, à travers le proxy, avec un compte créé pour l'occasion :

- **Temps réel (critère n° 3)** : flux SSE ouvert à travers Nginx, `Content-Type: text/event-stream`,
  `Transfer-Encoding: chunked`, aucun tamponnage. Un article coché depuis une autre requête arrive dans le flux en
  **69 ms**. `article.pris` et `article.ajoute` arrivent de même. Le `X-Accel-Buffering: no` posé au lot 6 fait son
  travail, alors même que `proxy_buffering off` n'est pas encore coché côté proxy.
- **iCal (critère n° 2)** : `text/calendar; charset=utf-8`, `Cache-Control: private, max-age=300`, `ETag` et **304**
  sur `If-None-Match`. Le `VCALENDAR` est conforme à la lecture : **CRLF partout, aucune ligne de plus de 75 octets**,
  pliage par espace de continuation, accents préservés, `SUMMARY` préfixé du nom du groupe, `DTSTART` en UTC,
  `ORGANIZER` sur une adresse `.invalid`. Le jeton n'est rendu **qu'à la création** et n'apparaît pas dans la liste
  des abonnements. Révoqué, le flux répond **404**, comme un jeton inconnu.

**Joignable depuis Internet : prouvé le 2026-11-16, et pas par moi.** Toutes mes vérifications partaient de la machine
de développement, donc de l'intérieur du réseau, et revenaient par l'IP publique en épingle : elles ne prouvaient
rien de l'extérieur. C'est l'iPhone de l'utilisateur qui l'a établi, en récupérant le flux deux fois en 200 avec le
fichier complet — une fois depuis le Wi-Fi (`10.1.30.131`), une fois en **données mobiles** depuis une adresse
publique (`37.167.2.185`). Ce second appel valide du même coup la chaîne `X-Forwarded-For` avec un vrai client
extérieur : c'est bien son adresse qui remonte, pas celle du proxy, ce dont dépend la limitation de cadence.

**Leçon à retenir pour la suite** : « joignable » vérifié depuis le réseau local ne veut pas dire joignable. Toute
mise en service ultérieure (le 112 en production) doit être éprouvée depuis l'extérieur, par un client qui ne passe
pas par l'épingle du routeur.

**Reste à valider à la main** : l'abonnement iCal vu par le **récupérateur de calendrier** lui-même. Le fichier a été
téléchargé par Safari sur l'iPhone, pas par l'agent d'abonnement : au 2026-11-16, aucun agent de calendrier (ni
l'iPhone, ni les serveurs d'Apple pour un abonnement iCloud) n'apparaît dans les journaux du proxy. Le critère n° 2
de la vision n'est donc pas encore tenu de bout en bout. L'interface, elle, a été ouverte dans Chrome sur macOS par
l'utilisateur (un événement y a été créé), mais jamais par moi.

**Relevé en déployant** : `GET /api/version` est à la surface d'API (§6) mais n'a jamais été écrite — elle répond
`route.introuvable`. À faire au lot 12.

## 2026-11-16 — Lot 6 : listes de courses, tâches et flux temps réel

`/listes` (articles, preneur, case cochée, réordonnancement), `/taches` (assignation, « qui apporte quoi » rattaché à un événement)
et `GET /api/groupes/:groupId/temps-reel` (SSE, sans dépendance). Page de liste de courses « debout, à une main » et tâches visibles
depuis l'événement, côté client. Aucune migration. Décisions et raisons dans
[`ADR-0011`](../docs/decisions/ADR-0011-temps-reel-listes-taches.md).

**Le risque propre au lot, et sa réponse.** Une connexion qui reste ouverte ne revérifie rien d'elle-même : quelqu'un retiré du
groupe continuerait de recevoir tout ce qui s'y passe. Le diffuseur relit donc l'appartenance **et** la session en base avant chaque envoi
et à chaque battement ; en plus, retrait et départ par l'API ferment les flux tout de suite. Le message poussé est minimal (type,
identifiant, parent, auteur, instant) : même une indexation fausse du registre ne ferait fuir que des identifiants.

**Un défaut antérieur au lot, trouvé par la concurrence réelle.** Quatre vrais processus écrivant sur le même fichier ont fait échouer
des dizaines d'écritures en `SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT` : le `BEGIN` différé de `executerEnTransaction` ne laisse pas jouer
`busy_timeout` quand la transaction commence par lire. Corrigé par `BEGIN IMMEDIATE`. Sans effet avec un seul processus (better-sqlite3
est synchrone) ; c'est pourquoi le test existe sous les deux formes (requêtes simultanées sur une application, puis processus).

**Mutations jouées** : retirer la revérification de l'appartenance du flux fait échouer 4 tests, dont « un membre retiré a reçu un
événement du groupe après son retrait » ; indexer la diffusion sur tous les groupes fait échouer les deux tests « deux flux » ; retirer la
vérification du membre assigné fait échouer la suite générique (500 au lieu de 404) ; retirer `IS NULL` du preneur fait échouer 4 tests,
dont le test à plusieurs processus ; retirer `BEGIN IMMEDIATE` fait échouer le test à plusieurs processus.

**Corrections de revue** : un compte *suspendu ou anonymisé* gardait son flux ouvert (la suspension s'écrit sur `users`, sans toucher
`sessions`) : `sessionVivante` relit maintenant `users`, avec deux tests qui échouent quand on retire la jointure ; un article pris par
un membre retiré est libérable et reprenable ; le harnais de cloisonnement joue les écritures d'Erin dans un second monde (l'étape 5 de
`PUT …/preneur` renvoyait 409) et exige désormais un succès à l'étape 5 de toute route `appartenance` ; plafond global de flux
(`ATTROUPE_SSE_MAX_CONNECTIONS`), arrêt qui refuse les ouvertures, 500 articles par liste ; départ des processus du test de concurrence sur
« prêt »/« go » plutôt qu'une barrière horaire ; côté client, rechargements ordonnés et regroupés, 401 du flux traité.

**Vérifié par exécution de ma part** : `lint`, `typecheck`, `build` verts, **1 118 tests** passés (1 ignoré, antérieur au lot),
`git diff app/server/db/sql.ts` limité au seul `BEGIN IMMEDIATE` et à son commentaire. Les trois pièces du socle que ce lot touche
ont été relues ligne à ligne : les `conditions` du moteur passent par le **même `compiler`** que les filtres de lecture (colonne
vérifiée contre `pragma_table_info`, opérateurs fermés, valeurs liées) et ne peuvent que restreindre ; `appartenanceActive` vit dans
le fichier qui a **déjà** le droit d'appeler `creerScope`, donc le verrou n° 3 n'est pas élargi. Mutations rejouées par moi :
retirer `appartenanceActive` du contrôle avant envoi fait échouer 4 tests (« un membre retiré a reçu un événement du groupe après
son retrait ») ; dé-indexer la diffusion fait échouer les deux tests « deux flux » (« événement étranger dans le flux de A ») ;
retirer la jointure sur `users` de `sessionVivante` fait échouer les deux tests de compte suspendu et anonymisé. Et le test de
démonstration **écrit par le reviewer**, qui affirmait que le défaut était présent, échoue maintenant de lui-même : « Aucun
événement attendu en 3000 ms. Reçu : [] ».

**Non vérifié** : l'interface n'a jamais été ouverte dans un navigateur ni sur un téléphone ; le critère n° 3 est établi par des tests
serveur (trois comptes, trois flux, une rafale de cases) et reste à valider à la main.

## 2026-11-16 — Lot 5 : les flux iCal

Jetons d'abonnement par compte (`GET`/`POST`/`DELETE /api/moi/flux-ical`, 32 octets en base32, stockés hachés, le
jeton en clair affiché **une seule fois**) et `GET /ical/:jeton.ics`, la seule route métier **hors `/api`** : ni
cookie, ni CSRF, ni groupe dans l'URL. Génération du `VCALENDAR` sans dépendance (pliage à 75 **octets** UTF-8,
CRLF, échappement RFC 5545), `ETag` et `304`, cadence par jeton. Page du compte côté client. Aucune migration.

**La décision d'architecture du lot, et comment elle a été prise.** Le `dev` s'est arrêté **avant d'écrire une
ligne** : la requête qui résout le jeton est refusée par la garde du SQL brut, parce que `calendar_feed_tokens` est
classée `user_id` et qu'on ne connaît justement pas encore le `user_id`. J'ai vérifié sa sonde, puis vérifié que son
option de repli (un identifiant public dans l'URL) était refusée **pour la même raison** — donc sans gain. Décision
prise et enregistrée dans [`ADR-0010`](../docs/decisions/ADR-0010-flux-ical.md) : une cinquième exception nommée
(`token_hash = ?`), plus étroite que celle des invitations — `SELECT` seul, une table, **aucune jointure**,
`token_hash` jamais en `SET` — et la règle de fond intacte : le flux crée **un `GroupScope` par appartenance
active** et lit groupe par groupe. §7.1 de l'architecture porte un **amendement daté qui pointe vers l'ADR**, le
texte d'origine conservé : c'est ainsi qu'on modifie une spécification, pas en la réécrivant pour coller au code
(ce qui était arrivé au lot 2).

**Vérifié par exécution de ma part** : `lint`, `typecheck`, `build` verts, **1 022 tests** passés (1 ignoré,
antérieur au lot). **17 sondes que j'ai écrites contre la garde** : sont refusées la jointure
`calendar_feed_tokens → events` par `group_id = group_id`, la sous-requête `WHERE group_id = (SELECT … WHERE
token_hash = ?)`, la même en `IN`, la virgule-jointure, le `UNION`, le `LEFT JOIN`, `WHERE id = ?` seul, l'`UPDATE`
et le `DELETE` sous `token_hash`, la réécriture du `token_hash`, le littéral, un `UPDATE memberships SET role`
greffé sur une sous-requête de jeton, et le témoin exact du lot 3 ; seules la résolution d'une table sans jointure et
`UPDATE … WHERE id = ? AND user_id = ?` sont admises. Mutation : retirer `AND status = 'active'` de `creerScope`
fait échouer `GET /ical/:jeton.ics` nommément.

**Le défaut le plus grave trouvé en revue était antérieur au lot : le verrou n° 3 se contournait depuis le lot 1.**
La règle ESLint comparait le **texte** de l'import. J'ai reproduit les trois formes moi-même :
`../../db/scope.js` bloqué, mais `../../db/queries/../scope.js` et `../../db/.//scope.js` passaient — Node et
TypeScript les résolvent identiquement. Une route pouvait donc importer `preparer` par un chemin détourné et lire
n'importe quel groupe, la garde vérifiant la *forme* de la requête et non quelle valeur est liée. Corrigé : la
barrière réelle est maintenant le test par **chemin résolu**, étendu à `scope`, `portee-utilisateur`, `sql` et
`migrate`, avec la liste nominative des fichiers autorisés ; ré-exports, import dynamique, `require` et import
d'espace de noms refusés. Les quatre sondes sont bloquées, vérifié par moi après correction.

**Le second défaut : l'`ETag` pouvait mentir.** Il se réduisait à `(MAX(updated_at), COUNT(*))` par groupe, et
répondre à une invitation ne touche jamais `events.updated_at` (vérifié dans le code). Donc, avec
`include_declined = 0` : je refuse A, j'accepte B, le nombre et le maximum ne bougent pas, le téléphone reçoit un
`304` et ne voit **jamais** B. Ce n'était pas une fuite — tout restait dans mon groupe — mais c'était un agenda
faux, ce qui est la fonction même du lot. L'empreinte est devenue exacte (`id|updated_at|nom de l'auteur` trié puis
haché, dans le même agrégat), et un `304` ne coûte toujours aucune lecture d'événement. **Rejoué par moi** :
remettre `(max, count)` fait échouer exactement les deux tests visés — celui des réponses échangées et celui du nom
d'organisateur. Les nouveaux tests ne sont donc pas creux.

**Autres corrections après revue** : le nom de l'organisateur entre dans l'empreinte (un compte anonymisé laissait
son ancien nom dans `ORGANIZER;CN=` sur tous les téléphones, indéfiniment, puisque chaque interrogation recevait un
`304`) ; `POST /api/moi/flux-ical` reçoit un plafond de 20 abonnements actifs **et** une cadence ; le panneau qui
affiche l'URL se ferme quand le jeton qu'il montre est révoqué.

**Non vérifié** : aucun test sur un vrai iPhone ni Android — le critère n° 2 de la vision reste à valider à la main,
et c'est maintenant le plus gros manque du projet. L'interface n'a toujours jamais été ouverte dans un navigateur.
Assumé : un événement horodaté sans `ends_at` n'a pas de `DTEND` (la RFC en fait un point, nous n'inventons pas une
durée) ; troncature à 1000 événements par groupe et par ensemble ; le jeton apparaît dans les journaux d'accès du
proxy inverse, ce qui est désormais écrit dans `DOCUMENTATION.md`.

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
