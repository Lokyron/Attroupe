-- 0004_agenda_externe.sql — synchronisation ENTRANTE d'un agenda externe (URL ICS distante : Google, Outlook…).
--
-- On n'en déduit que des PLAGES d'indisponibilité, visibles des groupes en « occupé » seulement : jamais de titre, de description
-- ni de lieu n'est stocké pour un créneau importé (CHECK ci-dessous, tenu dans la base quel que soit le chemin d'écriture).
--
-- ATTENTION — l'URL est un SECRET PORTEUR : l'« adresse secrète au format iCal » de Google (ou le lien de publication d'Outlook)
-- donne le calendrier COMPLET, détails compris, à quiconque la détient, sans autre authentification. Elle est donc chiffrée au repos
-- en AES-256-GCM avec ATTROUPE_ENCRYPTION_KEY (comme la clé d'API Immich : le tag GCM est concaténé à la fin de `url_cipher`).
-- Seuls restent en clair l'hôte (pour l'affichage) et l'empreinte SHA-256 de l'URL normalisée (pour l'unicité, sans le clair).
-- Elle ne doit jamais apparaître dans un journal, une réponse d'API ou un message d'erreur.

CREATE TABLE IF NOT EXISTS calendar_sources (
  id                   TEXT NOT NULL PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label                TEXT NOT NULL,
  url_cipher           BLOB NOT NULL,
  url_nonce            BLOB NOT NULL,
  url_host             TEXT NOT NULL,
  url_fingerprint      TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  disabled_at          TEXT,
  next_attempt_at      TEXT NOT NULL,
  last_attempt_at      TEXT,
  last_success_at      TEXT,
  last_status          TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  http_etag            TEXT,
  http_last_modified   TEXT,
  slots_imported       INTEGER NOT NULL DEFAULT 0,
  slots_skipped        INTEGER NOT NULL DEFAULT 0,
  CHECK (length(label) BETWEEN 1 AND 60),
  CHECK (length(url_host) BETWEEN 1 AND 255),
  CHECK (consecutive_failures >= 0),
  CHECK (last_status IS NULL OR last_status IN ('ok', 'vide', 'injoignable', 'trop_gros', 'illisible', 'refuse', 'cle_illisible')),
  UNIQUE (user_id, url_fingerprint)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_calendar_sources_user ON calendar_sources (user_id);

-- Sélecteur de la tâche de fond : seules les sources actives, par échéance.
CREATE INDEX IF NOT EXISTS idx_calendar_sources_due ON calendar_sources (next_attempt_at) WHERE disabled_at IS NULL;

-- Un créneau importé pointe vers sa source ; supprimer la source emporte ses créneaux. Le CHECK est porté par la colonne ajoutée
-- (pas d'ADD CONSTRAINT : son comportement dépend de la version de SQLite) : un créneau importé ne porte aucun texte.
ALTER TABLE personal_events ADD COLUMN calendar_source_id TEXT REFERENCES calendar_sources (id) ON DELETE CASCADE
  CHECK (calendar_source_id IS NULL OR (title = '' AND description IS NULL AND location_name IS NULL AND recurrence_rule IS NULL));

CREATE INDEX IF NOT EXISTS idx_personal_events_source ON personal_events (calendar_source_id, starts_at);

-- Un créneau importé ne se partage JAMAIS en « details » (il n'a aucun détail à montrer). Déclencheurs, et non code applicatif,
-- pour que l'invariant tienne quel que soit le chemin d'écriture (même raison que trg_push_subscriptions_reattribution en 0003).
CREATE TRIGGER IF NOT EXISTS trg_pes_import_sans_details_insert
BEFORE INSERT ON personal_event_shares
WHEN NEW.visibility = 'details'
BEGIN
  SELECT RAISE(ABORT, 'partage.import_sans_details')
  WHERE EXISTS (SELECT 1 FROM personal_events WHERE id = NEW.personal_event_id AND calendar_source_id IS NOT NULL);
END;

CREATE TRIGGER IF NOT EXISTS trg_pes_import_sans_details_update
BEFORE UPDATE OF visibility ON personal_event_shares
WHEN NEW.visibility = 'details'
BEGIN
  SELECT RAISE(ABORT, 'partage.import_sans_details')
  WHERE EXISTS (SELECT 1 FROM personal_events WHERE id = NEW.personal_event_id AND calendar_source_id IS NOT NULL);
END;

-- Un créneau saisi à la main ne se supprime jamais réellement (suppression douce par `deleted_at`) ; le remplacement d'un lot importé,
-- lui, est un vrai DELETE.
CREATE TRIGGER IF NOT EXISTS trg_personal_events_suppression_douce
BEFORE DELETE ON personal_events
WHEN OLD.calendar_source_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'creneau.suppression_douce_seulement');
END;
