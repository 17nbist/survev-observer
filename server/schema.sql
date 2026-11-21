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
