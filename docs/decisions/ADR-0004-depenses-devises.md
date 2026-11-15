# ADR-0004 — Dépenses partagées : multi-devises, aucun flux bancaire

- **Date** : 2026-11-15
- **Statut** : Acceptée
- **Décidé par** : Théo

## Contexte

Le partage des dépenses entre d'entrée de jeu dans la V1. Le groupe part parfois en voyage,
donc une dépense n'est pas toujours en euros. En revanche, l'application ne doit à aucun
moment toucher à de l'argent réel.

## Décision

1. **Aucun flux bancaire, définitivement.** Pas de prestataire de paiement, pas de cagnotte,
   pas d'IBAN ni de coordonnées bancaires stockées. L'application calcule et affiche qui doit
   combien à qui ; **les remboursements se font exclusivement hors de l'application**, par les
   moyens que les gens utilisent déjà.
2. **Plusieurs devises.** Les montants sont stockés en **unités mineures entières** (centimes)
   avec leur **code ISO 4217** — jamais en nombre à virgule flottante, qui fait dériver les
   soldes. Chaque dépense porte sa devise ; un groupe a une devise par défaut, un événement
   peut en avoir une autre.
3. **Le taux de change est figé au moment de la saisie** et conservé avec la dépense. Un solde
   passé ne doit jamais bouger parce que le marché a bougé. Le taux est saisi à la main, ou
   proposé par un service de taux au moment de la saisie puis figé.
4. **Les soldes s'affichent dans la devise de l'événement**, et une bascule permet de les voir
   dans la devise par défaut du groupe.

## Devises retenues au départ

Euro (EUR), dollar américain (USD), livre sterling (GBP), franc suisse (CHF), dollar canadien
(CAD), yen japonais (JPY), **yuan renminbi (CNY)**, peso mexicain (MXN), dollar australien
(AUD), couronne suédoise (SEK), couronne norvégienne (NOK), couronne danoise (DKK), zloty
polonais (PLN), couronne tchèque (CZK), dirham marocain (MAD), baht thaïlandais (THB), livre
turque (TRY).

> Au passage : la monnaie chinoise est le **yuan** (renminbi), pas un yen — le yen est
> japonais. La liste ci-dessus est à valider ou à élaguer ; en ajouter une plus tard ne coûte
> rien, puisque c'est une simple donnée de référence.

## Conséquences

- Toute somme manipulée dans le code est un **entier d'unités mineures** et porte sa devise.
  Additionner deux montants de devises différentes doit être une **erreur**, pas une
  conversion implicite.
- Les devises sans sous-unité (le yen, par exemple) doivent être gérées correctement à
  l'affichage et à la saisie.
- L'arrondi des répartitions est explicite : la somme des parts doit toujours égaler le total,
  au centime près, et le reliquat est attribué de façon déterministe.
- Des tests portent spécifiquement sur les soldes : une suite de dépenses et de parts doit
  toujours se solder à zéro.
- Aucune donnée bancaire n'étant stockée, le projet reste hors du champ des obligations liées
  aux services de paiement.
