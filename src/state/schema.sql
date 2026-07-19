-- Gary's operational state. Source of truth is Linear + GitHub; this table
-- exists so Gary can detect "have I already acted on this state?" without
-- re-reading the universe.

CREATE TABLE IF NOT EXISTS tickets (
  linear_id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  classification TEXT,
  classification_confidence REAL,
  classification_scope TEXT,
  classification_type TEXT,
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
  provider TEXT,
  model TEXT,
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

-- Tracks which PR review comments Gary has already responded to. The
-- pr-review handler appends here on success; the loop's prCommentSignature
-- excludes already-responded ids so the action cache doesn't re-fire when
-- Gary's own response (or push) shifts other parts of the PR fingerprint.
CREATE TABLE IF NOT EXISTS pr_comment_responses (
  pr_github_id INTEGER NOT NULL,
  comment_id INTEGER NOT NULL,
  responded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (pr_github_id, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_pr_comment_responses_pr ON pr_comment_responses(pr_github_id);

-- Tracks the humanInputSignature Gary acted on for each Linear ticket.
-- Set by start_coding (after the PR opens) and revisit_code (after Gary
-- responds to a follow-up comment). The priority logic emits revisit_code
-- only when the current signature differs from what's recorded here, so
-- Gary doesn't keep responding to the same description.
CREATE TABLE IF NOT EXISTS ticket_revisit_marks (
  ticket_linear_id TEXT PRIMARY KEY,
  last_human_signature TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per reviewer agent invocation. The reviewer (added in a
-- later task) runs after the primary's post-finish check and before
-- push; this table is the calibration surface for tuning reviewer
-- aggressiveness ("rejection rate by round", "verdict by provider").
-- issue_id is the Linear linear_id, matching the FK shape used elsewhere.
CREATE TABLE IF NOT EXISTS review_passes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id        TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  round           INTEGER NOT NULL,
  verdict         TEXT NOT NULL,
  finding_count   INTEGER NOT NULL,
  advisory_count  INTEGER NOT NULL,
  provider_used   TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  duration_ms     INTEGER NOT NULL,
  escalated       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (issue_id) REFERENCES tickets(linear_id)
);

CREATE INDEX IF NOT EXISTS idx_review_passes_issue ON review_passes(issue_id);
CREATE INDEX IF NOT EXISTS idx_review_passes_verdict ON review_passes(verdict, created_at);
