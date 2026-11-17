# 02 — Périmètre et jalons — Attroupe

> Décidé le 2026-11-15. Les numéros renvoient au menu
> [`01 - Fonctionnalites proposees.md`](01%20-%20Fonctionnalites%20proposees.md).
> Ce document est la référence : en cas de désaccord avec le menu, c'est lui qui gagne.

## V1 — ce que la première version doit faire

C'est volontairement ambitieux : les dépenses partagées et l'agenda personnel ont été
remontés depuis la V2, parce qu'ils portent une grande part de la valeur réelle.

### Le socle
- **A1 Comptes et groupes** — inscription ouverte, création d'un groupe, invitation par
  e-mail. Un compte appartient à plusieurs groupes et bascule de l'un à l'autre. Un membre
  déjà inscrit s'ajoute par **nom d'utilisateur ou e-mail exact**, sans recréer de compte :
  l'ajout produit une invitation qu'il accepte ou refuse, et il n'existe aucun annuaire
  consultable.
- **A2 Rôles** — administrateur du groupe, membre, organisateur d'un événement.
- **A3 Multi-groupes étanches** — plusieurs groupes indépendants sur la même instance
  (voir [`ADR-0002`](../docs/decisions/ADR-0002-multi-groupes.md)).
- **Membres mouvants** — on ajoute et on retire des gens ; un départ ne doit pas effacer
  l'historique (ses dépenses passées, ses photos, sa présence aux soirées restent).

### Le planning
- **B1 Agenda du groupe** — vues mois / semaine / liste.
- **B2 Réponses de présence** — je viens / peut-être / pas là, avec compteur.
- **B3 Abonnement iCal** — une URL privée par membre, à coller dans le calendrier du téléphone.
- **B4 Agenda personnel** — ses propres événements, partagés soit en détail, soit en simple
  « occupé ».
- **B5 Sondage de dates** — plusieurs créneaux proposés, chacun coche, le gagnant devient un
  événement. Seuls son auteur et un administrateur du groupe le modifient, l'annulent ou le
  convertissent ; tout membre vote.
- **B6 Détection des disponibilités** à partir des agendas personnels, remontée depuis la V2
  pendant l'implémentation (voir [`ADR-0012`](../docs/decisions/ADR-0012-push-navigateur.md)).

### Les soirées et sorties
- **C1 Événement riche** — lieu, hôte, horaires, consignes.
- **C2 Liste de courses** — article, quantité, qui le prend, cases à cocher en temps réel.
- **C5 Partage des dépenses** — qui a payé quoi, calcul de qui doit combien à qui, soldes par
  membre, clôture des comptes d'un événement, **multi-devises** (voir
  [`ADR-0004`](../docs/decisions/ADR-0004-depenses-devises.md)). Aucun flux bancaire : les
  remboursements se font hors de l'application.
- **C7 Tâches de l'événement** — ce qui ne s'achète pas (réserver, apporter l'enceinte, les clés).
- **Fils de discussion** — un fil par événement, plus des fils libres dans le groupe, pour ne
  pas tout mélanger dans une seule conversation.

### Les photos
- **D1 Albums par événement** et albums libres.
- **D8 Vidéos** — portées par Immich comme les photos, sans transcodage de notre côté. Elles
  figuraient à tort en « écarté » alors que le même document les réintégrait deux lignes plus bas.
- **D4 Dépôt direct** — glisser-déposer et sélection multiple depuis le téléphone.
- **D5 Vignettes et visionneuse**.
- **D11 Intégration Immich** — Immich tourne **à part** ; chaque groupe branche une instance
  par son URL et une clé d'API. C'est Immich qui stocke, indexe et sert les photos et les
  vidéos ; l'application crée les albums et les rattache aux événements
  (voir [`ADR-0003`](../docs/decisions/ADR-0003-photos-immich.md)).

### Technique
- **F1 PWA** installable, mobile d'abord.
- **F2 Notifications par e-mail**, et **push navigateur** remonté depuis la V2 pendant
  l'implémentation (voir [`ADR-0012`](../docs/decisions/ADR-0012-push-navigateur.md)).
- **F3 Installation en une commande Docker**.
- **F5 Sauvegarde et restauration** — base + photos.
- **F6 Authentification** — inscription et mot de passe, invitations par e-mail (Brevo),
  **connexion Google en V2**.
- Interface en **français**, textes externalisés.

## V2 — juste après

- **A4 Mur du groupe** — fil général, réactions.
- **B7 Événements récurrents**, **B8 anniversaires**.
- **C3 Modèles de listes**, **C4 regroupement par rayon**.
- **C6 Covoiturage**, **C8 idées de sorties**, **C10 météo du jour J**.
- **D3 Rangement automatique par date**, **D6 réactions et commentaires**,
  **D7 liens de partage** révocables, **D9 « il y a un an »**.
- **E1 Statistiques du groupe**, **E2 sondages libres**, **E4 compte à rebours**.
- **F7 journal d'audit**, **F8 export et suppression de ses données**.
- **Connexion Google** (si elle n'est pas prête en V1).

## Plus tard

- **B9 Import d'invitations `.ics`**, **C9 mode week-end / voyage**, **C11 playlist**,
  **D10 carte des sorties**, **E3 badges**.

## Écarté pour l'instant

- **Tout flux bancaire** — ni paiement, ni IBAN, ni cagnotte. Définitif.

## Points encore ouverts

| # | Question | Impact |
|---|---|---|
| 1 | Le **sous-domaine** public, et l'achat éventuel d'un domaine `attroupe` | Reverse proxy, lien d'invitation |
| 2 | **Disponibilité du nom** « Attroupe » : GitHub, domaines, boutiques, INPI | À vérifier avant publication |
| 3 | **Ressources** des conteneurs 112 et 113 (RAM, disque) | Dimensionnement |
| 5 | **Quelles devises** exactement, et conversion à quel taux | `ADR-0004` |
