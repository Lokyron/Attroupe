# ADR-0006 — Rendre le cloisonnement structurel, pas discipliné

- **Date** : 2026-11-15
- **Statut** : Acceptée
- **Décidé par** : architecte

## Contexte

L'[`ADR-0002`](ADR-0002-multi-groupes.md) pose la règle : chaque table porte son groupe, chaque
requête filtre dessus. Elle ne dit pas **comment** empêcher l'oubli. Or un filtre oublié est une
fuite de données entre groupes, c'est-à-dire le pire incident possible pour ce produit. « On
pense à filtrer » n'est pas un dispositif : la vigilance décroît au trentième fichier de requêtes.

## Options envisagées

1. **Revue et convention.** Chaque requête écrit son `WHERE group_id = ?`, la revue le vérifie,
   un test par route le prouve. Coût nul à l'écriture, fiabilité dépendante de l'attention
   humaine, et les tests écrits à la main se dégradent avec le nombre de routes.
2. **Verrous empilés** (retenue). Le groupe est dans l'URL ; un objet de contexte non
   falsifiable est fabriqué par un seul intergiciel ; les fonctions de requête n'acceptent pas
   d'identifiant de groupe en paramètre, seulement ce contexte ; la base refuse l'incohérence
   par des clés étrangères composites ; une boucle de test couvre toutes les routes depuis un
   registre dont la complétude est elle-même testée.
3. **Une base par groupe.** Étanchéité physique, et le problème disparaît. Mais une personne
   dans trois groupes devient trois connexions, les sauvegardes se multiplient, et l'agrégation
   (iCal multi-groupes, notifications, « mes groupes ») devient un travail à part entière.

## Décision

**Option 2**, détaillée dans [`04 - Architecture.md`](../../Dossier%20de%20conception/04%20-%20Architecture.md) §4 :
cinq verrous indépendants, dont deux font échouer la **compilation** (`GroupScope` obligatoire
en premier paramètre, aucun `groupId: string`) et un fait échouer l'**écriture en base** (clés
étrangères composites `(id, group_id)`).

## Conséquences

- Une colonne `group_id` dénormalisée sur chaque table enfant, et un `UNIQUE (id, group_id)` sur
  chaque parent : coût en place, gain en intégrité. Vérifié sur SQLite 3.54 (§5.1 du modèle de
  données) : sept écritures illégitimes refusées par la base.
- `db/` est le seul dossier autorisé à écrire du SQL, et une règle ESLint l'impose.
- Un groupe étranger renvoie **404**, jamais 403 : on ne confirme pas son existence. Un droit
  manquant dans **mon** groupe renvoie 403. Les deux codes ne se croisent pas.
- `users.is_instance_admin` n'est jamais lu par la couche de cloisonnement : l'administrateur de
  l'instance n'accède pas au contenu des groupes.
- Une exception documentée : `personal_events`, qui appartient à une personne et non à un
  groupe ; la cloison est portée par `personal_event_shares`. Elle est inscrite en dur dans le
  test de schéma, donc toute nouvelle exception se voit en revue.
- Ajouter une route sans l'inscrire au registre de cloisonnement **casse l'intégration
  continue**, donc la publication de l'image.

## Ce qui rendrait cette décision fausse

Si le `GroupScope` devenait un passe-plat qu'on contourne régulièrement (« juste cette
requête-là »), le dispositif serait pire que la convention simple : il donnerait une fausse
assurance. Signal à surveiller : toute apparition d'une fonction de requête prenant un
`groupId: string`, ou tout usage de `db.prepare` hors de `db/`.
