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
