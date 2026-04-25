// Smoke test for the classifier. Read-only — does not post to Linear.
// Feeds three fixture tickets and prints classification + voice comment.

import { GLMClient } from "../src/adapters/glm.ts";
import type { AssignedIssue } from "../src/adapters/linear.ts";
import {
  classifyTicket,
  generateClassificationComment,
} from "../src/handlers/classifier.ts";
import { loadGLMChain } from "../src/config.ts";

const fixtures: AssignedIssue[] = [
  {
    id: "fixture-1",
    identifier: "ERT-100",
    title: "Add a /api/health endpoint to ertai",
    description:
      "Returns `{ ok: true, version: <package.json version> }`. Standard liveness probe. No auth required.",
    url: "https://example.linear.app/ERT-100",
    stateName: "Triage",
    stateType: "triage",
    createdAt: "2026-04-24T00:00:00Z",
    updatedAt: "2026-04-24T00:00:00Z",
    creatorId: "u-tanner",
    creatorName: "Tanner",
    teamId: "t-ert",
    teamKey: "ERT",
  },
  {
    id: "fixture-2",
    identifier: "ERT-101",
    title: "Why does the deck import endpoint return 422 for malformed CSV?",
    description:
      "Customer asked. Should we be lenient and report row-level errors instead?",
    url: "https://example.linear.app/ERT-101",
    stateName: "Triage",
    stateType: "triage",
    createdAt: "2026-04-24T00:00:00Z",
    updatedAt: "2026-04-24T00:00:00Z",
    creatorId: "u-ben",
    creatorName: "Ben",
    teamId: "t-ert",
    teamKey: "ERT",
  },
  {
    id: "fixture-3",
    identifier: "ERT-102",
    title: "Migrate billing to a new vendor",
    description:
      "We're moving off Stripe. New vendor TBD. Please own this end-to-end including data migration of historical invoices and pricing tier remap.",
    url: "https://example.linear.app/ERT-102",
    stateName: "Triage",
    stateType: "triage",
    createdAt: "2026-04-24T00:00:00Z",
    updatedAt: "2026-04-24T00:00:00Z",
    creatorId: "u-tanner",
    creatorName: "Tanner",
    teamId: "t-ert",
    teamKey: "ERT",
  },
];

const glm = new GLMClient(loadGLMChain());

for (const issue of fixtures) {
  console.log(`\n=== ${issue.identifier}: ${issue.title} ===`);
  const cls = await classifyTicket({ glm }, { issue, comments: [] });
  console.log(JSON.stringify(cls, null, 2));
  const comment = await generateClassificationComment(
    { glm },
    { issue, classification: cls },
  );
  console.log(`\ncomment:\n${comment}`);
}

console.log(`\nprobe ok.`);
