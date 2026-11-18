CREATE TABLE IF NOT EXISTS task_statuses (
  status TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
