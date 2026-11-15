-- 0002_verification_email.sql — lot 2 (comptes) : jeton de vérification d'adresse e-mail.
-- Même forme que password_reset_tokens : le jeton n'existe en clair que dans l'e-mail envoyé,
-- la base ne garde que son SHA-256 ; `used_at` en fait un jeton à usage unique.

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id          TEXT NOT NULL PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_tokens (user_id, expires_at);
