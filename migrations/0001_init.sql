-- Hermes Virtual Office schema.
-- Apply with: wrangler d1 migrations apply hermes-office --local

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL DEFAULT 'main',
  name TEXT,
  role TEXT,
  color TEXT,
  desk_index INTEGER
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT,
  status TEXT,
  office_label TEXT,
  owner_agent TEXT,
  updated_at TEXT
);

CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  title TEXT,
  room TEXT,
  status TEXT,
  created_at TEXT
);

CREATE TABLE minutes (
  id TEXT PRIMARY KEY,
  meeting_id TEXT REFERENCES meetings(id),
  content TEXT,
  created_at TEXT
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  action TEXT,
  detail TEXT,
  created_at TEXT
);
