-- 0001_socle.sql — schéma initial de Attroupe (V1)
-- Posé par la couche d'accès à chaque connexion :
--   PRAGMA journal_mode = WAL;        -- persistant, mais réaffirmé
--   PRAGMA foreign_keys = ON;         -- NON persistant : obligatoire à chaque ouverture
--   PRAGMA busy_timeout = 5000;
--   PRAGMA synchronous = NORMAL;      -- suffisant avec WAL
--   PRAGMA foreign_keys;              -- vérifié : le démarrage échoue si la valeur n'est pas 1

-- ============================================================
-- 1. Référence
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT NOT NULL PRIMARY KEY,
  applied_at  TEXT NOT NULL,
  checksum    TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS currencies (
  code        TEXT NOT NULL PRIMARY KEY,
  exponent    INTEGER NOT NULL,
  symbol      TEXT NOT NULL,
  name_key    TEXT NOT NULL,
  is_enabled  INTEGER NOT NULL DEFAULT 1,
  CHECK (length(code) = 3 AND code = upper(code)),
  CHECK (exponent BETWEEN 0 AND 4),
  CHECK (is_enabled IN (0, 1))
) STRICT;

INSERT INTO currencies (code, exponent, symbol, name_key) VALUES
  ('EUR', 2, '€',   'currency.eur'),
  ('USD', 2, '$',   'currency.usd'),
  ('GBP', 2, '£',   'currency.gbp'),
  ('CHF', 2, 'CHF', 'currency.chf'),
  ('CAD', 2, '$',   'currency.cad'),
  ('JPY', 0, '¥',   'currency.jpy'),
  ('CNY', 2, '¥',   'currency.cny'),
  ('MXN', 2, '$',   'currency.mxn'),
  ('AUD', 2, '$',   'currency.aud'),
  ('SEK', 2, 'kr',  'currency.sek'),
  ('NOK', 2, 'kr',  'currency.nok'),
  ('DKK', 2, 'kr',  'currency.dkk'),
  ('PLN', 2, 'zł',  'currency.pln'),
  ('CZK', 2, 'Kč',  'currency.czk'),
  ('MAD', 2, 'DH',  'currency.mad'),
  ('THB', 2, '฿',   'currency.thb'),
  ('TRY', 2, '₺',   'currency.try')
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- 2. Comptes et sessions
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id                 TEXT NOT NULL PRIMARY KEY,
  email              TEXT NOT NULL,
  email_verified_at  TEXT,
  username           TEXT NOT NULL,
  display_name       TEXT NOT NULL,
  password_hash      TEXT,
  avatar_path        TEXT,
  birthday           TEXT,
  locale             TEXT NOT NULL DEFAULT 'fr',
  time_zone          TEXT NOT NULL DEFAULT 'Europe/Paris',
  is_instance_admin  INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  disabled_at        TEXT,
  anonymized_at      TEXT,
  CHECK (is_instance_admin IN (0, 1)),
  CHECK (length(username) BETWEEN 3 AND 32),
  CHECK (length(display_name) BETWEEN 1 AND 60),
  CHECK (email LIKE '_%@_%._%')
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower    ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (lower(username));

CREATE TABLE IF NOT EXISTS user_identities (
  id                 TEXT NOT NULL PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider           TEXT NOT NULL,
  subject            TEXT NOT NULL,
  email_at_provider  TEXT,
  created_at         TEXT NOT NULL,
  last_used_at       TEXT,
  CHECK (provider IN ('google')),
  UNIQUE (provider, subject),
  UNIQUE (user_id, provider)
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT NOT NULL PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  user_agent    TEXT,
  ip_hash       TEXT,
  revoked_at    TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, expires_at);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          TEXT NOT NULL PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
) STRICT;

-- ============================================================
-- 3. Groupes, appartenances, invitations
-- ============================================================

CREATE TABLE IF NOT EXISTS groups (
  id                     TEXT NOT NULL PRIMARY KEY,
  name                   TEXT NOT NULL,
  slug                   TEXT NOT NULL UNIQUE,
  default_currency_code  TEXT NOT NULL DEFAULT 'EUR' REFERENCES currencies (code),
  time_zone              TEXT NOT NULL DEFAULT 'Europe/Paris',
  created_by_user_id     TEXT NOT NULL REFERENCES users (id),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  archived_at            TEXT,
  deleted_at             TEXT,
  CHECK (length(name) BETWEEN 1 AND 80)
) STRICT;

CREATE TABLE IF NOT EXISTS memberships (
  id          TEXT NOT NULL PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups (id),
  user_id     TEXT NOT NULL REFERENCES users (id),
  role        TEXT NOT NULL DEFAULT 'member',
  status      TEXT NOT NULL DEFAULT 'active',
  nickname    TEXT,
  default_personal_visibility TEXT NOT NULL DEFAULT 'busy',
  joined_at   TEXT NOT NULL,
  ended_at    TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK (role IN ('admin', 'member')),
  CHECK (status IN ('active', 'removed', 'left')),
  CHECK (default_personal_visibility IN ('none', 'busy', 'details')),
  CHECK ((status = 'active') = (ended_at IS NULL)),
  UNIQUE (group_id, user_id),
  UNIQUE (id, group_id)            -- cible des clés étrangères composites
) STRICT;

CREATE INDEX IF NOT EXISTS idx_memberships_user  ON memberships (user_id, status);
CREATE INDEX IF NOT EXISTS idx_memberships_group ON memberships (group_id, status);

CREATE TABLE IF NOT EXISTS invitations (
  id                        TEXT NOT NULL PRIMARY KEY,
  group_id                  TEXT NOT NULL REFERENCES groups (id),
  invited_by_membership_id  TEXT NOT NULL,
  kind                      TEXT NOT NULL,
  target_user_id            TEXT REFERENCES users (id),
  email                     TEXT,
  role                      TEXT NOT NULL DEFAULT 'member',
  token_hash                TEXT UNIQUE,
  status                    TEXT NOT NULL DEFAULT 'pending',
  message                   TEXT,
  created_at                TEXT NOT NULL,
  expires_at                TEXT NOT NULL,
  responded_at              TEXT,
  resulting_membership_id   TEXT,
  CHECK (kind IN ('email', 'existing_user')),
  CHECK (role IN ('admin', 'member')),
  CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  CHECK ((target_user_id IS NOT NULL) + (email IS NOT NULL) = 1),
  CHECK ((kind = 'existing_user') = (target_user_id IS NOT NULL)),
  CHECK (message IS NULL OR length(message) <= 500),
  FOREIGN KEY (invited_by_membership_id, group_id) REFERENCES memberships (id, group_id),
  FOREIGN KEY (resulting_membership_id, group_id) REFERENCES memberships (id, group_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_pending_user
  ON invitations (group_id, target_user_id) WHERE status = 'pending' AND target_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_pending_email
  ON invitations (group_id, lower(email)) WHERE status = 'pending' AND email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invitations_target ON invitations (target_user_id, status);
CREATE INDEX IF NOT EXISTS idx_invitations_group  ON invitations (group_id, status);

-- ============================================================
-- 4. Sondages de dates  (déclarés avant events : events y référence)
-- ============================================================

CREATE TABLE IF NOT EXISTS date_polls (
  id                        TEXT NOT NULL PRIMARY KEY,
  group_id                  TEXT NOT NULL REFERENCES groups (id),
  title                     TEXT NOT NULL,
  description               TEXT,
  status                    TEXT NOT NULL DEFAULT 'open',
  closes_at                 TEXT,
  resulting_event_id        TEXT,
  created_by_membership_id  TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT,
  CHECK (status IN ('open', 'closed', 'converted', 'cancelled')),
  FOREIGN KEY (created_by_membership_id, group_id) REFERENCES memberships (id, group_id),
  FOREIGN KEY (resulting_event_id, group_id)       REFERENCES events (id, group_id),  -- events est créée plus bas : SQLite l'accepte
  UNIQUE (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_polls_group ON date_polls (group_id, status, created_at DESC);

-- ============================================================
-- 5. Événements, organisateurs, présences
-- ============================================================

CREATE TABLE IF NOT EXISTS events (
  id                        TEXT NOT NULL PRIMARY KEY,
  group_id                  TEXT NOT NULL REFERENCES groups (id),
  title                     TEXT NOT NULL,
  description               TEXT,
  location_name             TEXT,
  location_address          TEXT,
  location_lat              REAL,
  location_lon              REAL,
  all_day                   INTEGER NOT NULL DEFAULT 0,
  starts_at                 TEXT NOT NULL,
  ends_at                   TEXT,
  time_zone                 TEXT NOT NULL,
  arrival_note              TEXT,
  host_membership_id        TEXT,
  currency_code             TEXT REFERENCES currencies (code),
  capacity                  INTEGER,
  status                    TEXT NOT NULL DEFAULT 'published',
  source_date_poll_id       TEXT,
  recurrence_rule           TEXT,          -- réservé B7 (V2), inutilisé en V1
  recurrence_parent_id      TEXT,          -- réservé B7 (V2), inutilisé en V1
  occurrence_date           TEXT,          -- réservé B7 (V2), inutilisé en V1
  created_by_membership_id  TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT,
  CHECK (all_day IN (0, 1)),
  CHECK (status IN ('draft', 'published', 'cancelled')),
  CHECK (length(title) BETWEEN 1 AND 140),
  CHECK (capacity IS NULL OR capacity > 0),
  CHECK (
    (all_day = 0 AND length(starts_at) = 20 AND substr(starts_at, 20, 1) = 'Z')
    OR (all_day = 1 AND length(starts_at) = 10)
  ),
  CHECK (ends_at IS NULL OR (length(ends_at) = length(starts_at) AND ends_at >= starts_at)),
  CHECK ((recurrence_parent_id IS NULL) = (occurrence_date IS NULL)),
  FOREIGN KEY (host_membership_id, group_id)       REFERENCES memberships (id, group_id),
  FOREIGN KEY (created_by_membership_id, group_id) REFERENCES memberships (id, group_id),
  FOREIGN KEY (source_date_poll_id, group_id)      REFERENCES date_polls (id, group_id),
  FOREIGN KEY (recurrence_parent_id, group_id)     REFERENCES events (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_events_group_start  ON events (group_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_events_group_status ON events (group_id, status, starts_at);

CREATE TABLE IF NOT EXISTS event_organizers (
  event_id       TEXT NOT NULL,
  group_id       TEXT NOT NULL REFERENCES groups (id),
  membership_id  TEXT NOT NULL,
  added_at       TEXT NOT NULL,
  PRIMARY KEY (event_id, membership_id),
  FOREIGN KEY (event_id, group_id)      REFERENCES events (id, group_id),
  FOREIGN KEY (membership_id, group_id) REFERENCES memberships (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_organizers_member ON event_organizers (group_id, membership_id);

CREATE TABLE IF NOT EXISTS event_attendances (
  event_id       TEXT NOT NULL,
  group_id       TEXT NOT NULL REFERENCES groups (id),
  membership_id  TEXT NOT NULL,
  status         TEXT NOT NULL,
  guests_count   INTEGER NOT NULL DEFAULT 0,
  comment        TEXT,
  responded_at   TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (event_id, membership_id),
  CHECK (status IN ('yes', 'maybe', 'no')),
  CHECK (guests_count BETWEEN 0 AND 20),
  CHECK (comment IS NULL OR length(comment) <= 500),
  FOREIGN KEY (event_id, group_id)      REFERENCES events (id, group_id),
  FOREIGN KEY (membership_id, group_id) REFERENCES memberships (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_attendances_membership ON event_attendances (group_id, membership_id);

-- resulting_event_id est contraint par la clé étrangère composite de date_polls (circulaire avec
-- events.source_date_poll_id, ce que SQLite accepte) ; l'index sert la jointure inverse.
CREATE INDEX IF NOT EXISTS idx_polls_event ON date_polls (group_id, resulting_event_id);

CREATE TABLE IF NOT EXISTS date_poll_options (
  id            TEXT NOT NULL PRIMARY KEY,
  date_poll_id  TEXT NOT NULL,
  group_id      TEXT NOT NULL REFERENCES groups (id),
  all_day       INTEGER NOT NULL DEFAULT 0,
  starts_at     TEXT NOT NULL,
  ends_at       TEXT,
  position      INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  CHECK (all_day IN (0, 1)),
  CHECK (
    (all_day = 0 AND length(starts_at) = 20 AND substr(starts_at, 20, 1) = 'Z')
    OR (all_day = 1 AND length(starts_at) = 10)
  ),
  CHECK (ends_at IS NULL OR (length(ends_at) = length(starts_at) AND ends_at >= starts_at)),
  UNIQUE (date_poll_id, starts_at, ends_at),
  FOREIGN KEY (date_poll_id, group_id) REFERENCES date_polls (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_poll_options ON date_poll_options (group_id, date_poll_id, position);

CREATE TABLE IF NOT EXISTS date_poll_votes (
  date_poll_option_id  TEXT NOT NULL,
  group_id             TEXT NOT NULL REFERENCES groups (id),
  membership_id        TEXT NOT NULL,
  value                TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (date_poll_option_id, membership_id),
  CHECK (value IN ('yes', 'maybe', 'no')),
  FOREIGN KEY (date_poll_option_id, group_id) REFERENCES date_poll_options (id, group_id),
  FOREIGN KEY (membership_id, group_id)       REFERENCES memberships (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_poll_votes_member ON date_poll_votes (group_id, membership_id);

-- ============================================================
-- 6. Agenda personnel
-- ============================================================

CREATE TABLE IF NOT EXISTS personal_events (
  id               TEXT NOT NULL PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id),
  title            TEXT NOT NULL,
  description      TEXT,
  location_name    TEXT,
  all_day          INTEGER NOT NULL DEFAULT 0,
  starts_at        TEXT NOT NULL,
  ends_at          TEXT,
  time_zone        TEXT NOT NULL,
  recurrence_rule  TEXT,                  -- réservé B7 (V2)
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT,
  CHECK (all_day IN (0, 1)),
  CHECK (
    (all_day = 0 AND length(starts_at) = 20 AND substr(starts_at, 20, 1) = 'Z')
    OR (all_day = 1 AND length(starts_at) = 10)
  ),
  CHECK (ends_at IS NULL OR (length(ends_at) = length(starts_at) AND ends_at >= starts_at))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_personal_events_user ON personal_events (user_id, starts_at);

CREATE TABLE IF NOT EXISTS personal_event_shares (
  personal_event_id  TEXT NOT NULL REFERENCES personal_events (id) ON DELETE CASCADE,
  membership_id      TEXT NOT NULL,
  group_id           TEXT NOT NULL REFERENCES groups (id),
  visibility         TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (personal_event_id, group_id),
  CHECK (visibility IN ('busy', 'details')),
  FOREIGN KEY (membership_id, group_id) REFERENCES memberships (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_pes_group ON personal_event_shares (group_id, visibility);

-- ============================================================
-- 7. Listes de courses et tâches
-- ============================================================

CREATE TABLE IF NOT EXISTS shopping_lists (
  id                        TEXT NOT NULL PRIMARY KEY,
  group_id                  TEXT NOT NULL REFERENCES groups (id),
  event_id                  TEXT,
  title                     TEXT NOT NULL,
  created_by_membership_id  TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT,
  CHECK (length(title) BETWEEN 1 AND 120),
  FOREIGN KEY (event_id, group_id)                 REFERENCES events (id, group_id),
  FOREIGN KEY (created_by_membership_id, group_id) REFERENCES memberships (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_lists_event ON shopping_lists (group_id, event_id);

CREATE TABLE IF NOT EXISTS shopping_items (
  id                         TEXT NOT NULL PRIMARY KEY,
  shopping_list_id           TEXT NOT NULL,
  group_id                   TEXT NOT NULL REFERENCES groups (id),
  label                      TEXT NOT NULL,
  quantity                   TEXT,
  category                   TEXT,          -- réservé C4 (V2)
  claimed_by_membership_id   TEXT,
  claimed_at                 TEXT,
  is_done                    INTEGER NOT NULL DEFAULT 0,
  done_at                    TEXT,
  position                   INTEGER NOT NULL,
  created_by_membership_id   TEXT NOT NULL,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  deleted_at                 TEXT,
  CHECK (is_done IN (0, 1)),
  CHECK (length(label) BETWEEN 1 AND 120),
  CHECK ((claimed_by_membership_id IS NULL) = (claimed_at IS NULL)),
  CHECK ((is_done = 1) = (done_at IS NOT NULL)),
  FOREIGN KEY (shopping_list_id, group_id)          REFERENCES shopping_lists (id, group_id),
  FOREIGN KEY (claimed_by_membership_id, group_id)  REFERENCES memberships (id, group_id),
  FOREIGN KEY (created_by_membership_id, group_id)  REFERENCES memberships (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_items_list    ON shopping_items (group_id, shopping_list_id, position);
CREATE INDEX IF NOT EXISTS idx_items_claimer ON shopping_items (group_id, claimed_by_membership_id);

CREATE TABLE IF NOT EXISTS event_tasks (
  id                        TEXT NOT NULL PRIMARY KEY,
  group_id                  TEXT NOT NULL REFERENCES groups (id),
  event_id                  TEXT,
  title                     TEXT NOT NULL,
  details                   TEXT,
  assignee_membership_id    TEXT,
  due_at                    TEXT,
  status                    TEXT NOT NULL DEFAULT 'todo',
  done_at                   TEXT,
  position                  INTEGER NOT NULL,
  created_by_membership_id  TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT,
  CHECK (status IN ('todo', 'doing', 'done', 'dropped')),
  CHECK ((status = 'done') = (done_at IS NOT NULL)),
  CHECK (length(title) BETWEEN 1 AND 140),
  FOREIGN KEY (event_id, group_id)                 REFERENCES events (id, group_id),
  FOREIGN KEY (assignee_membership_id, group_id)   REFERENCES memberships (id, group_id),
  FOREIGN KEY (created_by_membership_id, group_id) REFERENCES memberships (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tasks_event    ON event_tasks (group_id, event_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON event_tasks (group_id, assignee_membership_id, status);

-- ============================================================
-- 8. Fils de discussion
-- ============================================================

CREATE TABLE IF NOT EXISTS threads (
  id                        TEXT NOT NULL PRIMARY KEY,
  group_id                  TEXT NOT NULL REFERENCES groups (id),
  event_id                  TEXT,
  title                     TEXT,
  kind                      TEXT NOT NULL,
  is_locked                 INTEGER NOT NULL DEFAULT 0,
  last_message_at           TEXT,
  created_by_membership_id  TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT,
  CHECK (kind IN ('event', 'free')),
  CHECK (is_locked IN (0, 1)),
  CHECK ((kind = 'event') = (event_id IS NOT NULL)),
  CHECK (kind = 'event' OR title IS NOT NULL),
  FOREIGN KEY (event_id, group_id)                 REFERENCES events (id, group_id),
  FOREIGN KEY (created_by_membership_id, group_id) REFERENCES memberships (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_event_unique
  ON threads (event_id) WHERE kind = 'event' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_threads_group ON threads (group_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id                    TEXT NOT NULL PRIMARY KEY,
  thread_id             TEXT NOT NULL,
  group_id              TEXT NOT NULL REFERENCES groups (id),
  author_membership_id  TEXT NOT NULL,
  body                  TEXT NOT NULL,
  reply_to_message_id   TEXT,
  created_at            TEXT NOT NULL,
  edited_at             TEXT,
  deleted_at            TEXT,
  CHECK (length(body) <= 8000),
  CHECK (deleted_at IS NOT NULL OR length(body) >= 1),
  FOREIGN KEY (thread_id, group_id)             REFERENCES threads (id, group_id),
  FOREIGN KEY (author_membership_id, group_id)  REFERENCES memberships (id, group_id),
  FOREIGN KEY (reply_to_message_id, group_id)   REFERENCES messages (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (group_id, thread_id, created_at);

-- ============================================================
-- 9. Dépenses
-- ============================================================

CREATE TABLE IF NOT EXISTS expenses (
  id                        TEXT NOT NULL PRIMARY KEY,
  group_id                  TEXT NOT NULL REFERENCES groups (id),
  event_id                  TEXT,
  label                     TEXT NOT NULL,
  spent_on                  TEXT NOT NULL,
  payer_membership_id       TEXT NOT NULL,
  amount_minor              INTEGER NOT NULL,
  currency_code             TEXT NOT NULL REFERENCES currencies (code),
  target_currency_code      TEXT NOT NULL REFERENCES currencies (code),
  rate_ppm                  INTEGER NOT NULL,
  rate_source               TEXT NOT NULL,
  rate_fetched_at           TEXT,
  amount_target_minor       INTEGER NOT NULL,
  split_mode                TEXT NOT NULL,
  note                      TEXT,
  receipt_path              TEXT,
  created_by_membership_id  TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT,
  CHECK (amount_minor > 0 AND amount_target_minor > 0),
  CHECK (rate_ppm > 0),
  CHECK (length(spent_on) = 10),
  CHECK (length(label) BETWEEN 1 AND 140),
  CHECK (rate_source IN ('identity', 'manual', 'provider')),
  CHECK (split_mode IN ('equal', 'weights', 'exact')),
  -- devises identiques  <=>  taux neutre et source 'identity'
  CHECK (
    (currency_code = target_currency_code AND rate_ppm = 1000000 AND rate_source = 'identity')
    OR (currency_code <> target_currency_code AND rate_source <> 'identity')
  ),
  FOREIGN KEY (event_id, group_id)                 REFERENCES events (id, group_id),
  FOREIGN KEY (payer_membership_id, group_id)      REFERENCES memberships (id, group_id),
  FOREIGN KEY (created_by_membership_id, group_id) REFERENCES memberships (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_expenses_group_date ON expenses (group_id, spent_on DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_event      ON expenses (group_id, event_id);
CREATE INDEX IF NOT EXISTS idx_expenses_payer      ON expenses (group_id, payer_membership_id);

CREATE TABLE IF NOT EXISTS expense_shares (
  expense_id          TEXT NOT NULL,
  group_id            TEXT NOT NULL REFERENCES groups (id),
  membership_id       TEXT NOT NULL,
  weight              INTEGER NOT NULL DEFAULT 1,
  share_minor         INTEGER NOT NULL,
  share_target_minor  INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (expense_id, membership_id),
  CHECK (weight >= 0),
  CHECK (share_minor >= 0 AND share_target_minor >= 0),
  FOREIGN KEY (expense_id, group_id)    REFERENCES expenses (id, group_id),
  FOREIGN KEY (membership_id, group_id) REFERENCES memberships (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_shares_membership ON expense_shares (group_id, membership_id);

CREATE TABLE IF NOT EXISTS settlements (
  id                          TEXT NOT NULL PRIMARY KEY,
  group_id                    TEXT NOT NULL REFERENCES groups (id),
  event_id                    TEXT,
  from_membership_id          TEXT NOT NULL,
  to_membership_id            TEXT NOT NULL,
  amount_minor                INTEGER NOT NULL,
  currency_code               TEXT NOT NULL REFERENCES currencies (code),
  target_currency_code        TEXT NOT NULL REFERENCES currencies (code),
  rate_ppm                    INTEGER NOT NULL,
  amount_target_minor         INTEGER NOT NULL,
  settled_on                  TEXT NOT NULL,
  method_note                 TEXT,
  recorded_by_membership_id   TEXT NOT NULL,
  confirmed_by_membership_id  TEXT,
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL,
  deleted_at                  TEXT,
  CHECK (amount_minor > 0 AND amount_target_minor > 0 AND rate_ppm > 0),
  CHECK (from_membership_id <> to_membership_id),
  CHECK (length(settled_on) = 10),
  CHECK (method_note IS NULL OR length(method_note) <= 200),
  CHECK (
    (currency_code = target_currency_code AND rate_ppm = 1000000)
    OR currency_code <> target_currency_code
  ),
  FOREIGN KEY (event_id, group_id)                    REFERENCES events (id, group_id),
  FOREIGN KEY (from_membership_id, group_id)          REFERENCES memberships (id, group_id),
  FOREIGN KEY (to_membership_id, group_id)            REFERENCES memberships (id, group_id),
  FOREIGN KEY (recorded_by_membership_id, group_id)   REFERENCES memberships (id, group_id),
  FOREIGN KEY (confirmed_by_membership_id, group_id)  REFERENCES memberships (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_settlements_group ON settlements (group_id, settled_on DESC);
CREATE INDEX IF NOT EXISTS idx_settlements_pair  ON settlements (group_id, from_membership_id, to_membership_id);

CREATE TABLE IF NOT EXISTS expense_closures (
  id                           TEXT NOT NULL PRIMARY KEY,
  group_id                     TEXT NOT NULL REFERENCES groups (id),
  event_id                     TEXT NOT NULL,
  currency_code                TEXT NOT NULL REFERENCES currencies (code),
  snapshot_json                TEXT NOT NULL,
  total_minor                  INTEGER NOT NULL,
  closed_by_membership_id      TEXT NOT NULL,
  closed_at                    TEXT NOT NULL,
  reopened_at                  TEXT,
  reopened_by_membership_id    TEXT,
  CHECK (total_minor >= 0),
  CHECK (json_valid(snapshot_json)),
  CHECK ((reopened_at IS NULL) = (reopened_by_membership_id IS NULL)),
  FOREIGN KEY (event_id, group_id)                   REFERENCES events (id, group_id),
  FOREIGN KEY (closed_by_membership_id, group_id)    REFERENCES memberships (id, group_id),
  FOREIGN KEY (reopened_by_membership_id, group_id)  REFERENCES memberships (id, group_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_closures_active
  ON expense_closures (event_id) WHERE reopened_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_closures_group ON expense_closures (group_id, closed_at DESC);

-- ============================================================
-- 10. Photos (Immich)
-- ============================================================

CREATE TABLE IF NOT EXISTS group_immich_configs (
  group_id                   TEXT NOT NULL PRIMARY KEY REFERENCES groups (id),
  base_url                   TEXT NOT NULL,
  api_key_cipher             BLOB NOT NULL,
  api_key_nonce              BLOB NOT NULL,
  api_key_fingerprint        TEXT NOT NULL,
  immich_user_id             TEXT,
  status                     TEXT NOT NULL DEFAULT 'untested',
  last_checked_at            TEXT,
  last_error                 TEXT,
  configured_by_membership_id TEXT NOT NULL,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  CHECK (status IN ('ok', 'unreachable', 'unauthorized', 'untested')),
  CHECK (base_url LIKE 'http://%' OR base_url LIKE 'https://%'),
  FOREIGN KEY (configured_by_membership_id, group_id) REFERENCES memberships (id, group_id)
) STRICT;

CREATE TABLE IF NOT EXISTS albums (
  id                        TEXT NOT NULL PRIMARY KEY,
  group_id                  TEXT NOT NULL REFERENCES groups (id),
  event_id                  TEXT,
  title                     TEXT NOT NULL,
  immich_album_id           TEXT NOT NULL,
  cover_immich_asset_id     TEXT,
  asset_count               INTEGER NOT NULL DEFAULT 0,
  last_synced_at            TEXT,
  sync_status               TEXT NOT NULL DEFAULT 'pending',
  created_by_membership_id  TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  deleted_at                TEXT,
  CHECK (sync_status IN ('ok', 'pending', 'error', 'orphan')),
  CHECK (asset_count >= 0),
  UNIQUE (group_id, immich_album_id),
  FOREIGN KEY (event_id, group_id)                 REFERENCES events (id, group_id),
  FOREIGN KEY (created_by_membership_id, group_id) REFERENCES memberships (id, group_id),
  UNIQUE (id, group_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_event_unique
  ON albums (event_id) WHERE event_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS album_assets (
  album_id                   TEXT NOT NULL,
  group_id                   TEXT NOT NULL REFERENCES groups (id),
  immich_asset_id            TEXT NOT NULL,
  kind                       TEXT NOT NULL,
  taken_at                   TEXT,
  width                      INTEGER,
  height                     INTEGER,
  duration_ms                INTEGER,
  uploaded_by_membership_id  TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  removed_at                 TEXT,
  PRIMARY KEY (album_id, immich_asset_id),
  CHECK (kind IN ('image', 'video')),
  FOREIGN KEY (album_id, group_id)                  REFERENCES albums (id, group_id),
  FOREIGN KEY (uploaded_by_membership_id, group_id) REFERENCES memberships (id, group_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_assets_album ON album_assets (group_id, album_id, taken_at DESC);

-- ============================================================
-- 11. Flux iCal, notifications, e-mails
-- ============================================================

CREATE TABLE IF NOT EXISTS calendar_feed_tokens (
  id                TEXT NOT NULL PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  group_id          TEXT REFERENCES groups (id),
  token_hash        TEXT NOT NULL UNIQUE,
  label             TEXT,
  include_personal  INTEGER NOT NULL DEFAULT 0,
  include_declined  INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  last_used_at      TEXT,
  last_user_agent   TEXT,
  revoked_at        TEXT,
  CHECK (include_personal IN (0, 1)),
  CHECK (include_declined IN (0, 1))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_feeds_user ON calendar_feed_tokens (user_id, revoked_at);

CREATE TABLE IF NOT EXISTS notifications (
  id               TEXT NOT NULL PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  group_id         TEXT REFERENCES groups (id),
  kind             TEXT NOT NULL,
  subject_type     TEXT,
  subject_id       TEXT,
  payload_json     TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  read_at          TEXT,
  email_queued_at  TEXT,
  email_sent_at    TEXT,
  CHECK (json_valid(payload_json)),
  CHECK (kind IN (
    'invitation_received', 'member_joined', 'event_created', 'event_updated',
    'event_cancelled', 'poll_opened', 'poll_closing', 'item_claimed',
    'task_assigned', 'message_posted', 'expense_added', 'accounts_closed'
  )),
  CHECK (subject_type IS NULL OR subject_type IN (
    'group', 'invitation', 'event', 'date_poll', 'shopping_item',
    'event_task', 'thread', 'message', 'expense', 'album'
  ))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  group_id       TEXT NOT NULL,            -- identifiant de groupe, ou '*' pour le réglage global
  channel_email  INTEGER NOT NULL DEFAULT 1,
  digest         TEXT NOT NULL DEFAULT 'instant',
  muted_kinds    TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, group_id),
  CHECK (channel_email IN (0, 1)),
  CHECK (digest IN ('instant', 'daily', 'off')),
  CHECK (json_valid(muted_kinds))
) STRICT;

CREATE TABLE IF NOT EXISTS email_outbox (
  id                   TEXT NOT NULL PRIMARY KEY,
  to_email             TEXT NOT NULL,
  template_key         TEXT NOT NULL,
  payload_json         TEXT NOT NULL,
  locale               TEXT NOT NULL DEFAULT 'fr',
  group_id             TEXT REFERENCES groups (id),
  status               TEXT NOT NULL DEFAULT 'pending',
  attempts             INTEGER NOT NULL DEFAULT 0,
  next_attempt_at      TEXT NOT NULL,
  provider_message_id  TEXT,
  last_error           TEXT,
  created_at           TEXT NOT NULL,
  sent_at              TEXT,
  CHECK (status IN ('pending', 'sent', 'failed', 'abandoned')),
  CHECK (json_valid(payload_json)),
  CHECK (attempts >= 0)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON email_outbox (status, next_attempt_at);
