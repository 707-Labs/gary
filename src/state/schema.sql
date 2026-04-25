-- Gary's operational state. Source of truth is Linear + GitHub; this table
-- exists so Gary can detect "have I already acted on this state?" without
-- re-reading the universe.

CREATE TABLE IF NOT EXISTS tickets (
  linear_id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  classification TEXT,
  classification_confidence REAL,
  classification_scope TEXT,
  classified_at TEXT,
  last_polled_at TEXT,
  terminal_state TEXT
);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_linear_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  state_fingerprint TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  success INTEGER,
  error_message TEXT,
  FOREIGN KEY (ticket_linear_id) REFERENCES tickets(linear_id)
);

CREATE INDEX IF NOT EXISTS idx_actions_fingerprint
  ON actions(ticket_linear_id, state_fingerprint, action_type);

CREATE TABLE IF NOT EXISTS prs (
  github_id INTEGER PRIMARY KEY,
  ticket_linear_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  branch TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  merged INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (ticket_linear_id) REFERENCES tickets(linear_id)
);

CREATE INDEX IF NOT EXISTS idx_prs_ticket ON prs(ticket_linear_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ticket_linear_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_ticket ON events(ticket_linear_id);
