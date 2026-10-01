-- Hive Mind initial schema. Timestamps are unix epoch seconds.

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  author TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | used | rejected
  created_at INTEGER NOT NULL
);

CREATE TABLE rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  suggestion_id INTEGER REFERENCES suggestions(id),
  status TEXT NOT NULL DEFAULT 'open', -- open | scoring | scored
  opened_at INTEGER NOT NULL,
  closes_at INTEGER, -- null = no timer, admin closes manually
  scored_at INTEGER
);

CREATE TABLE answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  text TEXT NOT NULL,
  cluster_id INTEGER,
  points INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (round_id, player_id)
);

CREATE TABLE clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id),
  label TEXT NOT NULL,
  size INTEGER NOT NULL
);

CREATE INDEX idx_answers_round ON answers (round_id);
CREATE INDEX idx_clusters_round ON clusters (round_id);
