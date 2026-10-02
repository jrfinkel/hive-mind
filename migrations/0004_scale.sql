-- Scale prep for ~150 concurrent players.
-- meta: precomputed JSON payloads (leaderboard, last round results) written at
-- scoring time so the hot /api/state path doesn't aggregate on every poll.
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- per-player vote lookups happen on every poll; index them.
CREATE INDEX idx_votes_player ON suggestion_votes (player_id);
