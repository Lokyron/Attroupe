# ADR-0007 — Authentification : session opaque en base

- **Date** : 2026-11-15
- **Statut** : Acceptée
- **Décidé par** : architecte

## Contexte

F6 du périmètre : inscription et mot de passe, invitations par e-mail, **connexion Google en
V2**. Les données protégées sont intimes (agendas personnels, photos de personnes
identifiables). Le serveur est un processus unique avec une base locale.

## Options envisagées

1. **Session opaque en base + cookie** (retenue). Jeton aléatoire de 32 octets, stocké **haché**
   côté serveur, cookie `HttpOnly` `Secure` `SameSite=Lax`. Révocation immédiate, une requête de
   base par appel (quelques microsecondes en SQLite local).
2. **JWT signé, sans état.** Pas de lecture de base à chaque requête, mais pas de révocation :
   retirer quelqu'un d'un groupe ou perdre un téléphone laisserait un jeton valide jusqu'à son
   expiration. Il faudrait une liste de révocation, c'est-à-dire reconstituer l'état qu'on
   voulait éviter.
3. **Lien magique par e-mail seul.** Pas de mot de passe à retenir, mais chaque connexion dépend
   de Brevo, et l'accès au compte devient l'accès à la boîte mail. Inacceptable comme unique
   facteur quand l'envoi d'e-mails est une dépendance externe facultative.

## Décision

**Option 1.** Mot de passe haché par **`scrypt` de `node:crypto`** (N=2^15, r=8, p=1, sel de 16
octets, format versionné `scrypt$N$r$p$sel$empreinte`), aucune dépendance native ajoutée.
Protection CSRF par `SameSite=Lax` + vérification de l'en-tête `Origin`. Inscription ouverte par
défaut, commutable par `ATTROUPE_REGISTRATION=open|invite`.

## Conséquences

- La révocation est immédiate et par appareil : `/moi/sessions` liste et révoque.
- Une copie de la base ne donne aucune session utilisable (jetons hachés).
- Argon2id serait marginalement supérieur ; il exige une dépendance compilée de plus, ce que la
  règle de projet demande de justifier. Le format versionné permet d'y passer plus tard sans
  invalider les comptes existants.
- **La V2 est additive** : OIDC *authorization code* avec PKCE, une ligne dans
  `user_identities`, puis la même session et le même intergiciel. Aucune route métier ne change.
- **Garde-fou écrit d'avance pour la V2** : ne jamais lier une identité Google à un compte
  existant sur la seule égalité des adresses e-mail. Liaison automatique uniquement si Google
  atteste `email_verified` **et** que notre `email_verified_at` est non nul ; sinon, demander le
  mot de passe existant. Sans cette règle, créer un compte Google avec l'adresse de quelqu'un
  revient à prendre son compte.
- Pas de second facteur en V1 (TOTP) : à reconsidérer si l'instance s'ouvre largement.

## Ce qui rendrait cette décision fausse

Un passage à plusieurs processus ou à plusieurs machines (la lecture de session en base
deviendrait un point de contention partagé), ou l'arrivée d'un fournisseur d'identité unique
pour toute l'instance, qui rendrait le mot de passe local inutile.
