# ADR-0016 — L'héritage des préférences de notification

- **Date** : 2026-11-20
- **Statut** : Acceptée
- **Décidé par** : l'orchestrateur, sur le travail du `dev` et deux passes de `reviewer`

## Contexte

Un compte a deux niveaux de préférences de notification : une ligne globale, portée par `group_id = '*'`,
et une ligne par groupe. La résolution faisait primer la ligne du groupe **en bloc** dès qu'elle
existait, et la ligne d'un groupe était créée en **recopiant** les valeurs du global au moment où
l'utilisateur réglait un seul de ses champs.

Cette copie produit deux fois le même défaut, dans les deux ordres :

- **Ordre « global d'abord »** : un genre coupé globalement était réactivé en silence dès que
  l'utilisateur réglait le mode e-mail d'un groupe, parce que la ligne du groupe naissait avec
  `muted_kinds = '[]'`. C'est le symptôme qui a été corrigé en premier, par un héritage à la création.
- **Ordre inverse** : une fois la ligne du groupe créée, couper un genre pour **tous** les groupes
  n'avait plus aucun effet sur ce groupe-là. L'héritage à la création ne règle que la moitié du
  problème, puisqu'il reste une copie — une photographie du global prise une fois.

Le même piège vaut pour le mode e-mail. Et côté interface, « ce groupe suit le réglage global »
n'était qu'une **apparence** : le bouton « Reprendre le réglage global » recopiait les valeurs, et la
ligne restait indépendante. L'utilisateur croyait être revenu à l'héritage ; il n'y était pas.

## Décisions

1. **Une préférence de groupe est une surcharge partielle, pas une copie.** Dans la ligne d'un
   groupe, une colonne à `NULL` signifie « hérite de la ligne globale ». La résolution se fait
   **champ par champ** : la valeur du groupe si elle est posée, sinon celle du global, sinon le défaut
   (e-mail immédiat, aucun genre coupé).

2. **La ligne `'*'` n'hérite de rien** : ses trois colonnes sont non nulles, imposé par un `CHECK`.

3. **« Suivre le global » est un état réel, pas une recopie.** Un groupe qui suit le global n'a pas de
   ligne, ou une ligne dont les colonnes concernées sont `NULL`.
   `DELETE /api/moi/preferences-notifications/:groupeId` supprime la ligne du groupe et rend donc le
   groupe à l'héritage. La route est idempotente, et répond 404 `groupe.introuvable` hors d'une
   appartenance active — comme toute route de groupe, et elle est au registre de cloisonnement.

4. **Un `PUT` n'écrit que les champs fournis.** Un champ absent n'est pas modifié ; une liste vide
   `[]` est un choix explicite (« ne couper aucun genre »), distinct d'un champ absent. Un `PUT` sans
   aucun des deux champs est un 400, pas un no-op silencieux.

5. **La migration `0008` reconstruit `notification_preferences`** pour rendre `channel_email`,
   `digest` et `muted_kinds` nullables. SQLite ne modifie pas une contrainte : c'est une table neuve,
   un `INSERT … SELECT` aux colonnes listées une à une, un `DROP` et un `RENAME`, sur le motif posé
   par `0006`. Les valeurs par défaut de colonne sont **retirées** : sans cela, une ligne de groupe
   créée sans valeur aurait été remplie au lieu d'hériter. Les lignes existantes gardent leurs
   valeurs : aucun passage rétroactif à `NULL`.

6. **La résolution du client reproduit celle du serveur**, dans
   `app/client/src/lib/preferences-notifications.ts`. Un écart entre les deux ferait croire à
   l'utilisateur qu'il a coupé un genre alors qu'il le reçoit encore : un test échoue si les deux
   listes de genres divergent.

## Conséquences

- Les deux ordres de réglage donnent désormais le même résultat, et changer le global se répercute
  sur tout groupe qui n'a pas exprimé de choix contraire.
- Le retour au global est explicite et vérifiable : la ligne disparaît.
- Un champ reste grossier : « Reprendre le réglage global » rend les **deux** champs à la fois, même
  si le groupe n'en avait surchargé qu'un. Un retour champ par champ demanderait soit un `PUT`
  acceptant `null`, soit deux routes. Dette assumée, signalée ici plutôt que découverte plus tard.
- Les genres que le serveur accepte mais n'émet pas encore (dont `invitation_received`) sont masqués
  dans l'interface : une case qui ne coupe rien est pire qu'une case absente. *(Ce passage est révisé
  le 2026-11-21, voir plus bas : `invitation_received` n'est plus dans ce cas.)*

## Révision du 2026-11-21 — `invitation_received` est émis, donc réglable

**Ce qui change** : le passage « genres émis » des Conséquences est caduc pour `invitation_received`.
Le serveur émet désormais ce genre à l'envoi d'une invitation à un compte existant
(`app/server/db/queries/notifications.ts`, notification sans `group_id`, sans e-mail en file). Le genre
est rangé dans le thème « groupe » de `app/client/src/lib/preferences-notifications.ts`, et la liste
`GENRES_NON_EMIS` y est désormais vide : le réglage le propose.

**Pourquoi** : la règle d'origine (ne pas proposer un genre qui ne coupe rien) reste la bonne. Dès que
le genre est émis, la case coupe réellement quelque chose.

**Portée réelle** : le destinataire d'une invitation n'est pas encore membre du groupe invitant. En
règle générale, il n'a donc pas de ligne de préférence pour ce groupe, et la préférence s'applique
**par la ligne globale** (`'*'`). Le réglage par groupe ne joue qu'au cas où une ligne existerait déjà
pour ce groupe. Le mécanisme (résolution champ par champ, décisions 1 à 6) ne change pas.
