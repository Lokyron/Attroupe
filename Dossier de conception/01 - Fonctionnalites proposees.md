# 01 — Fonctionnalités proposées

> **Statut : menu à trier, pas un engagement.** Chaque entrée porte une colonne *Jalon* que
> nous remplirons ensemble : `V1` (indispensable au premier usage réel), `V2` (juste après),
> `Plus tard`, ou `Non` (écarté — et on garde la ligne, savoir ce qu'on a refusé a de la valeur).

## A. Le socle du groupe

| # | Fonctionnalité | Ce que ça apporte | Jalon |
|---|---|---|---|
| A1 | **Groupe et membres** — invitation par lien ou code, profil léger (prénom, photo, anniversaire) | L'unité de base de toute l'app | V1 |
| A2 | **Rôles minimaux** — admin d'instance, membre, organisateur d'un événement | Évite le bazar sans bureaucratie | V1 |
| A3 | **Plusieurs groupes** sur la même instance (la bande, les collègues, la coloc) | Réutilisable, mais complexifie tout le modèle de données | à trancher |
| A4 | **Mur du groupe** — fil de messages courts, réactions, commentaires sous les photos et les événements | Le lieu où il se passe quelque chose quand il n'y a pas de soirée prévue | V2 |

## B. Le planning

| # | Fonctionnalité | Ce que ça apporte | Jalon |
|---|---|---|---|
| B1 | **Agenda commun du groupe** — vue mois / semaine / liste, événement avec lieu, horaire, organisateur | Le cœur | V1 |
| B2 | **Réponses de présence** — je viens / peut-être / pas là, avec un compteur visible | Savoir combien on est, enfin | V1 |
| B3 | **Abonnement iCal / CalDAV** — une URL privée par membre à coller dans le calendrier du téléphone | *La* fonctionnalité « ne pas perturber les habitudes » | V1 |
| B4 | **Agenda personnel** — ses propres événements, avec deux niveaux de partage : « occupé » (sans détail) ou visible du groupe | Permet de trouver une date sans exposer sa vie | V1 ou V2 |
| B5 | **Sondage de dates** — on propose trois créneaux, chacun coche, le gagnant devient un événement | Remplace les 40 messages « moi je peux pas jeudi » | V1 |
| B6 | **Détection des disponibilités** — à partir des agendas perso, l'app propose les créneaux où tout le monde est libre | Le petit miracle qui fait adopter l'app ; dépend de B4 | V2 |
| B7 | **Événements récurrents** — le foot du mardi, l'apéro du premier vendredi | Confort | V2 |
| B8 | **Anniversaires** — rappel automatique, et proposition de monter quelque chose | Peu cher, très apprécié | V2 |
| B9 | **Import d'invitations `.ics`** reçues par mail vers l'agenda du groupe | Cohérent avec l'approche IMAP | Plus tard |

## C. Les soirées et sorties (l'objet central)

| # | Fonctionnalité | Ce que ça apporte | Jalon |
|---|---|---|---|
| C1 | **Événement riche** — lieu, hôte, heure d'arrivée, thème, places de couchage, consignes | Toute l'info au même endroit | V1 |
| C2 | **Liste de courses attachée** — article, quantité, **qui le prend** (case à cocher), temps réel | Demandé explicitement | V1 |
| C3 | **Modèles de listes** — « apéro type », « barbecue », « week-end » pré-remplis | On ne refait pas la liste à chaque fois | V2 |
| C4 | **Regroupement par rayon** et quantités cumulées | Utile une fois dans le magasin | V2 |
| C5 | **Partage des dépenses** — qui a payé quoi, calcul automatique de qui doit combien à qui (façon Tricount), lien de remboursement | Le deuxième sujet de friction d'un groupe d'amis, après les dates | V1 ou V2 |
| C6 | **Covoiturage** — qui prend sa voiture, places libres, point et heure de rendez-vous | Évite un fil de messages entier | V2 |
| C7 | **Tâches de l'événement** — qui réserve, qui apporte l'enceinte, qui récupère les clés | Comme C2 mais pour ce qui ne s'achète pas | V1 |
| C8 | **Idées de sorties** — un backlog d'envies (un bar, une rando, un concert), votable, qu'on transforme en événement quand c'est mûr | Alimente le planning au lieu d'attendre l'inspiration | V2 |
| C9 | **Mode week-end / voyage** — plusieurs jours, programme heure par heure, budget, checklist de bagages | Pour les sorties à la journée ou plus | Plus tard |
| C10 | **Météo du jour J** sur l'événement extérieur | Déjà fait dans Glassboard, réutilisable | V2 |
| C11 | **Playlist collaborative** liée à l'événement (lien Spotify/Deezer, ou file d'attente maison) | Gadget assumé | Plus tard |

## D. Les photos et les souvenirs

| # | Fonctionnalité | Ce que ça apporte | Jalon |
|---|---|---|---|
| D1 | **Albums** — un par événement (créé automatiquement), plus des albums libres | Le « après » de la soirée | V1 |
| D2 | **Dépôt par e-mail (IMAP)** — chaque album a une adresse ; on partage la photo par mail depuis la pellicule, elle arrive dans l'album | Demandé explicitement ; c'est le canal « sans changer ses habitudes » | V1 |
| D3 | **Rangement automatique par date** — la date EXIF de la photo la place dans l'album de la soirée correspondante | Personne n'a à choisir l'album | V1 ou V2 |
| D4 | **Dépôt direct** — glisser-déposer sur le web, sélection multiple depuis le téléphone | Le chemin classique | V1 |
| D5 | **Miniatures et visionneuse** — vignettes générées, affichage plein écran, téléchargement de l'original | Indispensable dès qu'il y a 200 photos | V1 |
| D6 | **Réactions et commentaires** sur les photos | Fait vivre l'album | V2 |
| D7 | **Lien de partage** d'un album vers l'extérieur, révocable et expirable | Pour l'ami qui n'est pas sur l'instance | V2 |
| D8 | **Vidéos courtes** | Lourd (transcodage, stockage) — à décider en connaissance de cause | à trancher |
| D9 | **« Il y a un an »** — rétrospective automatique des souvenirs du jour | Le rappel qui ramène le groupe dans l'app | V2 |
| D10 | **Carte des sorties** — les événements passés placés sur une carte | Joli, et étonnamment motivant | Plus tard |
| D11 | **Intégration Immich** — déléguer le stockage photo à Immich plutôt que de le refaire | À évaluer : gagne en qualité, perd en simplicité d'installation | à trancher |

## E. Ce qui fait sourire (et fait revenir)

| # | Fonctionnalité | Ce que ça apporte | Jalon |
|---|---|---|---|
| E1 | **Statistiques du groupe** — qui organise le plus, taux de présence, le record d'annulations de dernière minute | Le moteur de taquinerie ; typiquement ce qui distingue une app de potes d'une app de famille | V2 |
| E2 | **Sondages libres** — « on part où cet été ? » | Simple et très utilisé | V2 |
| E3 | **Badges / titres** — « roi du barbecue », « fantôme » | Gadget, mais pas cher | Plus tard |
| E4 | **Compte à rebours** jusqu'à la prochaine sortie, en page d'accueil | Donne envie d'ouvrir l'app | V2 |

## F. Technique et exploitation

| # | Fonctionnalité | Ce que ça apporte | Jalon |
|---|---|---|---|
| F1 | **PWA installable**, mobile d'abord, consultation hors ligne | Pas de store, pas d'app à maintenir sur deux plateformes | V1 |
| F2 | **Notifications** — push navigateur, e-mail, et un canal de messagerie (Telegram/Discord) | Rejoint les gens là où ils sont | V1 (e-mail) puis V2 |
| F3 | **Installation en une commande Docker** | Exigence de départ | V1 |
| F4 | **Mise à jour depuis l'interface**, modèle « l'app demande, un composant privilégié exécute » | Comme Glassboard et Lucie Cowork | V1 |
| F5 | **Sauvegarde et restauration** — base + photos, une commande, et un bouton d'export | Des souvenirs qui ne sont pas sauvegardés sont des souvenirs perdus | V1 |
| F6 | **Authentification** — à trancher (mot de passe + TOTP, lien magique par e-mail, OIDC) | Porte d'entrée de données intimes | V1 |
| F7 | **Journal d'audit** des actions sensibles (suppression d'album, retrait de membre) | Confiance dans un espace partagé | V2 |
| F8 | **Export de ses propres données et suppression de compte** | Correction minimale vis-à-vis du RGPD, même entre amis | V2 |
