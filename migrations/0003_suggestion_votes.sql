-- Suggestions are tied to a player (admin sees who suggested); players can
-- up/down-vote pending suggestions while waiting between rounds.

ALTER TABLE suggestions ADD COLUMN player_id TEXT REFERENCES players(id);

CREATE TABLE suggestion_votes (
  suggestion_id INTEGER NOT NULL REFERENCES suggestions(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  vote INTEGER NOT NULL, -- +1 or -1
  PRIMARY KEY (suggestion_id, player_id)
);
