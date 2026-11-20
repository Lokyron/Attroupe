-- Reconstruit `notifications` pour étendre les contraintes CHECK de `kind` et `subject_type`
-- aux modifications/suppressions de dépenses et aux règlements.

CREATE TABLE notifications_nouvelle (
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
    'task_assigned', 'message_posted', 'expense_added', 'expense_updated',
    'expense_deleted', 'settlement_created', 'settlement_confirmed', 'accounts_closed'
  )),
  CHECK (subject_type IS NULL OR subject_type IN (
    'group', 'invitation', 'event', 'date_poll', 'shopping_item',
    'event_task', 'thread', 'message', 'expense', 'settlement', 'album'
  ))
) STRICT;

INSERT INTO notifications_nouvelle (
  id, user_id, group_id, kind, subject_type, subject_id,
  payload_json, created_at, read_at, email_queued_at, email_sent_at
)
SELECT
  id, user_id, group_id, kind, subject_type, subject_id,
  payload_json, created_at, read_at, email_queued_at, email_sent_at
FROM notifications;

DROP TABLE notifications;

ALTER TABLE notifications_nouvelle RENAME TO notifications;

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, read_at, created_at DESC);
