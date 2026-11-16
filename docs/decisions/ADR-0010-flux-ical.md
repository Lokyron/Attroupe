# ADR-0010 — Les flux iCal : portée du jeton, exception de garde et fuseaux

- **Date** : 2026-11-16
- **Statut** : Acceptée (lot 5)
- **Décidé par** : l'orchestrateur, sur blocage signalé par le `dev` avant toute écriture

## Contexte

`GET /ical/:jeton.ics` (architecture §7.1) est la première route du projet qui lit des données métier **sans aucun
des quatre verrous** du cloisonnement : pas de cookie (un client de calendrier n'en a pas), pas de groupe dans
l'URL, et elle agrège les événements de **tous** les groupes où l'appartenance est active. Son URL se promène en
clair dans la configuration d'un téléphone et dans ses sauvegardes.

Le `dev` s'est arrêté avant d'écrire une ligne, avec une sonde à l'appui : la requête qui résout le jeton
(`SELECT user_id, group_id, … FROM calendar_feed_tokens WHERE token_hash = ?`) est **refusée** par la garde du SQL
brut (verrou n° 5), parce que `calendar_feed_tokens` est classée `user_id` dans `PORTEE_TABLES` et qu'on ne connaît
justement pas encore le `user_id` — c'est le jeton qui l'établit. `PorteeUtilisateur` exige le `user_id` : cercle
vicieux.

**Vérifié avant de décider** : `SELECT user_id FROM calendar_feed_tokens WHERE id = ?` est refusé pour exactement
la même raison. L'option « mettre un identifiant public dans l'URL » (`/ical/<id>.<secret>.ics`) ne résout donc
rien et coûterait un écart à §7.1. Elle est écartée.

## Décisions

1. **La règle de fond ne bouge pas : aucune requête métier sans portée de groupe.** Le flux résout le jeton en
   `user_id`, **relit en base les appartenances actives** de ce compte, et crée **un `GroupScope` par groupe** via
   `creerScope`, puis lit les événements groupe par groupe. Le verrou n'est pas contourné, il est appelé en boucle.
   Conséquence voulue : le jeton d'un membre retiré ne rend plus rien de ce groupe, parce que l'appartenance est
   relue à chaque requête et non figée dans le jeton.

2. **Une exception de garde nommée, plus étroite que celle des `invitations`.**
   `ACCES_ALTERNATIFS` admet `calendar_feed_tokens: ['token_hash']` — même nature que l'exception n° 3 des
   invitations : la preuve d'accès **est** le secret, stocké haché en SHA-256. La table **reste** dans
   `PORTEE_TABLES` en `user_id`, puisque c'est ce qui protège `GET` et `DELETE /api/moi/flux-ical`.
   Quatre bornes, dont la troisième est plus stricte que pour `invitations` :
   - la couverture ne vaut que pour `calendar_feed_tokens` elle-même et **ne se propage jamais** par jointure ;
   - `token_hash` **jamais en `SET`** ;
   - **`SELECT` seulement, une seule table, aucune jointure** — pas même la jointure en lecture seule que les
     invitations s'autorisent. La requête ne renvoie que les colonnes du jeton ;
   - l'exception s'arrête à la résolution : `last_used_at` et `last_user_agent` s'écrivent par
     `UPDATE … WHERE id = ? AND user_id = ?`, qui satisfait la garde ordinaire.

   **Pourquoi ces bornes, précisément.** Au lot 3, une exception de même forme est devenue une clé maîtresse :
   la couverture obtenue par une colonne de preuve se propageait par les jointures `group_id = group_id`, si bien
   qu'un `UPDATE memberships SET role = 'admin'` passait. Le test de garde porte donc explicitement le voisin
   dangereux : une jointure de `calendar_feed_tokens` vers `events` ou `memberships` par `group_id = group_id`
   **doit être refusée**.

3. **Un intergiciel d'entrée de plus, et un seul.** `http/middleware/jeton-flux.ts` est le seul endroit autorisé à
   fabriquer une portée depuis un jeton de flux, avec son exception ESLint dédiée, comme `session.ts` et
   `appartenance.ts`. Le verrou n° 3 veut que la portée naisse en un point nommé **par chemin d'entrée** ; un flux
   sans cookie est un nouveau chemin d'entrée, pas une dérogation. Un test prouve qu'un **troisième** fichier ne
   peut toujours pas appeler `creerScope` ni `creerPorteeUtilisateur` : sans lui, le verrou serait desserré au lieu
   d'être étendu.

4. **Les `DTSTART` sont émis en UTC — écart assumé à §7.1.** La spécification demandait `DTSTART;TZID=` plus un
   `VTIMEZONE`. Les événements horodatés sortent en `DTSTART:…Z`, les journées entières en `DTSTART;VALUE=DATE`.
   La base stocke déjà `starts_at` comme un **instant** UTC accompagné d'une étiquette `time_zone` : pour un
   événement non récurrent, un instant est un instant, et `TZID` ne change rien à l'heure affichée par le
   téléphone. En échange, il nous ferait écrire à la main les règles de changement d'heure, ce qui est une source
   de défauts pour un gain nul. `time_zone` est porté dans la `DESCRIPTION` pour que l'information ne soit pas
   perdue.

## Conséquences

- **À reprendre en V2 avec la récurrence** (`RRULE`, fonctionnalité B7) : une règle récurrente se résout en heure
  locale, donc `TZID` + `VTIMEZONE` redeviendront nécessaires. C'est écrit ici pour que la V2 ne le redécouvre pas.
- `include_personal` est stocké et exposé mais **sans effet** : `personal_events` arrive au lot 8.
- Le registre de cloisonnement gagne une exigence `jetonFlux`. Ses attaques ne sont pas menées par une
  administratrice — au lot 4, une exigence dont toutes les attaquantes étaient admin ne protégeait rien, ce qui a
  été démontré par mutation.
- Le jeton n'apparaît **jamais** dans le contenu du flux : un `.ics` finit dans les sauvegardes d'un téléphone.

## Alternatives écartées

- **Identifiant public dans l'URL** (`/ical/<id>.<secret>.ics`) : écart à §7.1 et, vérifié par sonde, la lecture
  par `id` seul est refusée tout autant. Aucun gain.
- **Sortir `calendar_feed_tokens` de la garde**, comme `sessions` : on perdrait la protection des routes
  `/api/moi/flux-ical`, qui listent et révoquent des jetons appartenant à un compte.
- **CalDAV** : hors périmètre V1 (§7.1). L'abonnement en lecture seule couvre le besoin.
