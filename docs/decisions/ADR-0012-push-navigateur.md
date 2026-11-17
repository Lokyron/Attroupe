# ADR-0012 — Le push navigateur passe en V1, avec sa propre crypto et un point d'arrivée contraint

- **Date** : 2026-11-17
- **Statut** : Acceptée
- **Décidé par** : Théo, après relecture de la livraison des lots 7 à 12

## Contexte

Le [périmètre](../../Dossier%20de%20conception/02%20-%20Perimetre%20et%20jalons.md) plaçait le push
navigateur en V2 : « F2 Notifications par e-mail (le push navigateur suit en V2) ». La détection des
disponibilités (B6) y était aussi, pour une raison explicite — elle n'a de sens que si l'agenda
personnel (B4) est réellement utilisé.

Les deux ont pourtant été implémentés pendant les lots 7 à 12, et le journal d'avancement ne
mentionnait même pas le push. Le code et le document de périmètre se contredisaient donc, ce qui est
le pire des deux mondes : on ne sait plus lequel fait foi.

Trois options :

1. **Retirer le code** et s'en tenir au périmètre. Cohérent, mais on jette du travail qui fonctionne
   et on retire une fonctionnalité que des bêta-testeurs auront déjà vue.
2. **Laisser le code et le document en désaccord.** C'est la situation trouvée. Elle rend le document
   inutilisable comme référence, ce qui était précisément son rôle (« en cas de désaccord avec le
   menu, c'est lui qui gagne »).
3. **Remonter les deux en V1 et le consigner** (retenue).

## Décision

**Option 3.** Le push navigateur et la détection des disponibilités rejoignent la V1. Le document de
périmètre est corrigé en conséquence, et non laissé en contradiction.

Trois choix techniques sont consignés avec, parce qu'ils ne sont pas évidents et qu'ils seront
remis en cause un jour :

1. **Aucune dépendance.** La crypto Web Push est écrite à la main dans `app/server/domain/push.ts` —
   HKDF et ECDH selon la RFC 8291, JWT ES256 selon la RFC 8292, chiffrement `aes128gcm`. C'est
   conforme aux RFC, vérifié par relecture ligne à ligne, et cela respecte la règle « pas de
   dépendance nouvelle sans ADR » plutôt que de tirer `web-push`.
2. **Le point d'arrivée est contraint, pas seulement validé.** Une URL d'abonnement fournie par le
   client est une primitive de requête sortante : la première version acceptait n'importe quelle URL
   `http(s)` et la route de test renvoyait le résultat de l'appel, ce qui en faisait un scanner du
   réseau interne utilisable par n'importe quel compte. Désormais : `https` seul, port 443 seul,
   aucun identifiant dans l'URL, hôte résolvant exclusivement vers des adresses publiques, DNS
   épinglé entre la vérification et la connexion, redirections non suivies, revérification avant
   **chaque** envoi. `ATTROUPE_IMMICH_ALLOW_PRIVATE` ne s'applique **pas** au push : la tolérance
   accordée à Immich en homelab n'a pas à s'étendre à une URL que le client choisit.
3. **La route de test n'accuse rien de plus que l'envoi.** Elle répond `202` avec le nombre
   d'appareils enregistrés, jamais le résultat de l'appel sortant. Un accusé précis serait un oracle.

La clé privée VAPID est chiffrée en base avec `ATTROUPE_ENCRYPTION_KEY`, comme la clé d'API Immich.
Une clé stockée en clair à côté d'une clé chiffrée est une incohérence qui finit par être copiée.

## Conséquences

- Trois variables d'environnement : `ATTROUPE_VAPID_PUBLIC_KEY`, `ATTROUPE_VAPID_PRIVATE_KEY`,
  `ATTROUPE_VAPID_SUBJECT`, documentées dans `.env.example`. Les deux clés vont ensemble : une moitié
  seule est refusée au démarrage, parce qu'elle était auparavant ignorée en silence au profit d'une
  clé générée en base — les navigateurs s'abonnaient alors avec une clé et les envois étaient signés
  avec une autre, donc rejetés, sans que rien ne le dise.
- Si `ATTROUPE_ENCRYPTION_KEY` change, la configuration push devient illisible et la lecture lève.
  Elle n'est **pas** régénérée en silence : cela désabonnerait tous les appareils sans prévenir.
- Les abonnements sont plafonnés à 10 par compte ; au-delà, le plus ancien est remplacé.
- Un endpoint est unique à l'instance, et un déclencheur le **réattribue** au compte qui l'enregistre.
  C'est nécessaire au navigateur partagé : sans cela, le second utilisateur échoue sur la contrainte
  et l'appareil continue de recevoir les notifications du premier. Le compromis assumé : qui connaît
  l'endpoint d'un autre compte peut détruire son abonnement en l'enregistrant. Aucune API ne renvoie
  un endpoint, donc cela suppose une fuite par un autre chemin ; le jour où ce n'est plus acceptable,
  exiger que le nouvel enregistrement présente le même secret `auth` que l'ancien.
- `db/` ne déclenche plus d'appel réseau : l'envoi part de la couche service, après le commit.
- B6 étant en V1, sa valeur dépend de l'usage réel de B4. Si l'agenda personnel n'est pas rempli, la
  détection ne montrera rien — ce n'est pas un défaut, c'est sa nature.
- Une duplication reste à résorber : l'envoi épinglé du push reprend le principe de
  `executerRequeteEpinglee` dans `services/immich-client.ts`. Un module commun serait plus sûr qu'une
  copie, qui dérivera.

## Ce qui rendrait cette décision fausse

Si la crypto maison devait être étendue (agrégation de topics, `urgency`, en-têtes propres à un
service de push), le coût de maintien d'une implémentation locale dépasserait celui d'une dépendance :
il faudrait alors prendre `web-push` et le consigner. Signal à surveiller : un correctif de
`domain/push.ts` qui demande de relire une RFC pour être validé.
