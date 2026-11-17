-- 0003_profil_et_push.sql — photo de profil utilisateur et notifications Push Web (VAPID).

ALTER TABLE users ADD COLUMN avatar_mime TEXT;
ALTER TABLE users ADD COLUMN avatar_data BLOB;
ALTER TABLE users ADD COLUMN avatar_updated_at TEXT;

-- Clé VAPID de l'instance (une seule ligne). La clé privée n'est jamais stockée en clair : elle est chiffrée en AES-256-GCM avec
-- ATTROUPE_ENCRYPTION_KEY, comme la clé d'API Immich (le tag GCM est concaténé à la fin de `private_key_cipher`).
CREATE TABLE IF NOT EXISTS push_config (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  public_key         TEXT NOT NULL,
  private_key_cipher BLOB NOT NULL,
  private_key_nonce  BLOB NOT NULL,
  subject            TEXT NOT NULL,
  created_at         TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           TEXT NOT NULL PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id);

-- Un endpoint désigne UN navigateur, donc un seul compte à la fois : sur un navigateur partagé, quand B s'abonne avec l'endpoint
-- que A avait enregistré, l'abonnement de A disparaît (sinon l'appareil continuerait de recevoir les notifications de A).
-- C'est un déclencheur, et non du code applicatif, parce que la garde SQL de db/ interdit par construction de supprimer la ligne
-- d'un autre compte : la réattribution doit se faire dans la base, atomiquement avec l'insertion.
CREATE TRIGGER IF NOT EXISTS trg_push_subscriptions_reattribution
BEFORE INSERT ON push_subscriptions
BEGIN
  DELETE FROM push_subscriptions WHERE endpoint = NEW.endpoint AND user_id <> NEW.user_id;
END;
