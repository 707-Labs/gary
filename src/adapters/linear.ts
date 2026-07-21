import { LinearClient } from "@linear/sdk";
import type { Config } from "../config.ts";
import { log } from "../logger.ts";

export interface AssignedIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  stateName: string;
  stateType: string;
  createdAt: string;
  updatedAt: string;
  creatorId: string | null;
  creatorName: string | null;
  teamId: string;
  teamKey: string;
}

export interface IssueComment {
  id: string;
  body: string;
  createdAt: string;
  userId: string | null;
  userName: string | null;
}

export interface ViewerInfo {
  id: string;
  name: string;
  displayName: string;
  email: string;
}

export type WorkflowStateType =
  | "triage"
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

/** Workflow states change rarely (team workflow restructuring). 30 min
 * keeps load light while bounding staleness for `setStateByType`. */
const TEAM_STATES_TTL_MS = 30 * 60_000;

/**
 * Whether the assignment pipeline should skip a workflow state type.
 * See `LinearAdapter.DEFAULT_SKIPPED_STATE_TYPES` for the rationale.
 *
 * An unknown/missing state type is NEVER skipped — failing open keeps Gary
 * working when Linear returns a shape we don't recognize, which matches the
 * pre-existing behavior for null states.
 *
 * Exported for tests.
 */
export function isSkippedStateType(
  stateType: string | undefined,
  skipped: readonly string[] = resolveSkippedStateTypes(),
): boolean {
  if (stateType === undefined) return false;
  return skipped.includes(stateType);
}

/**
 * Read the skip list from `GARY_SKIP_STATE_TYPES`, falling back to the
 * defaults. Read per call rather than cached at module init so the mini can
 * be retuned with a restart instead of a deploy. An empty value means "skip
 * nothing extra" but still drops terminal states — losing the
 * completed/canceled guard to a stray env var would make Gary re-work
 * finished tickets.
 */
export function resolveSkippedStateTypes(): readonly string[] {
  const raw = process.env.GARY_SKIP_STATE_TYPES?.trim();
  if (raw === undefined) return LinearAdapter.DEFAULT_SKIPPED_STATE_TYPES;
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...new Set(["completed", "canceled", ...parsed])];
}

const RETRY_BACKOFFS_MS = [500, 1500, 4000] as const;

function isTransientLinearError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // Linear edge throws 5xx as message text; SDK + graphql-request preserve it.
  // Network/DNS failures surface as ENOTFOUND/EAI_AGAIN/ECONNRESET/ETIMEDOUT/fetch failed.
  if (/\b50[0-9]\b/.test(msg)) return true;
  if (msg.includes("bad gateway") || msg.includes("gateway timeout")) return true;
  if (msg.includes("service unavailable")) return true;
  if (msg.includes("enotfound") || msg.includes("eai_again")) return true;
  if (msg.includes("econnreset") || msg.includes("etimedout")) return true;
  if (msg.includes("fetch failed") || msg.includes("socket hang up")) return true;
  return false;
}

/** Retry idempotent Linear reads on 5xx / network errors. Mutations must not
 * use this — a 502 after the server committed would double-write. */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === RETRY_BACKOFFS_MS.length || !isTransientLinearError(err)) {
        throw err;
      }
      const wait = RETRY_BACKOFFS_MS[attempt]!;
      log.warn("linear transient error; retrying", {
        label,
        attempt: attempt + 1,
        waitMs: wait,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

export class LinearAdapter {
  private readonly client: LinearClient;
  private readonly userId: string;
  private readonly inProgressStateId: string;
  private readonly teamStatesCache = new Map<
    string,
    {
      states: readonly { id: string; name: string; type: string }[];
      fetchedAt: number;
    }
  >();

  constructor(cfg: Pick<Config, "linear" | "gary">) {
    this.client = new LinearClient({ apiKey: cfg.linear.apiKey });
    this.userId = cfg.gary.linearUserId;
    this.inProgressStateId = cfg.linear.inProgressStateId;
  }

  /** Gary's Linear user id — exposed so the loop can filter his own comments. */
  get linearUserId(): string {
    return this.userId;
  }

  async getViewer(): Promise<ViewerInfo> {
    const v = await withRetry("getViewer", () => this.client.viewer);
    return {
      id: v.id,
      name: v.name,
      displayName: v.displayName,
      email: v.email,
    };
  }

  /**
   * State types the assignment pipeline refuses to pick up.
   *
   * `completed`/`canceled` are terminal. `backlog` is the staging gate: a
   * ticket parked in Backlog is deliberately not ready — typically because a
   * predecessor hasn't merged yet. Before this filter existed, assignment was
   * the ONLY gate, so decomposing an epic into a dependency chain and parking
   * the dependents in Backlog did nothing: Gary pulled all of them into In
   * Progress at once and the dependents built against a main missing their
   * predecessors' code (burning quota to fail typecheck).
   *
   * Deliberately a denylist, not an `unstarted`/`started` allowlist — an
   * allowlist silently drops any state type Linear adds later, and going
   * dark on new tickets is a worse failure than picking up one too many.
   *
   * Triage is intentionally still worked: a ticket lands in Triage
   * unassigned, so Gary holding it means a human assigned it on purpose.
   *
   * Note this gates the ASSIGNMENT pipeline only. `fetchMentionedIssues` is
   * deliberately unfiltered, so an explicit `@gary` overrides the parking
   * brake — "park in Backlog, @mention when the predecessor lands" is a
   * clean staging workflow that needs no unassign/reassign dance.
   *
   * Override with `GARY_SKIP_STATE_TYPES` (comma-separated) without a deploy.
   */
  static readonly DEFAULT_SKIPPED_STATE_TYPES: readonly string[] = [
    "completed",
    "canceled",
    "backlog",
  ];

  async fetchAssignedIssues(): Promise<AssignedIssue[]> {
    // Single raw GraphQL roundtrip — the SDK's lazy resolvers (`issue.state`,
    // `issue.team`, `issue.creator`) each cost a network call, which adds up
    // fast on a per-tick basis. Mirror the fetchMentionedIssues pattern.
    const query = `
      query AssignedIssues($userId: ID!, $first: Int!) {
        issues(
          filter: { assignee: { id: { eq: $userId } } },
          first: $first
        ) {
          nodes {
            id
            identifier
            title
            description
            url
            createdAt
            updatedAt
            state { name type }
            team { id key }
            creator { id name }
          }
        }
      }
    `;
    const data = await withRetry("fetchAssignedIssues", () =>
      this.client.client.request<
        {
          issues: {
            nodes: {
              id: string;
              identifier: string;
              title: string;
              description: string | null;
              url: string;
              createdAt: string;
              updatedAt: string;
              state: { name: string; type: string } | null;
              team: { id: string; key: string } | null;
              creator: { id: string; name: string } | null;
            }[];
          };
        },
        { userId: string; first: number }
      >(query, { userId: this.userId, first: 50 }),
    );

    return data.issues.nodes
      .filter((n) => !isSkippedStateType(n.state?.type))
      .map((n) => ({
        id: n.id,
        identifier: n.identifier,
        title: n.title,
        description: n.description ?? null,
        url: n.url,
        stateName: n.state?.name ?? "",
        stateType: n.state?.type ?? "",
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        creatorId: n.creator?.id ?? null,
        creatorName: n.creator?.name ?? null,
        teamId: n.team?.id ?? "",
        teamKey: n.team?.key ?? "",
      }));
  }

  /**
   * Issues where Gary is a subscriber but NOT the assignee. In Linear, being
   * @mentioned auto-subscribes you, so this is a reasonable proxy for "tickets
   * mentioning Gary". Done via raw GraphQL to inline state/team/creator and
   * avoid the N+1 the lazy resolvers in `fetchAssignedIssues` cause.
   */
  async fetchMentionedIssues(): Promise<AssignedIssue[]> {
    // Linear's filter expects ID! (not String!) for user-id equality —
    // sending String! gets the GraphQL validator to 400.
    const query = `
      query MentionedIssues($userId: ID!, $first: Int!) {
        issues(
          filter: { subscribers: { id: { eq: $userId } } },
          first: $first
        ) {
          nodes {
            id
            identifier
            title
            description
            url
            createdAt
            updatedAt
            state { name type }
            team { id key }
            creator { id name }
            assignee { id }
          }
        }
      }
    `;
    const data = await withRetry("fetchMentionedIssues", () =>
      this.client.client.request<
        {
          issues: {
            nodes: {
              id: string;
              identifier: string;
              title: string;
              description: string | null;
              url: string;
              createdAt: string;
              updatedAt: string;
              state: { name: string; type: string } | null;
              team: { id: string; key: string } | null;
              creator: { id: string; name: string } | null;
              assignee: { id: string } | null;
            }[];
          };
        },
        { userId: string; first: number }
      >(query, { userId: this.userId, first: 50 }),
    );

    return data.issues.nodes
      .filter((n) => n.assignee?.id !== this.userId)
      .filter(
        (n) =>
          n.state?.type !== "completed" && n.state?.type !== "canceled",
      )
      .map((n) => ({
        id: n.id,
        identifier: n.identifier,
        title: n.title,
        description: n.description ?? null,
        url: n.url,
        stateName: n.state?.name ?? "",
        stateType: n.state?.type ?? "",
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        creatorId: n.creator?.id ?? null,
        creatorName: n.creator?.name ?? null,
        teamId: n.team?.id ?? "",
        teamKey: n.team?.key ?? "",
      }));
  }

  /**
   * Look up an issue by its identifier (e.g. "ERT-1500"). Returns null if no
   * issue matches. Same shape as fetchAssignedIssues entries.
   */
  async fetchByIdentifier(identifier: string): Promise<AssignedIssue | null> {
    const result = await withRetry(`fetchByIdentifier(${identifier})`, () =>
      this.client.issues({
        filter: { number: { eq: parseIdentifierNumber(identifier) }, team: { key: { eq: parseIdentifierTeamKey(identifier) } } },
        first: 1,
      }),
    );
    const issue = result.nodes[0];
    if (!issue) return null;
    const [state, team, creator] = await withRetry(
      `fetchByIdentifier(${identifier}).resolvers`,
      () => Promise.all([issue.state, issue.team, issue.creator]),
    );
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? null,
      url: issue.url,
      stateName: state?.name ?? "",
      stateType: state?.type ?? "",
      createdAt: issue.createdAt.toISOString(),
      updatedAt: issue.updatedAt.toISOString(),
      creatorId: creator?.id ?? null,
      creatorName: creator?.name ?? null,
      teamId: team?.id ?? "",
      teamKey: team?.key ?? "",
    };
  }

  /**
   * Point-in-time state + assignee of an issue, one raw GraphQL call.
   * Used by the code handler's pre-open guard to abort a PR when the
   * ticket concluded (or was pulled from Gary) while the agent was
   * working. Returns null when the issue can't be found.
   */
  async fetchIssueStatus(issueId: string): Promise<{
    stateName: string;
    stateType: string;
    assigneeId: string | null;
  } | null> {
    const query = `
      query IssueStatus($id: String!) {
        issue(id: $id) {
          state { name type }
          assignee { id }
        }
      }
    `;
    const data = await withRetry(`fetchIssueStatus(${issueId})`, () =>
      this.client.client.request<
        {
          issue: {
            state: { name: string; type: string } | null;
            assignee: { id: string } | null;
          } | null;
        },
        { id: string }
      >(query, { id: issueId }),
    );
    const issue = data.issue;
    if (!issue) return null;
    return {
      stateName: issue.state?.name ?? "",
      stateType: issue.state?.type ?? "",
      assigneeId: issue.assignee?.id ?? null,
    };
  }

  /**
   * Fetch only id + author + createdAt for an issue's comments. Uses one raw
   * GraphQL call (vs `fetchComments` which lazily resolves user records and
   * incurs N+1 round trips). Used in the loop to compute the human-input
   * signature without blowing the Linear rate limit.
   */
  async fetchCommentMeta(
    issueId: string,
    limit = 50,
  ): Promise<{ id: string; userId: string | null; createdAt: string }[]> {
    const query = `
      query CommentMeta($id: String!, $first: Int!) {
        issue(id: $id) {
          comments(first: $first) {
            nodes {
              id
              createdAt
              user { id }
            }
          }
        }
      }
    `;
    const data = await withRetry(`fetchCommentMeta(${issueId})`, () =>
      this.client.client.request<
        {
          issue: {
            comments: {
              nodes: {
                id: string;
                createdAt: string;
                user: { id: string } | null;
              }[];
            };
          } | null;
        },
        { id: string; first: number }
      >(query, { id: issueId, first: limit }),
    );
    const nodes = data.issue?.comments?.nodes ?? [];
    return nodes.map((n) => ({
      id: n.id,
      createdAt: n.createdAt,
      userId: n.user?.id ?? null,
    }));
  }

  async fetchComments(issueId: string, limit = 20): Promise<IssueComment[]> {
    // Single roundtrip vs the SDK's N+2 (issue lookup + comments page + per-
    // comment user resolve). Same shape; trades the SDK's typed wrappers for
    // a one-shot GraphQL response.
    const query = `
      query IssueComments($id: String!, $first: Int!) {
        issue(id: $id) {
          comments(first: $first) {
            nodes {
              id
              body
              createdAt
              user { id name }
            }
          }
        }
      }
    `;
    const data = await withRetry(`fetchComments(${issueId})`, () =>
      this.client.client.request<
        {
          issue: {
            comments: {
              nodes: {
                id: string;
                body: string;
                createdAt: string;
                user: { id: string; name: string } | null;
              }[];
            };
          } | null;
        },
        { id: string; first: number }
      >(query, { id: issueId, first: limit }),
    );
    const nodes = data.issue?.comments?.nodes ?? [];
    return nodes.map((n) => ({
      id: n.id,
      body: n.body,
      createdAt: n.createdAt,
      userId: n.user?.id ?? null,
      userName: n.user?.name ?? null,
    }));
  }

  async postComment(issueId: string, body: string): Promise<string> {
    const result = await this.client.createComment({ issueId, body });
    const comment = await result.comment;
    if (!comment) {
      throw new Error(`Failed to create comment on ${issueId}: ${JSON.stringify(result)}`);
    }
    log.debug("comment posted", { issueId, commentId: comment.id });
    return comment.id;
  }

  async reassign(issueId: string, userId: string): Promise<void> {
    await this.client.updateIssue(issueId, { assigneeId: userId });
    log.debug("reassigned", { issueId, userId });
  }

  async unassign(issueId: string): Promise<void> {
    await this.client.updateIssue(issueId, { assigneeId: null });
    log.debug("unassigned", { issueId });
  }

  async moveToInProgress(issueId: string): Promise<void> {
    await this.client.updateIssue(issueId, { stateId: this.inProgressStateId });
    log.debug("moved to in progress", { issueId });
  }

  async updateDescription(issueId: string, description: string): Promise<void> {
    await this.client.updateIssue(issueId, { description });
    log.debug("description updated", { issueId, length: description.length });
  }

  /**
   * Move an issue to the team's first workflow state matching `type`.
   * States are scoped to a team; many teams have a single state per type
   * (one Backlog, one Todo) but the SDK doesn't enforce that. We pick
   * the first match and cache the lookup per team. Throws if the team
   * has no state of that type.
   */
  async setStateByType(
    issueId: string,
    teamId: string,
    type: WorkflowStateType,
  ): Promise<{ stateName: string }> {
    const states = await this.fetchTeamStates(teamId);
    const match = states.find((s) => s.type === type);
    if (!match) {
      const known = states.map((s) => `${s.name} (${s.type})`).join(", ");
      throw new Error(
        `team ${teamId} has no workflow state of type "${type}"; known states: ${known || "(none)"}`,
      );
    }
    await this.client.updateIssue(issueId, { stateId: match.id });
    log.debug("state set", { issueId, type, stateName: match.name });
    return { stateName: match.name };
  }

  private async fetchTeamStates(
    teamId: string,
  ): Promise<readonly { id: string; name: string; type: string }[]> {
    const cached = this.teamStatesCache.get(teamId);
    if (cached && Date.now() - cached.fetchedAt < TEAM_STATES_TTL_MS) {
      return cached.states;
    }
    const data = await withRetry(`fetchTeamStates(${teamId})`, () =>
      this.client.client.request<
        { team: { states: { nodes: { id: string; name: string; type: string }[] } } | null },
        { teamId: string }
      >(
        `query TeamStates($teamId: String!) {
          team(id: $teamId) {
            states {
              nodes { id name type }
            }
          }
        }`,
        { teamId },
      ),
    );
    const nodes = data.team?.states?.nodes ?? [];
    this.teamStatesCache.set(teamId, { states: nodes, fetchedAt: Date.now() });
    return nodes;
  }

  async addPrAttachment(
    issueId: string,
    url: string,
    title: string,
  ): Promise<void> {
    await this.client.attachmentLinkURL(issueId, url, { title });
    log.debug("attachment added", { issueId, url });
  }
}

function parseIdentifierTeamKey(identifier: string): string {
  const m = identifier.match(/^([A-Z]+)-\d+$/);
  if (!m || !m[1]) throw new Error(`bad identifier: ${identifier}`);
  return m[1];
}

function parseIdentifierNumber(identifier: string): number {
  const m = identifier.match(/^[A-Z]+-(\d+)$/);
  if (!m || !m[1]) throw new Error(`bad identifier: ${identifier}`);
  return Number(m[1]);
}
