# Système d'agents et de sous-agents

Objectif : **consommer le moins de tokens possible** sans perdre en qualité.
Principe directeur : *le bon modèle, au bon endroit, avec le contexte le plus maigre possible.*

## 1. Pourquoi ça économise

Trois mécanismes, par ordre d'impact :

1. **Isolation du contexte — le gros levier.** Quand un sous-agent lit 40 fichiers ou scrape
   10 pages, ces dizaines de milliers de tokens restent dans *sa* fenêtre. L'orchestrateur ne
   reçoit que la conclusion. Sans sous-agents, tout ce bruit s'accumule dans une seule
   conversation, rejouée à chaque tour, et payée au tarif du modèle le plus cher.
2. **Routage par modèle.** Lire, chercher, grep, scraper : aucun besoin de raisonnement.
   Haiku fait ça à une fraction du prix. Opus est réservé aux moments où le raisonnement
   crée réellement de la valeur.
3. **Contexte maigre à la racine.** La conversation principale ne garde que le plan et les
   synthèses, jamais les données brutes.

## 2. Matrice de routage

| Agent | Rôle | Modèle | Identifiant | Outils | Écriture |
|---|---|---|---|---|---|
| **Orchestrateur** (session principale) | Planification, découpage en tâches atomiques, coordination, logique métier critique (webhooks, synchronisation, état avancé), décision finale | Claude Opus 5.5 | `claude-opus-5-5` | tous | oui |
| **`architecte`** | Architecture initiale (stack, modèle de données, structure globale), débogage transversal front/back/DB, performance et concurrence, refactoring majeur et migrations | Claude Opus 5 | `claude-opus-5` | Read, Grep, Glob, Bash | non |
| **`reviewer`** | Audit du code produit par les agents de rang inférieur, sécurité (auth, permissions, paiements), cohérence globale | Claude Opus 5.5 | `claude-opus-5-5` | Read, Grep, Glob, Bash | non |
| **`dev`** | Développement courant : routes API, composants UI, services métier, SQL/ORM, tests unitaires/intégration/E2E, refactoring ciblé, typage strict | Claude Sonnet 5.5 | `claude-sonnet-5-5` | Read, Write, Edit, Grep, Glob, Bash | oui |
| **`explorateur`** | Exploration de la codebase : recherche de fichiers, cartographie des dépendances, lecture de la doc interne avant transmission à `dev` ou `architecte` | Claude Haiku 5.5 | `claude-haiku-5-5` | Read, Grep, Glob, Bash (lecture) | non |
| **`scraper`** | Documentation externe, pages web, changelogs, références d'API | Claude Haiku 5.5 | `claude-haiku-5-5` | WebFetch, WebSearch, Read | non |
| **`utilitaire`** | Boilerplate et configuration, schémas de validation simples, types de base, squelettes de composants, lint et formatage, analyse des logs de build, messages de commit, mise à jour des README | Claude Haiku 5.5 | `claude-haiku-5-5` | Read, Write, Edit, Grep, Glob, Bash | oui (mécanique) |

> **Note de compatibilité.** Les identifiants complets ci-dessus distinguent Opus 5 d'Opus 5.5,
> ce que les alias (`opus`, `sonnet`, `haiku`, `inherit`) ne permettent pas. Si une version de
> Claude Code refuse un identifiant complet dans l'en-tête YAML, revenir à l'alias du même
> palier (`opus` / `sonnet` / `haiku`) — le routage par palier reste valable.

## 3. L'arbre de décision

```
La tâche demande-t-elle du raisonnement, de l'arbitrage ou du jugement ?
│
├─ NON → volume élevé, travail mécanique
│        ├─ dans le code ............................ explorateur  (Haiku)
│        ├─ sur le web .............................. scraper      (Haiku)
│        └─ gabarit / config / lint / logs / commit . utilitaire   (Haiku)
│
└─ OUI → quelle nature de valeur ?
         ├─ Écrire ou modifier du code .............. dev          (Sonnet 5.5)
         ├─ Vérifier sécurité / logique / cohérence . reviewer     (Opus 5.5)
         ├─ Concevoir, arbitrer, débloquer .......... architecte   (Opus 5)
         └─ Planifier, coordonner, décider .......... orchestrateur (Opus 5.5)
```

## 4. Flux de travail type (une fonctionnalité de bout en bout)

```
1. Orchestrateur (Opus 5.5)
     └─ découpe en tâches atomiques, rédige les briefs autonomes

2. explorateur (Haiku) ─── en parallèle ─── scraper (Haiku)
     └─ localisent le code concerné / ramènent la doc externe
        → deux synthèses courtes remontent, pas le bruit

3. architecte (Opus 5)       [seulement si la conception n'est pas tranchée]
     └─ plan technique à partir des synthèses → ADR si décision structurante

4. dev (Sonnet 5.5)
     └─ implémente le plan + tests, les lance

5. reviewer (Opus 5.5)
     └─ relit le diff : correction, sécurité, cohérence → verdict

6. Orchestrateur
     └─ vérifie le diff lui-même, relance les tests, synthétise
```

## 5. Deux modes de délégation

- **Sous-agent frais** (par défaut) : démarre à froid, sans l'historique. Le moins cher, mais
  exige un brief complet et autonome. Le bon choix pour recherche, scraping, lecture, et la
  plupart des implémentations.
- **Fork** : hérite de tout le contexte de l'orchestrateur et tourne sur son modèle. Pratique
  quand la tâche s'appuie lourdement sur la conversation, **coûteux** car il recharge tout.
  À réserver aux cas où re-briefer coûterait plus que de forker.

## 6. Anti-gaspillage

- Un brief mal fait = l'agent re-cherche tout = tokens perdus.
- Exiger des rapports **courts et formatés** (chemins + lignes + fait, pas de dump).
- Lecture seule par défaut : l'écriture est concentrée sur `dev`, `utilitaire` et l'orchestrateur.
- Ne pas forker par réflexe.
- Paralléliser ce qui est indépendant.
- Déléguer par **tâche cohérente**, pas par micro-étape : dix délégations minuscules coûtent
  plus cher qu'une seule bien cadrée.

## 7. Pièges connus

- **Démarrage à froid** : s'il faut beaucoup de contexte pour une petite tâche, déléguer est
  contre-productif. Fais-la toi-même.
- **Rapport ≠ preuve** : vérifier le diff et les tests avant d'annoncer un résultat.
- **Review descendante** : faire relire du Sonnet par du Haiku ne sécurise rien.
- **Sur-fragmentation** : un agent par micro-étape fait exploser le coût de mise en route.

## 8. Mise en service et mesure

1. Les six fichiers d'agents sont en place dans `.claude/agents/`.
   > **Important** : Claude Code charge les définitions d'agents **au démarrage de la session**.
   > Des agents ajoutés en cours de session ne sont pas visibles avant un redémarrage
   > (nouvelle session, ou relance de `claude`).
2. Tester sur une vraie tâche : une recherche (`explorateur`), puis une conception
   (`architecte`), puis une implémentation (`dev`) + review (`reviewer`).
3. Mesurer : comparer la consommation d'une tâche faite « tout en Opus » et via le pipeline
   (`/cost`, ou `mcp__ccd_session_mgmt__get_usage`).
4. Itérer sur les prompts : plus les rapports sont serrés, plus on économise.
