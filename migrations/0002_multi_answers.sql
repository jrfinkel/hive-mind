-- Questions are now "Name <num> <thing>" and players give <num> answers.

ALTER TABLE suggestions ADD COLUMN num INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rounds ADD COLUMN num INTEGER NOT NULL DEFAULT 1;

-- answers: allow multiple per player (one per slot) → UNIQUE(round, player, idx)
CREATE TABLE answers_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  idx INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  cluster_id INTEGER,
  points INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (round_id, player_id, idx)
);
INSERT INTO answers_new (id, round_id, player_id, idx, text, cluster_id, points, created_at)
  SELECT id, round_id, player_id, 0, text, cluster_id, points, created_at FROM answers;
DROP TABLE answers;
ALTER TABLE answers_new RENAME TO answers;
CREATE INDEX idx_answers_round ON answers (round_id);
