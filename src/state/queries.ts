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
  args: { ticketLinearId: string; stateFingerprint: string; actionType: string },
): number {
  const result = db
    .query(
      `INSERT INTO actions (ticket_linear_id, state_fingerprint, action_type, started_at)
       VALUES ($t, $f, $a, datetime('now'))`,
    )
    .run({
      t: args.ticketLinearId,
      f: args.stateFingerprint,
      a: args.actionType,
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

export interface CountSinceArgs {
  ticketLinearId: string;
  sinceHoursAgo: number;
}

export function countActionsSince(db: DB, args: CountSinceArgs): number {
  const row = db
    .query<{ n: number }, { id: string; cutoff: string }>(
      `SELECT COUNT(*) AS n FROM actions
       WHERE ticket_linear_id = $id
         AND started_at >= $cutoff`,
    )
    .get({
      id: args.ticketLinearId,
      cutoff: new Date(Date.now() - args.sinceHoursAgo * 3_600_000).toISOString(),
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
