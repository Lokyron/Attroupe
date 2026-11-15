# ADR-0001 — Stack technique et mono-conteneur

- **Date** : 2026-11-15
- **Statut** : Acceptée
- **Décidé par** : Théo, sur proposition de l'orchestrateur

## Contexte

Exigence de départ : **installation en une seule commande Docker**, auto-hébergement sur un
LXC du homelab, dépôt public pour que d'autres puissent l'installer. L'écosystème maison
(Glassboard, Lucie Cowork, Parkour Mailer) tourne déjà en Node + SQLite, avec React côté
interface sur les projets récents.

## Options envisagées

1. **Node + Express + SQLite + React/Vite, un seul conteneur.** Une base dans un fichier, un
   volume, un service. La « commande unique » est réellement unique.
2. **Node + Express + PostgreSQL + React/Vite.** Plus solide sur les écritures concurrentes et
   les requêtes complexes, mais impose un second conteneur, une orchestration, des sauvegardes
   en deux morceaux — et rend l'installation par un tiers nettement moins triviale.

## Décision

**Option 1.** Node 24, Express, SQLite, React avec Vite, dans une seule image.

## Conséquences

- La sauvegarde est un fichier plus un dossier de photos : simple à automatiser, simple à
  restaurer.
- Les écritures sont sérialisées. À l'échelle visée (quelques groupes de quelques dizaines de
  personnes), ce n'est pas un problème. Le mode WAL est activé d'office.
- Les accès à la base passent par une couche d'accès unique, pour qu'une migration vers
  PostgreSQL reste possible sans réécrire le métier.
- Les requêtes sont écrites en SQL explicite, pas via un ORM lourd : moins de magie, moins de
  surprises de performance.

## Ce qui rendrait cette décision fausse

Une instance publique partagée par de nombreux groupes actifs simultanément, ou le besoin de
recherche plein texte et de requêtes analytiques lourdes. Si l'intégration Immich impose déjà
un PostgreSQL dans la pile ([`ADR-0003`](ADR-0003-photos-immich.md)), l'argument « un seul
conteneur » s'affaiblit et cette décision méritera d'être rouverte.
