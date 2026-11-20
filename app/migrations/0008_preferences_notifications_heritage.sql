-- Reconstruit `notification_preferences` pour qu'une ligne de GROUPE puisse laisser `channel_email`, `digest` et `muted_kinds` à NULL :
-- NULL veut dire « hérite de la ligne globale '*' », champ par champ (mode e-mail d'un côté, genres coupés de l'autre). Avant, la ligne
-- d'un groupe copiait les valeurs globales à sa création puis primait en bloc : couper ensuite un genre globalement ne l'atteignait plus.
-- La ligne globale '*' n'hérite de rien : ses trois colonnes restent obligatoires (CHECK). Les lignes existantes gardent leurs valeurs.
-- `channel_email` et `digest` décrivent ensemble le mode e-mail : ils sont NULL ensemble, ou posés ensemble.

CREATE TABLE notification_preferences_nouvelle (
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  group_id       TEXT NOT NULL,            -- identifiant de groupe, ou '*' pour le réglage global
  channel_email  INTEGER,
  digest         TEXT,
  muted_kinds    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, group_id),
  CHECK (channel_email IS NULL OR channel_email IN (0, 1)),
  CHECK (digest IS NULL OR digest IN ('instant', 'daily', 'off')),
  CHECK (muted_kinds IS NULL OR json_valid(muted_kinds)),
  CHECK ((channel_email IS NULL) = (digest IS NULL)),
  CHECK (group_id <> '*' OR (channel_email IS NOT NULL AND digest IS NOT NULL AND muted_kinds IS NOT NULL))
) STRICT;

INSERT INTO notification_preferences_nouvelle (
  user_id, group_id, channel_email, digest, muted_kinds, created_at, updated_at
)
SELECT
  user_id, group_id, channel_email, digest, muted_kinds, created_at, updated_at
FROM notification_preferences;

DROP TABLE notification_preferences;

ALTER TABLE notification_preferences_nouvelle RENAME TO notification_preferences;
