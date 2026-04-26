// Diagnostic: fetch an installation token via the App auth flow, then hit the
// REST API with curl-style raw fetch to isolate whether 403s are an Octokit
// config issue or a real permissions gap.

import { createAppAuth } from "@octokit/auth-app";
import { loadGaryConfig, loadGitHubConfig } from "../src/config.ts";

const gary = loadGaryConfig();
const cfg = loadGitHubConfig();
if (cfg.kind !== "app") {
  console.error("requires GITHUB_APP_*");
  process.exit(1);
}

const auth = createAppAuth({
  appId: cfg.appId,
  privateKey: cfg.privateKey,
  installationId: cfg.installationId,
});

const installation = (await auth({
  type: "installation",
  installationId: cfg.installationId,
})) as { token: string; permissions: Record<string, string>; repositorySelection: string };

console.log("installation token acquired");
console.log("permissions:", installation.permissions);
console.log("repositorySelection:", installation.repositorySelection);

if (gary.repoMap.size === 0) {
  console.error("No GARY_REPO_MAP configured");
  process.exit(1);
}
const target = [...gary.repoMap.values()][0]!;
const headers = {
  Authorization: `Bearer ${installation.token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

const tryEndpoint = async (label: string, path: string): Promise<void> => {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, { headers });
  const body = await res.text();
  const head = body.length > 220 ? body.slice(0, 220) + "..." : body;
  console.log(`\n${label}  GET ${path}`);
  console.log(`  status: ${res.status}`);
  console.log(`  body:   ${head}`);
};

await tryEndpoint("repo", `/repos/${target}`);
await tryEndpoint("pulls(open)", `/repos/${target}/pulls?state=open`);
await tryEndpoint("pulls(all)", `/repos/${target}/pulls?state=all`);
await tryEndpoint("installation/repositories", "/installation/repositories");
