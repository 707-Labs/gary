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

export class LinearAdapter {
  private readonly client: LinearClient;
  private readonly userId: string;
  private readonly inProgressStateId: string;

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
    const result = await this.client.issues({
      filter: {
        assignee: { id: { eq: this.userId } },
        state: { type: { nin: ["completed", "canceled"] } },
      },
      first: 50,
    });

    const out: AssignedIssue[] = [];
    for (const issue of result.nodes) {
      const [state, team, creator] = await Promise.all([
        issue.state,
        issue.team,
        issue.creator,
      ]);
      out.push({
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
      });
    }
    return out;
  }

  /**
   * Look up an issue by its identifier (e.g. "ERT-1500"). Returns null if no
   * issue matches. Same shape as fetchAssignedIssues entries.
   */
  async fetchByIdentifier(identifier: string): Promise<AssignedIssue | null> {
    const result = await this.client.issues({
      filter: { number: { eq: parseIdentifierNumber(identifier) }, team: { key: { eq: parseIdentifierTeamKey(identifier) } } },
      first: 1,
    });
    const issue = result.nodes[0];
    if (!issue) return null;
    const [state, team, creator] = await Promise.all([
      issue.state,
      issue.team,
      issue.creator,
    ]);
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
    const issue = await this.client.issue(issueId);
    const result = await issue.comments({ first: limit });
    const out: IssueComment[] = [];
    for (const c of result.nodes) {
      const user = await c.user;
      out.push({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        userId: user?.id ?? null,
        userName: user?.name ?? null,
      });
    }
    return out;
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
