-- Sort le type de liste hors du titre (`shopping_lists.kind`).

ALTER TABLE shopping_lists ADD COLUMN kind TEXT NOT NULL DEFAULT 'courses'
  CHECK (kind IN ('courses', 'affaires', 'taches'));

UPDATE shopping_lists
SET kind = 'affaires',
    title = substr(title, length('Affaires : ') + 1)
WHERE title LIKE 'Affaires : %' AND length(title) > length('Affaires : ');

UPDATE shopping_lists
SET kind = 'taches',
    title = substr(title, length('Tâches : ') + 1)
WHERE title LIKE 'Tâches : %' AND length(title) > length('Tâches : ');
