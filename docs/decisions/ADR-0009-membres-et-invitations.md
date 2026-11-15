# ADR-0009 — Règles d'intégrité des membres et des invitations

- **Date** : 2026-11-16
- **Statut** : Acceptée (lot 3)
- **Décidé par** : dev, à valider en revue

## Contexte

Le modèle de données (§3.3, §3.4) pose les tables `memberships` et `invitations` et deux invariants (« un groupe a
toujours un administrateur actif », « une appartenance n'est jamais supprimée »), sans trancher les cas limites.
Le lot 3 les rencontre tous.

## Décisions

1. **Jamais de groupe sans administrateur.** Rétrograder, retirer ou faire partir le dernier administrateur actif est
   refusé (**409 `groupe.dernier_admin`**), y compris quand il est le seul membre : il désigne un successeur d'abord.
   Le contrôle (compte des administrateurs actifs) et l'écriture sont dans la même transaction
   (`db/queries/membres.ts`). Le seul chemin de sortie d'un administrateur seul est la suppression du groupe
   (marquage `deleted_at`, hors lot 3).
2. **Une appartenance n'est jamais supprimée.** Retrait = `status = 'removed'`, départ = `'left'`, avec `ended_at`. Les
   dépenses, présences et messages restent attachés à la même ligne ; l'affichage joint `memberships` sans filtre de
   statut et marque « ancien membre ».
3. **Retrait de soi-même.** `DELETE …/membres/:m` sur sa propre appartenance est refusé (409 `membre.retrait_de_soi`) :
   la sémantique « parti » (`left`) a sa route, `POST …/depart`.
4. **Réintégration sans doublon.** `UNIQUE (group_id, user_id)` : accepter une invitation quand une ligne `removed` /
   `left` existe **réactive la même ligne** (`status = 'active'`, `ended_at = NULL`, rôle de l'invitation, `joined_at`
   remis à l'acceptation). Jamais de seconde ligne, donc l'historique retrouve son auteur.
5. **Les invitations d'un membre qui part ou qu'on retire sont révoquées** dans la même transaction : il ne peut plus
   faire entrer personne après coup. **Rétrograder** un administrateur (`admin` → `member`) révoque de même ses invitations
   en attente de rôle `admin` : sinon un complice les accepterait et deviendrait administrateur à sa place.
6. **Aucune adhésion d'office.** Inviter (par e-mail ou par nom d'utilisateur) crée une ligne `pending`. Seul l'invité
   l'accepte. Une invitation en attente par cible et par groupe ; une invitation échue passe à `expired` à la prochaine
   émission (elle ne retient plus l'index unique) et s'affiche expirée sans attendre.
7. **Pas d'annuaire.** Le nom d'utilisateur se compare exactement (insensible à la casse, comme son unicité), jamais
   par préfixe ni sous-chaîne. L'émission répond **202 identique** que le nom existe ou non, qu'il soit déjà membre ou
   déjà invité : la réponse n'est pas un oracle. *Limite assumée* : l'administrateur voit ensuite sa propre liste
   d'invitations émises, où l'invitation apparaît si le nom existait ; la cadence (10 par compte, 15 min) borne le
   sondage. *Oracle par le temps, accepté de même* : le cas « nom existant » écrit en base (transaction), le cas « nom
   inconnu » ne fait qu'une lecture ; la durée de réponse les distingue en principe. On ne l'égalise pas (un délai artificiel
   coûterait à tous pour un gain nul face à la liste d'émises, qui livre la même information) : l'oracle est assumé, y compris
   par le temps de réponse, et borné par la cadence.
8. **Le jeton d'une invitation par e-mail naît à l'envoi**, comme ceux du lot 2 : la file ne porte que l'identifiant de
   la ligne et celui du groupe ; l'empreinte SHA-256 est écrite à l'envoi, l'échéance (14 jours) part de ce moment.
   Une invitation révoquée avant l'envoi ne part pas.
9. **Rattachement par e-mail : adresse vérifiée exigée, et par le lien seulement.** Une invitation par e-mail n'a d'autre preuve
   d'accès que son jeton (la garde du SQL brut n'admet que `target_user_id = ?` et `token_hash = ?` sur `invitations`, voir
   l'architecture §4 verrou 5) : elle ne s'affiche donc PAS dans « mes invitations » par correspondance d'adresse. Accepter par le
   lien exige un compte dont `users.email_verified_at` est non nul ET dont l'adresse est celle invitée. Adresse inscrite mais non
   vérifiée : 403 `invitation.adresse_non_verifiee` ; autre adresse : 404 `invitation.introuvable`. Sans cela, qui inscrit
   l'adresse d'un autre avant lui récupérerait ses invitations (fuite entre groupes).
10. **Liens morts : 410.** Un lien révoqué, expiré ou déjà utilisé répond 410 avec sa raison (modèle §4.4), un lien inconnu ou mal
    formé 404.
11. **Les exceptions de la garde SQL sont bornées** (architecture §4, verrou 5). Une couverture de `invitations` par
    `target_user_id = ?` ou `token_hash = ?` ne couvre QUE `invitations` : elle ne se propage jamais par `group_id = group_id`
    (sinon une jointure sur une invitation, même refusée ou échue, ouvrirait en lecture et écriture tout le groupe invitant). Seule
    dérivation admise, nommée : en `SELECT`, `memberships ON m.id = i.invited_by_membership_id AND m.group_id = i.group_id`
    (l'inviteur affiché au destinataire), qui ne propage rien à son tour. La colonne de preuve ne se modifie pas :
    `target_user_id` jamais en `SET` ; `token_hash` seulement sous un vrai `group_id = ?` (armement à l'envoi).
12. **Le jeton d'un lien d'invitation voyage dans le corps**, comme ceux du lot 2 : `POST /api/invitations/apercu` et
    `POST /api/invitations/acceptation`, `{ "token": … }`. Jamais dans l'URL, donc jamais dans le journal d'accès ni celui d'un proxy.
13. **Cadence d'émission par cible.** Clé `(cible, groupe)` au seuil bas (3 / 15 min) : un tiers qui martèle une cible depuis
    son groupe n'épuise que sa clé, il ne rend pas la cible « non invitable » ailleurs. Clé par cible seule (adresse OU nom
    d'utilisateur) à un seuil beaucoup plus large (20 / 15 min), contre l'inondation par de nombreux groupes ; limite assumée :
    qui dispose de nombreux groupes peut l'épuiser, le report est exponentiel et jamais définitif.

## Conséquences

- 409 plutôt que 403 pour les refus d'intégrité : le droit est là, c'est l'état du groupe qui s'y oppose.
- Un administrateur seul ne peut ni partir ni se rétrograder tant que la suppression de groupe n'existe pas.
