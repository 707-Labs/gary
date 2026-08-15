// Smoke test for Linear issue relations. Read-only — prints the raw
// relations + inverseRelations for every issue assigned to Gary, plus the
// blocker view the loop derives. Run with: bun run scripts/probe-relations.ts

import { LinearClient } from "@linear/sdk";
import { LinearAdapter } from "../src/adapters/linear.ts";
import { loadGaryConfig, loadLinearConfig } from "../src/config.ts";

const gary = loadGaryConfig();
const linear = loadLinearConfig();
const client = new LinearClient({ apiKey: linear.apiKey });

const query = `
  query AssignedIssueRelations($userId: ID!) {
    issues(filter: { assignee: { id: { eq: $userId } } }, first: 50) {
      nodes {
        identifier
        title
        state { type }
        relations(first: 20) {
          nodes {
            type
            relatedIssue { identifier state { name type } }
          }
        }
        inverseRelations(first: 20) {
          nodes {
            type
            issue { identifier state { name type } }
          }
        }
      }
    }
  }
`;

const data = await client.client.request<
  {
    issues: {
      nodes: {
        identifier: string;
        title: string;
        state: { type: string } | null;
        relations: {
          nodes: {
            type: string;
            relatedIssue: {
              identifier: string;
              state: { name: string; type: string } | null;
            } | null;
          }[];
        };
        inverseRelations: {
          nodes: {
            type: string;
            issue: {
              identifier: string;
              state: { name: string; type: string } | null;
            } | null;
          }[];
        };
      }[];
    };
  },
  { userId: string }
>(query, { userId: gary.linearUserId });

for (const issue of data.issues.nodes) {
  console.log(`${issue.identifier}  [${issue.state?.type}]  ${issue.title}`);
  for (const r of issue.relations.nodes) {
    console.log(
      `  relations:        ${r.type} -> ${r.relatedIssue?.identifier} [${r.relatedIssue?.state?.name} / ${r.relatedIssue?.state?.type}]`,
    );
  }
  for (const r of issue.inverseRelations.nodes) {
    console.log(
      `  inverseRelations: ${r.type} <- ${r.issue?.identifier} [${r.issue?.state?.name} / ${r.issue?.state?.type}]`,
    );
  }
}

console.log(`\nblockers as the adapter derives them:`);
const adapter = new LinearAdapter({ gary, linear });
const issues = await adapter.fetchAssignedIssues();
for (const issue of issues) {
  const open = issue.blockedBy.filter((b) => b.isOpen);
  console.log(
    `  ${issue.identifier}: ${
      issue.blockedBy.length === 0
        ? "(no blockers)"
        : issue.blockedBy
            .map((b) => `${b.identifier}[${b.stateType}${b.isOpen ? ", OPEN" : ""}]`)
            .join(", ")
    }${open.length > 0 ? "  << would gate start_coding" : ""}`,
  );
}

const first = issues[0];
if (first) {
  const byId = await adapter.fetchByIdentifier(first.identifier);
  console.log(
    `\nfetchByIdentifier(${first.identifier}): ${
      byId ? `ok, ${byId.blockedBy.length} blocker(s)` : "NOT FOUND"
    }`,
  );
}
