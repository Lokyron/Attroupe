# ADR-0015 — Les tokens du design system et la cible navigateur

- **Date** : 2026-11-20
- **Statut** : Acceptée (phase 2 de l'audit UI/UX, point 12)
- **Décidé par** : l'orchestrateur, sur le travail du `dev` et deux passes de `reviewer`

## Contexte

L'audit `docs/audits/2026-11-18-ui-ux-frontend.md` (entrée M18) a mesuré l'écart entre les tokens déclarés et
l'usage réel de `app/client/src/styles.css`, la feuille unique et globale du projet — il n'y a ni Tailwind, ni
bibliothèque de composants, ni préprocesseur. Le constat : **21 variables dans `:root`**, et en face **83 couleurs
littérales distinctes** hors `:root`, 12 rayons, 16 ombres, 29 tailles de police, et 39 % des espacements hors
d'une grille de 4 px. Aucun token d'espacement, de taille, de z-index, de transition ni de flou. Sept familles de
classes de teinte redéclaraient le même mapping dans une soixantaine de règles.

La conséquence était chiffrée et vérifiée : corriger les contrastes demandait plus de trente modifications au lieu
de quatre, et **le mode sombre était hors d'atteinte** — une couleur écrite en dur dans une règle ne peut pas être
redéfinie sous `prefers-color-scheme: dark`.

## Décisions

1. **Des échelles complètes de tokens, nommées en français**, dans `:root` : couleurs, espacements sur une grille
   de 4 px (plus un demi-pas de 2 px, assumé, pour les valeurs que ni 0 ni 4 px ne rendent), rayons
   (`--rayon-s/m/l/pilule`), ombres, tailles de police, z-index (`--z-entete/nav/modale`), durées et flous.
   Résultat mesuré : **0 couleur littérale hors `:root`**, 12 rayons → 5, 29 tailles → 9, espacements hors grille
   154/394 → 11/394.

2. **Un seul `--c` par élément porteur de couleur.** Un bloc unique associe chaque classe de teinte à `--c`,
   `--c-clair`, `--c-texte` et `--c-fort`, pour les familles `couleur-*`, `icone-*`, `kpi-*`, `kpi-badge-*`,
   `vignette-date-*`, `source-*`, `badge-*` et `bordure-*`. Une soixantaine de règles deviennent huit. Le mode
   sombre se règle donc, pour les teintes, à un seul endroit.

3. **Un rôle, un token.** Deux couplages ont été défaits parce qu'ils auraient rendu le mode sombre impossible :
   `--c-fort` du cyan référençait `--accent-cyan-texte` (un token de *texte* servant de *fond* sous du blanc), et
   `--c-texte` de l'indigo référençait `--primaire` (qui habille aussi les boutons à texte blanc). D'où
   `--accent-cyan-fort` et `--primaire-texte`. Même raison pour `--accent-negatif-fort` et `--accent-positif-fort`,
   qui gardent la couleur d'origine des fonds de boutons dont le texte a dû être assombri.

4. **Les dérivés dérivent.** Les `*-clair`, `--bordure` et les `--verre-*` sont des `color-mix` de leur base, au
   lieu de recopier son triplet en `rgba`. Redéfinir une base suffit ; sans cela, une base redéfinie et son
   dérivé oublié se désynchronisent en silence.

5. **La cible navigateur est fixée, et c'est la première du projet.** Il n'existait **aucun `browserslist`**, donc
   aucune cible déclarée. L'usage de `color-mix()` (71 fois) la rend nécessaire : **Chrome 111+, Safari 16.4+,
   Firefox 113+**, soit le premier semestre 2023. Safari 16.4 plutôt que 16.2 parce que c'est déjà la version
   qu'exige le push web sur iOS en PWA, fonctionnalité que le projet utilise (lot 12, ADR-0012 — qui ne consigne
   pas ce prérequis : il est consigné ici).

6. **Un repli ciblé là où la panne rendrait du texte illisible, nulle part ailleurs.** Le mode de défaillance de
   `color-mix()` a été établi précisément : nos 71 usages contiennent tous un `var()`, donc la déclaration est
   acceptée à l'analyse puis devient invalide au calcul, et la propriété repasse à `unset`. **Une déclaration
   littérale placée juste avant ne sert donc pas de repli** — seul un token redéfini sous `@supports` fonctionne.
   Cinq tokens de voile sur photo et de fond de visionneuse portent donc une valeur `rgba` dans `:root`,
   surchargée en `color-mix` sous `@supports`. Sans eux, un navigateur trop ancien afficherait du texte blanc
   posé directement sur une photo, et un anneau de focus blanc sur une visionneuse sans fond. Les ombres et les
   effets de verre n'ont **pas** de repli : leur perte est cosmétique, et la protection a un coût de lisibilité
   du fichier.

## Conséquences

- **Le mode sombre devient une redéfinition de tokens**, et c'est le critère de réussite réel de ce chantier.
  Deux réserves à connaître : le bloc `@supports` des voiles doit être redéfini lui aussi, sinon sa surcharge
  repasse devant ; et `<meta name="theme-color" content="#4338ca">` est figé dans `index.html`, hors CSS.
- **Les contrastes ont été corrigés pour de bon**, et le chantier a révélé que la passe précédente ne l'avait pas
  fait : elle mesurait sur fond blanc, qui n'existe nulle part dans l'application. Sur les fonds réellement
  composés — dégradé radial de `body::before`, verre, `--primaire-clair` de la case du jour, puis la teinte — le
  cyan tombait à 3,72:1, le violet à 3,80, l'émeraude à 3,79, pour du texte de 0,7 rem où le seuil de 4,5:1
  s'applique. Quatre tokens de texte ont été assombris ; le pire cas est remonté entre 4,6 et 5,3:1, vérifié deux
  fois par deux calculs indépendants. **Leçon à retenir : un ratio de contraste se calcule sur le fond composé,
  jamais sur la surface nominale.**
- **230 changements de rendu assumés** (tailles de police, espacements, rayons, ombres, flous), journalisés valeur
  par valeur, plus environ 24 changements de couleur de texte issus de la correction des contrastes. Aucun n'est
  une régression de mise en page : les deux `calc` touchés sont des marges d'anneau de focus sur des bandeaux à
  défilement, le plus petit corps de texte **remonte** de 0,62 à 0,7 rem, et le seul `env(safe-area-inset-bottom)`
  concerné garde son terme `env()` intact.
- **`.bordure-indigo` est réparée au passage** : la classe était posée par `pages/tableau/GrilleMois.tsx` sans
  aucune règle, et un événement d'un groupe indigo prenait le bleu de l'agenda avec un liseré indigo.

## Ce que la vérification couvre, et ce qu'elle ne couvre pas

L'iso-rendu a été établi par comparaison des **styles calculés sous Chrome headless**, sur 573 paires de
déclarations et 75 fragments de DOM reproduisant les structures des composants pour les six teintes. C'est une
preuve d'équivalence des **valeurs hors contexte**, pas de la cascade ; elle vaut ici parce que la structure des
sélecteurs a été vérifiée inchangée par ailleurs (554 → 563 couples, les seuls disparus étant les dix sélecteurs
doublement qualifiés remplacés par le bloc de teintes) et qu'aucune unité `em` ou `%` n'a été convertie.

Ne sont **pas** couverts : les pseudo-classes (`:hover`, `:focus-visible`, `:active`, `:disabled`) et les états
`aria-*` en tant qu'états réels de l'arbre, `::before`/`::after`, les points de rupture, `prefers-reduced-motion`,
la cascade réelle dans l'arbre complet, le comportement sans `color-mix`, et le jugement esthétique. Aucun de ces
points n'est vérifiable sans ouvrir l'application dans un navigateur.

## Alternatives écartées

- **Adopter Tailwind, ou un préprocesseur.** C'est une dépendance et un outil de build de plus pour un problème
  que des variables CSS natives résolvent. L'ADR-0001 a tranché une stack volontairement mince.
- **Un repli `@supports` pour les 71 usages.** Le coût en lisibilité du fichier dépasse le bénéfice : la perte
  d'une ombre ou d'un effet de verre ne gêne personne, et seuls cinq tokens avaient une conséquence sur la
  lisibilité d'un texte.
- **Ne pas fixer de cible navigateur et éviter `color-mix`.** Cela revenait à continuer de recopier un triplet
  `rgba` par alpha — la cause même de M18, avec onze recopies du seul indigo.
- **Harmoniser les alphas voisins** (14 % contre 12 % pour un fond cyan, 22 % contre 24 % pour une bordure). Ces
  écarts sont conservés tels quels et signalés : ils changent le rendu sans qu'on sache s'ils étaient voulus.
