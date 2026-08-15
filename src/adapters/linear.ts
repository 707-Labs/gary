import { LinearClient } from "@linear/sdk";
import type { Config } from "../config.ts";
import { log } from "../logger.ts";

export interface BlockerRef {
  id: string;
  identifier: string;
  stateName: string;
  stateType: string;
  /**
   * True unless the blocker is completed/canceled. A relation we can't
   * interpret (missing issue or state — e.g. Gary lacks access) counts as
   * OPEN: the safe failure here is "wait and say why", not "start coding
   * against a base that isn't there yet".
   */
  isOpen: boolean;
}

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
  /** Issues that block this one ("blocks" inverse relations). */
  blockedBy: BlockerRef[];
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
 * Shared GraphQL selection for the three issue fetchers, so a field added to
 * one (like `inverseRelations`) can't silently be missing from the others.
 * `inverseRelations` is where "X blocks Y" lands on Y's side — `issue` on the
 * relation node is the blocker.
 */
const ISSUE_NODE_SELECTION = `
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
  inverseRelations(first: 20) {
    nodes {
      type
      issue { id identifier state { name type } }
    }
  }
`;

interface RawRelationNode {
  type: string;
  issue: {
    id: string;
    identifier: string;
    state: { name: string; type: string } | null;
  } | null;
}

interface RawIssueNode {
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
  inverseRelations: { nodes: RawRelationNode[] } | null;
  assignee?: { id: string } | null;
}

/**
 * Derive the blocked-by list from an issue's inverse relations. Only "blocks"
 * relations count; duplicates/related are ignored. Relations whose issue or
 * state we can't read are kept as open blockers (fail closed) — the ERT-2354
 * incident came from treating uninterpretable relations as "not blocked".
 */
export function mapBlockedBy(
  nodes: readonly RawRelationNode[],
): BlockerRef[] {
  return nodes
    .filter((r) => r.type === "blocks")
    .map((r) => {
      const stateType = r.issue?.state?.type ?? "unknown";
      return {
        id: r.issue?.id ?? "",
        identifier: r.issue?.identifier ?? "(inaccessible)",
        stateName: r.issue?.state?.name ?? "unknown",
        stateType,
        isOpen: stateType !== "completed" && stateType !== "canceled",
      };
    });
}

function mapIssueNode(n: RawIssueNode): AssignedIssue {
  return {
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
    blockedBy: mapBlockedBy(n.inverseRelations?.nodes ?? []),
  };
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
    const v = await this.client.viewer;
    return {
      id: v.id,
      name: v.name,
      displayName: v.displayName,
      email: v.email,
    };
  }

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
          nodes { ${ISSUE_NODE_SELECTION} }
        }
      }
    `;
    const data = await this.client.client.request<
      { issues: { nodes: RawIssueNode[] } },
      { userId: string; first: number }
    >(query, { userId: this.userId, first: 50 });

    return data.issues.nodes
      .filter(
        (n) =>
          n.state?.type !== "completed" && n.state?.type !== "canceled",
      )
      .map(mapIssueNode);
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
            ${ISSUE_NODE_SELECTION}
            assignee { id }
          }
        }
      }
    `;
    const data = await this.client.client.request<
      { issues: { nodes: RawIssueNode[] } },
      { userId: string; first: number }
    >(query, { userId: this.userId, first: 50 });

    return data.issues.nodes
      .filter((n) => n.assignee?.id !== this.userId)
      .filter(
        (n) =>
          n.state?.type !== "completed" && n.state?.type !== "canceled",
      )
      .map(mapIssueNode);
  }

  /**
   * Look up an issue by its identifier (e.g. "ERT-1500"). Returns null if no
   * issue matches. Same shape as fetchAssignedIssues entries.
   */
  async fetchByIdentifier(identifier: string): Promise<AssignedIssue | null> {
    // Raw query like the other fetchers (the SDK path cost 4 roundtrips via
    // lazy resolvers and couldn't share ISSUE_NODE_SELECTION).
    const query = `
      query IssueByIdentifier($filter: IssueFilter!) {
        issues(filter: $filter, first: 1) {
          nodes { ${ISSUE_NODE_SELECTION} }
        }
      }
    `;
    const data = await this.client.client.request<
      { issues: { nodes: RawIssueNode[] } },
      { filter: unknown }
    >(query, {
      filter: {
        number: { eq: parseIdentifierNumber(identifier) },
        team: { key: { eq: parseIdentifierTeamKey(identifier) } },
      },
    });
    const node = data.issues.nodes[0];
    return node ? mapIssueNode(node) : null;
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
    const data = await this.client.client.request<
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
    >(query, { id: issueId, first: limit });
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
    const data = await this.client.client.request<
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
    >(query, { id: issueId, first: limit });
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
    const data = await this.client.client.request<
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
