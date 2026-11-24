-- survev observer: uploaded batches, kept until the clip jury pulls them (then deleted). ip is a salted daily hash, for the rate
-- limit only; no address is stored.
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ip TEXT,
  enc TEXT NOT NULL,
  size INTEGER NOT NULL,
  ver TEXT,
  body BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS batches_token_ts ON batches (token, ts);
CREATE INDEX IF NOT EXISTS batches_ip_ts ON batches (ip, ts);

-- the copy of what the game's server sent a player's game (observer 1.8.0), in chunks, kept until the clip jury pulls it (then deleted).
-- meta is on seq 0 only; iph is the same salted daily hash as batches.ip, for the rate limit only.
CREATE TABLE IF NOT EXISTS wire (
  sess TEXT NOT NULL,
  match INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  meta TEXT,
  data BLOB NOT NULL,
  size INTEGER NOT NULL,
  at INTEGER NOT NULL,
  iph TEXT,
  PRIMARY KEY (sess, match, seq)
);
CREATE INDEX IF NOT EXISTS wire_sess_at ON wire (sess, at);
CREATE INDEX IF NOT EXISTS wire_iph_at ON wire (iph, at);
