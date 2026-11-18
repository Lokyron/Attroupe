-- 0005_agenda_externe_details.sql — le propriétaire d'un agenda importé relit SES titres, descriptions et lieux (ADR-0013, révision du 2026-11-18).
--
-- Les textes ne sont PAS écrits dans `title`, `description`, `location_name` : le CHECK de 0004 les impose vides pour un créneau importé
-- et ne bouge pas. Ils vont, sous forme d'un JSON {titre?, description?, lieu?}, dans `details_cipher`, chiffré en AES-256-GCM avec
-- ATTROUPE_ENCRYPTION_KEY (le tag GCM est concaténé à la fin de `details_cipher`, comme pour `url_cipher`).
-- `listerDisponibilitesGroupe` ne lit pas ces colonnes et ne sait pas les déchiffrer : la garantie envers les groupes est structurelle.
--
-- Pas d'ADD CONSTRAINT (comportement dépendant de la version de SQLite) : les CHECK sont portés par les colonnes ajoutées.

-- `details_nonce` d'abord : le CHECK de `details_cipher` y fait référence.
ALTER TABLE personal_events ADD COLUMN details_nonce BLOB;

-- Les deux colonnes sont nulles ensemble, ou non nulles ensemble ; et un créneau saisi à la main (calendar_source_id NULL)
-- ne porte aucun blob : ses textes sont en clair dans `title`.
ALTER TABLE personal_events ADD COLUMN details_cipher BLOB
  CHECK ((details_cipher IS NULL) = (details_nonce IS NULL) AND (details_cipher IS NULL OR calendar_source_id IS NOT NULL));
