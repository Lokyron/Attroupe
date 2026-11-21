-- ADR-0017 : un seul réglage de compte pour la visibilité de l'agenda personnel. La valeur est un PLAFOND posé au-dessus des partages
-- par groupe (`personal_event_shares`), lu à chaque lecture des disponibilités d'un groupe : abaisser le réglage masque tout, tout de suite.
-- `memberships.default_personal_visibility` reste en base, dormante : plus aucun chemin ne la lit ni ne l'écrit.
ALTER TABLE users ADD COLUMN personal_agenda_visibility TEXT NOT NULL DEFAULT 'busy'
  CHECK (personal_agenda_visibility IN ('none', 'busy', 'details'));

-- Amorçage : le choix le PLUS RESTRICTIF que le compte avait déjà exprimé, groupe par groupe (un compte sans appartenance active reste à « busy »).
-- La migration ne touche aucune ligne de `personal_event_shares` : le jour de la mise à jour, rien ne devient visible qui ne l'était pas.
UPDATE users SET personal_agenda_visibility = COALESCE((
  SELECT m.default_personal_visibility
    FROM memberships AS m
   WHERE m.user_id = users.id AND m.status = 'active'
   ORDER BY CASE m.default_personal_visibility WHEN 'none' THEN 0 WHEN 'busy' THEN 1 ELSE 2 END
   LIMIT 1
), 'busy');
