# Intégration Immich — relevé de l'API

> Relevé le 2026-11-15 à partir de la spécification OpenAPI officielle d'Immich.
> Source de vérité : <https://raw.githubusercontent.com/immich-app/immich/main/open-api/immich-openapi-specs.json>
> (branche `main`, donc pas forcément alignée sur la dernière version publiée).
>
> Rappel de cadrage ([`ADR-0003`](decisions/ADR-0003-photos-immich.md)) : Immich tourne **hors
> de notre pile**, l'application ne parle à lui **que par cette API**, jamais à sa base.

## En un paragraphe

L'API est correctement documentée et stable dans ses formes, mais **elle n'est pas versionnée
dans les URL** (pas de `/v1/`) et **Immich v3, sorti le 1er juillet 2026, a introduit des
changements cassants**. Conséquence directe pour nous : la version d'Immich déployée doit être
**figée et écrite dans la documentation d'exploitation**, et notre couche d'accès doit être
tolérante sur les codes de réponse.

## Ce qu'il faut savoir, point par point

### 1. Authentification machine
En-tête **`x-api-key: <clé>`**. La clé se crée depuis les paramètres du compte dans l'interface
web d'Immich. Les clés portent des **permissions** ; celles qui nous concernent :

| Permission | Pour |
|---|---|
| `album.create`, `album.read`, `album.share` | créer et lire les albums |
| `albumAsset.create`, `albumAsset.delete` | ajouter et retirer des médias d'un album |
| `asset.upload`, `asset.view`, `asset.download` | envoyer un média, voir les vignettes, récupérer l'original |
| `sharedLink.create` | créer un lien de partage |

Une clé mal dotée échoue vraisemblablement en `403`. À tester explicitement au branchement
d'une instance : **un message clair « clé insuffisante » valant mieux qu'un onglet photos vide.**

### 2. Créer un album
`POST /albums` — corps : `albumName` (requis), `description`, `albumUsers`, `assetIds`
(facultatifs). Réponse `201` avec l'album créé.

### 3. Envoyer un média
`POST /assets`, en **multipart**. Requis : `assetData` (le binaire), **`fileCreatedAt`** et
`fileModifiedAt`. Facultatifs utiles : `filename`, `duration`, `metadata`, `visibility`.
En-tête facultatif **`x-immich-checksum`** : le **SHA-1** du fichier, pour la déduplication.

- `fileCreatedAt` doit être **la vraie date de prise de vue** (EXIF), sinon la photo est mal
  classée dans la chronologie d'Immich. C'est ce champ qui rendra possible le rangement
  automatique par soirée (fonctionnalité D3).
- Les champs `deviceId` / `deviceAssetId`, obligatoires avant la v3, **ont été supprimés**.

### 4. Albums et médias
- Ajouter : `PUT /albums/{id}/assets`, corps = liste d'identifiants.
- Retirer : `DELETE /albums/{id}/assets`, même forme.

### 5. Vignettes et originaux
- Vignette : `GET /assets/{id}/thumbnail?size=…` — tailles `thumbnail`, `preview`, `fullsize`.
  `size=original` est **déprécié**.
- Original : `GET /assets/{id}/original`.
- Les deux renvoient un flux binaire ; le type réel se lit dans l'en-tête `Content-Type` de la
  réponse, la spécification annonçant `application/octet-stream`.

> C'est exactement ce qu'il nous faut pour **servir les photos derrière nos propres URL signées
> et expirantes** : l'application relaie le flux après avoir vérifié l'appartenance au groupe,
> et aucune URL d'Immich n'est jamais exposée au navigateur.

### 6. Liens de partage
`POST /shared-links` — `type` (`ALBUM` ou `INDIVIDUAL`), `albumId`, et surtout **`password`** et
**`expiresAt`**, plus `allowDownload`, `allowUpload`, `showMetadata`. De quoi couvrir la
fonctionnalité D7 (lien de partage révocable et expirable) sans rien écrire nous-mêmes.

### 7. Versions
- Dernière version confirmée : **v3.3.0, le 7 octobre 2026**. Une v3.3.4 du 20 octobre 2026
  apparaît chez un agrégateur tiers, non vérifiée.
- **v3.0.0 (1er juillet 2026)** a supprimé des points d'entrée, changé le format des erreurs
  (`error` et `statusCode` retirés), migré la propriété d'album vers `album_user`, et déprécié
  `PUT` au profit de `PATCH`. Guide de migration : `immich.app/blog/v3-migration`.

## Pièges à ne pas découvrir en production

1. **Doublons : les sources se contredisent.** La spécification actuelle répond `200` pour un
   doublon et `201` pour une création, avec un champ `status` (`created` / `duplicate`). La
   documentation archivée de la v1.142.1 annonçait `201` avec un `status` pouvant valoir
   `replaced`. **Ne jamais coder en dur le code de réponse** : accepter `200` comme `201` et
   lire `status`. À vérifier sur la version réellement déployée.
2. **La somme de contrôle est un SHA-1**, pas un SHA-256.
3. **Figer la version d'Immich** côté exploitation, et relire le guide de migration avant toute
   montée de version : notre intégration peut casser sans que notre code ait changé.
4. **Aucune limite de taille d'envoi documentée** — à déterminer par l'essai, et à faire porter
   par notre propre limite, plus basse et explicite.
5. **Codes d'erreur peu documentés** : la couche d'accès doit traiter tout code non attendu
   comme un échec explicite affiché à l'utilisateur, jamais comme un silence.

## Ce qui reste à vérifier à l'implémentation

- La réponse « doublon » renvoie-t-elle l'identifiant du média déjà présent ? (probable, non
  confirmé — c'est ce qui nous permettrait de rattacher un doublon à l'album sans le renvoyer).
- Le mappage exact permission ↔ point d'entrée pour les vignettes.
- Le comportement précis de `x-immich-checksum` en cas de collision.
