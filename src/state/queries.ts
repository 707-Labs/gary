import type { DB } from "./db.ts";

// Stub query helpers. Filled in as handlers need them. Kept thin so SQL
// stays close to the call site instead of hidden behind ORM-style helpers.
//
// db is opened with strict: true, which means named parameters are passed
// as bare keys (e.g. { linearId }) and matched to $name / :name / @name in SQL.

export interface TicketRow {
  linear_id: string;
  identifier: string;
  classification: "CODE" | "ANSWER" | "BOUNCE" | null;
  classification_confidence: number | null;
  classification_scope: "S" | "M" | "L" | null;
  classified_at: string | null;
  last_polled_at: string | null;
  terminal_state: "merged" | "bounced" | "escalated" | null;
}

export function getTicket(db: DB, linearId: string): TicketRow | null {
  const row = db
    .query<TicketRow, [string]>(
      "SELECT linear_id, identifier, classification, classification_confidence, classification_scope, classified_at, last_polled_at, terminal_state FROM tickets WHERE linear_id = ?",
    )
    .get(linearId);
  return row ?? null;
}

export function upsertTicket(
  db: DB,
  ticket: { linearId: string; identifier: string },
): void {
  db.query(
    `INSERT INTO tickets (linear_id, identifier, last_polled_at)
     VALUES ($linearId, $identifier, datetime('now'))
     ON CONFLICT(linear_id) DO UPDATE SET
       identifier = excluded.identifier,
       last_polled_at = datetime('now')`,
  ).run({ linearId: ticket.linearId, identifier: ticket.identifier });
}

export function recordEvent(
  db: DB,
  args: {
    eventType: string;
    ticketLinearId?: string | null;
    payload?: unknown;
  },
): void {
  db.query(
    `INSERT INTO events (ticket_linear_id, event_type, payload_json)
     VALUES ($ticket, $type, $payload)`,
  ).run({
    ticket: args.ticketLinearId ?? null,
    type: args.eventType,
    payload: args.payload ? JSON.stringify(args.payload) : null,
  });
}

export function hasActedOn(
  db: DB,
  args: { ticketLinearId: string; stateFingerprint: string; actionType: string },
): boolean {
  const row = db
    .query<{ n: number }, { t: string; f: string; a: string }>(
      `SELECT COUNT(*) AS n FROM actions
       WHERE ticket_linear_id = $t
         AND state_fingerprint = $f
         AND action_type = $a
         AND success = 1`,
    )
    .get({
      t: args.ticketLinearId,
      f: args.stateFingerprint,
      a: args.actionType,
    });
  return (row?.n ?? 0) > 0;
}

export function recordActionStart(
  db: DB,
  args: {
    ticketLinearId: string;
    stateFingerprint: string;
    actionType: string;
    provider?: string;
    model?: string;
  },
): number {
  const result = db
    .query(
      `INSERT INTO actions (ticket_linear_id, state_fingerprint, action_type, started_at, provider, model)
       VALUES ($t, $f, $a, datetime('now'), $provider, $model)`,
    )
    .run({
      t: args.ticketLinearId,
      f: args.stateFingerprint,
      a: args.actionType,
      provider: args.provider ?? null,
      model: args.model ?? null,
    });
  return Number(result.lastInsertRowid);
}

export function recordActionEnd(
  db: DB,
  args: { id: number; success: boolean; errorMessage?: string },
): void {
  db.query(
    `UPDATE actions
     SET completed_at = datetime('now'),
         success = $success,
         error_message = $err
     WHERE id = $id`,
  ).run({
    id: args.id,
    success: args.success ? 1 : 0,
    err: args.errorMessage ?? null,
  });
}

export function setClassification(
  db: DB,
  args: {
    linearId: string;
    classification: "CODE" | "ANSWER" | "BOUNCE";
    confidence: number;
    scope: "S" | "M" | "L";
  },
): void {
  db.query(
    `UPDATE tickets SET
       classification = $cls,
       classification_confidence = $conf,
       classification_scope = $scope,
       classified_at = datetime('now')
     WHERE linear_id = $id`,
  ).run({
    id: args.linearId,
    cls: args.classification,
    conf: args.confidence,
    scope: args.scope,
  });
}

export function setTerminalState(
  db: DB,
  linearId: string,
  state: "merged" | "bounced" | "escalated",
): void {
  db.query(`UPDATE tickets SET terminal_state = $state WHERE linear_id = $id`).run({
    id: linearId,
    state,
  });
}

/**
 * Clear `terminal_state` so the loop re-engages on the ticket. Called when
 * Gary previously concluded a ticket (bounce/escalate) but a human has
 * reassigned it back to him in Linear.
 */
export function clearTerminalState(db: DB, linearId: string): void {
  db.query(`UPDATE tickets SET terminal_state = NULL WHERE linear_id = $id`).run({
    id: linearId,
  });
}

/**
 * Wipe the classification fields so the classifier runs fresh on the next
 * tick. Used when reopening a previously bounced ticket — the new context
 * (comments added since the bounce) may now route to CODE or ANSWER.
 */
export function clearClassification(db: DB, linearId: string): void {
  db.query(
    `UPDATE tickets SET
       classification = NULL,
       classification_confidence = NULL,
       classification_scope = NULL,
       classified_at = NULL
     WHERE linear_id = $id`,
  ).run({ id: linearId });
}

export interface CountSinceArgs {
  ticketLinearId: string;
  sinceHoursAgo: number;
  /** Count only attempts that did not succeed: failed, or never completed. */
  failedOnly?: boolean;
  /** Restrict to one action type, e.g. "fix_ci_failure". */
  actionType?: string;
  /** Clock override for tests; defaults to the current time. */
  now?: Date;
}

/**
 * Format a Date the way `datetime('now')` writes it: "YYYY-MM-DD HH:MM:SS"
 * in UTC. Every timestamp column in this schema is written by SQLite, so
 * any cutoff compared against them has to use this shape. SQLite compares
 * TEXT bytewise and an ISO string ("2026-08-31T13:00:00.000Z") sorts after
 * every row from the same day because " " < "T".
 */
export function sqliteTimestamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Attempt count for the circuit breaker (and CI-attempt cap).
 * `wait_for_blocker` is excluded: it's a hold, not an attempt, and it can
 * legitimately re-fire on every human comment while a ticket sits blocked —
 * five comments in six hours must not read as thrashing and trigger a
 * bogus "i'm stuck" escalation.
 *
 * Until 2026-09 the cutoff was an ISO string, so this only ever counted rows
 * from *earlier UTC days* than the cutoff and the circuit breaker could not
 * trip inside its own window; it fired twice in five months, both times just
 * after midnight UTC, while one ticket burned 425 failed classify attempts in
 * a day (mb-b2tw). Keep the cutoff in `sqliteTimestamp` form.
 */
export function countActionsSince(db: DB, args: CountSinceArgs): number {
  const row = db
    .query<
      { n: number },
      { id: string; cutoff: string; type: string | null; failedOnly: number }
    >(
      `SELECT COUNT(*) AS n FROM actions
       WHERE ticket_linear_id = $id
         AND started_at >= $cutoff
         AND action_type != 'wait_for_blocker'
         AND ($type IS NULL OR action_type = $type)
         AND ($failedOnly = 0 OR success IS NULL OR success = 0)`,
    )
    .get({
      id: args.ticketLinearId,
      cutoff: sqliteTimestamp(
        new Date((args.now ?? new Date()).getTime() - args.sinceHoursAgo * 3_600_000),
      ),
      type: args.actionType ?? null,
      failedOnly: args.failedOnly ? 1 : 0,
    });
  return row?.n ?? 0;
}

export function recordPr(
  db: DB,
  args: {
    githubId: number;
    ticketLinearId: string;
    repo: string;
    prNumber: number;
    branch: string;
  },
): void {
  db.query(
    `INSERT INTO prs (github_id, ticket_linear_id, repo, pr_number, branch, opened_at)
     VALUES ($id, $ticket, $repo, $num, $branch, datetime('now'))
     ON CONFLICT(github_id) DO UPDATE SET
       ticket_linear_id = excluded.ticket_linear_id,
       repo = excluded.repo,
       pr_number = excluded.pr_number,
       branch = excluded.branch`,
  ).run({
    id: args.githubId,
    ticket: args.ticketLinearId,
    repo: args.repo,
    num: args.prNumber,
    branch: args.branch,
  });
}

/**
 * Record that GitHub reports the PR closed. `closed_at` keeps the first
 * observation; `merged` is whatever GitHub says now. Gary only learns this
 * while the ticket is still assigned and polled, so a PR closed after
 * hand-off stays open here: these columns are an observation log, not a
 * mirror of GitHub. Before 2026-09 nothing wrote them at all (mb-b2tw).
 */
export function markPrClosed(
  db: DB,
  args: { githubId: number; merged: boolean },
): void {
  db.query(
    `UPDATE prs
     SET closed_at = COALESCE(closed_at, datetime('now')),
         merged = $merged
     WHERE github_id = $id`,
  ).run({ id: args.githubId, merged: args.merged ? 1 : 0 });
}

export interface PrRow {
  github_id: number;
  ticket_linear_id: string;
  repo: string;
  pr_number: number;
  branch: string;
}

export function getPrForTicket(db: DB, ticketLinearId: string): PrRow | null {
  const row = db
    .query<PrRow, [string]>(
      `SELECT github_id, ticket_linear_id, repo, pr_number, branch
       FROM prs WHERE ticket_linear_id = ? ORDER BY opened_at DESC LIMIT 1`,
    )
    .get(ticketLinearId);
  return row ?? null;
}

export function getRevisitMark(
  db: DB,
  ticketLinearId: string,
): string | null {
  const row = db
    .query<{ last_human_signature: string }, [string]>(
      `SELECT last_human_signature FROM ticket_revisit_marks WHERE ticket_linear_id = ?`,
    )
    .get(ticketLinearId);
  return row?.last_human_signature ?? null;
}

export function setRevisitMark(
  db: DB,
  ticketLinearId: string,
  humanSignature: string,
): void {
  db.query(
    `INSERT INTO ticket_revisit_marks (ticket_linear_id, last_human_signature)
     VALUES ($id, $sig)
     ON CONFLICT(ticket_linear_id) DO UPDATE SET
       last_human_signature = excluded.last_human_signature,
       updated_at = datetime('now')`,
  ).run({ id: ticketLinearId, sig: humanSignature });
}

export function getRespondedPrCommentIds(
  db: DB,
  prGithubId: number,
): readonly number[] {
  const rows = db
    .query<{ comment_id: number }, [number]>(
      `SELECT comment_id FROM pr_comment_responses WHERE pr_github_id = ?`,
    )
    .all(prGithubId);
  return rows.map((r) => r.comment_id);
}

export function markPrCommentsResponded(
  db: DB,
  prGithubId: number,
  commentIds: readonly number[],
): void {
  if (commentIds.length === 0) return;
  const stmt = db.query(
    `INSERT OR IGNORE INTO pr_comment_responses (pr_github_id, comment_id)
     VALUES ($prId, $commentId)`,
  );
  for (const id of commentIds) {
    stmt.run({ prId: prGithubId, commentId: id });
  }
}
