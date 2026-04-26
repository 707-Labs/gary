// Smoke test for the GitHub adapter. Read-only — does not push, comment, or
// open PRs. Verifies the App auth works and that we can list check runs and
// pull requests on the configured repo.
//
// Run with: bun run scripts/probe-github.ts

import { makeGitHubClient } from "../src/adapters/github.ts";
import { loadGaryConfig, loadGitHubConfig } from "../src/config.ts";

const gary = loadGaryConfig();
const github = loadGitHubConfig();

if (gary.repoMap.size === 0) {
  console.error("No GARY_REPO_MAP configured");
  process.exit(1);
}

const target = [...gary.repoMap.values()][0]!;
const [owner, repo] = target.split("/") as [string, string];

console.log(`auth kind: ${github.kind}`);

const client = makeGitHubClient(github);

const viewer = await client.getViewer();
console.log(`viewer: ${viewer.login} (${viewer.type})`);

console.log(`\nlisting recent PRs in ${owner}/${repo}...`);
const cloneUrl = await client.cloneUrl(owner, repo);
const masked = cloneUrl.replace(/:[^@]+@/, ":<token>@");
console.log(`  clone url (token masked): ${masked}`);

const garyLogin = viewer.login;
const ownPrs = await client.listOwnPullRequests(owner, repo, garyLogin);
console.log(`  PRs by ${garyLogin}: ${ownPrs.length}`);
for (const pr of ownPrs.slice(0, 5)) {
  console.log(
    `    #${pr.number}  ${pr.state}${pr.merged ? " (merged)" : ""}  ${pr.url}`,
  );
}

console.log(`\nprobe ok.`);
