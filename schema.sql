CREATE TABLE IF NOT EXISTS users (
  install_hash TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  country TEXT,
  region TEXT,
  city TEXT,
  platform TEXT,
  app_version TEXT,
  resolve_version TEXT,
  event_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  install_hash TEXT NOT NULL,
  event TEXT NOT NULL,
  created_at TEXT NOT NULL,
  country TEXT,
  region TEXT,
  city TEXT,
  app_version TEXT,
  resolve_version TEXT,
  platform TEXT,
  session_seconds INTEGER NOT NULL DEFAULT 0,
  extra_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);
CREATE INDEX IF NOT EXISTS idx_events_install_hash ON events(install_hash);
