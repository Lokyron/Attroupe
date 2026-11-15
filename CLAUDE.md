# Attroupe — règles de travail

> **Attroupe** (nom de code interne : *ACB*) — organisateur auto-hébergé pour groupes d'amis.
> Cadrage fait : lis `Dossier de conception/02 - Perimetre et jalons.md` et les ADR de
> `docs/decisions/` avant d'écrire du code. Les décisions y sont, ne les re-débats pas.

## Les deux règles qui ne se discutent pas

1. **Cloisonnement des groupes.** Chaque table métier porte son groupe, et **chaque** requête
   filtre dessus. Un filtre oublié est une fuite de données entre groupes. Toute route porte
   un test qui prouve qu'un membre du groupe A ne peut ni lire ni écrire une ressource du
   groupe B, même en forgeant l'identifiant.
2. **Aucun flux bancaire.** On affiche qui doit combien à qui ; les remboursements se font
   hors de l'application. Pas d'API de paiement, pas d'IBAN stocké, jamais.

## Langue

Tout en **français** : réponses, commentaires de code, messages de commit, documentation.
Les identifiants du code (variables, fonctions, tables) restent en anglais, sauf si le
code existant fait l'inverse.

## Le système d'agents (lis `docs/AGENTS.md` avant de déléguer)

Six sous-agents sont définis dans `.claude/agents/`. La règle, en une phrase :
**le travail mécanique et volumineux descend, la review monte.**

| Besoin | Agent | Modèle |
|---|---|---|
| Chercher, localiser, cartographier dans le code | `explorateur` | Haiku 5.5 |
| Récupérer de la doc ou une page web | `scraper` | Haiku 5.5 |
| Boilerplate, config, lint, logs, message de commit | `utilitaire` | Haiku 5.5 |
| Écrire une fonctionnalité, une API, une UI, des tests | `dev` | Sonnet 5.5 |
| Relire : sécurité, correction, cohérence | `reviewer` | Opus 5.5 |
| Architecture, bug transversal, refonte lourde | `architecte` | Opus 5 |

Moi, l'orchestrateur (Opus 5.5), je **planifie, délègue, synthétise et décide**. Je garde
mon contexte maigre : les données brutes (fichiers lus, pages scrapées, sorties d'outils)
restent chez les sous-agents, je ne remonte que leurs rapports.

### Garde-fous

- **Jamais Opus pour lire.** Une étape qui produit « j'ai trouvé X dans le fichier Y » part
  à l'`explorateur`.
- **Toute écriture de code produite par `dev` passe au `reviewer`** avant d'être annoncée
  comme terminée. On ne fait jamais relire du Sonnet par du Haiku.
- **Un rapport n'est pas une preuve.** Avant de dire « c'est fait » : relire le diff, lancer
  les tests.
- **Ne pas sur-déléguer.** Une question simple, une seule lecture, un `grep` : je le fais
  moi-même. Un sous-agent démarre à froid, ça a un coût.
- **Briefs autonomes.** Un sous-agent frais ne voit pas notre conversation : son brief dit
  quoi faire, où, et à quoi ressemble « terminé ».
- **Paralléliser l'indépendant** : `explorateur` et `scraper` partent dans le même tour.

## Conventions de code

- Pas de dépendance nouvelle sans que ce soit demandé ou justifié dans une ADR.
- Typage strict. Pas de `any`, pas d'erreur avalée silencieusement.
- Les secrets vivent dans `.env` (jamais versionné) ; `.env.example` liste les clés avec
  des valeurs factices.
- Tests écrits en même temps que le code, et lancés. Un échec se rapporte avec sa sortie.

## Git

- Branche de travail par sujet, jamais de commit direct sur `main` sans demande explicite.
- Messages de commit en français, à l'impératif, sujet sous 72 caractères.
- Je ne commite et ne pousse **que** si tu me le demandes.

## Documentation — à tenir à jour

| Fichier | Quand le mettre à jour |
|---|---|
| `DOCUMENTATION.md` | Fiche de reprise en 8 sections — à chaque changement de stack, d'arborescence, d'env ou d'endpoint |
| `Dossier de conception/` | Vision, périmètre, règles métier, modèle de données |
| `Avancement du projet/AVANCEMENT.md` | À chaque jalon terminé |
| `docs/decisions/` | Une ADR par décision structurante (format : `ADR-000N-sujet.md`) |
| `docs/AGENTS.md` | Si le routage des modèles change |

Avant de modifier l'infrastructure ou l'architecture : **lire la doc d'abord** (anti-doublon),
la mettre à jour ensuite.
