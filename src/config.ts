import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

const expandHome = (p: string): string =>
  p.startsWith("~") ? resolve(homedir(), p.slice(2)) : resolve(p);

const stringFromEnv = (key: string, fallback?: string): string => {
  const v = process.env[key];
  if (v && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${key}`);
};

const optionalString = (key: string): string | undefined => {
  const v = process.env[key];
  return v && v.length > 0 ? v : undefined;
};

const intFromEnv = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Env var ${key} must be an integer, got ${raw}`);
  }
  return n;
};

const reposSchema = z
  .string()
  .transform((s) => s.split(",").map((r) => r.trim()).filter(Boolean))
  .pipe(z.array(z.string().regex(/^[^/]+\/[^/]+$/, "must be owner/repo")));

export interface GaryConfig {
  name: string;
  linearUserId: string;
  home: string;
  stateDir: string;
  reposDir: string;
  workspacesDir: string;
  dbPath: string;
  allowedRepos: readonly string[];
}

export interface LinearConfig {
  apiKey: string;
  teamId: string;
  inProgressStateId: string;
}

export type GitHubConfig =
  | {
      kind: "app";
      appId: string;
      privateKey: string;
      installationId: string;
      username: string;
    }
  | {
      kind: "pat";
      token: string;
      username: string;
    };

export interface GLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface RuntimeConfig {
  pollIntervalMs: number;
  maxAttemptsPerTicket: number;
  circuitBreakerWindowHours: number;
  maxCiAttempts: number;
  agentLoopMaxIterations: number;
  agentLoopTimeoutMs: number;
}

export interface Config {
  gary: GaryConfig;
  linear: LinearConfig;
  github: GitHubConfig;
  glm: GLMConfig;
  runtime: RuntimeConfig;
}

export function loadGaryConfig(): GaryConfig {
  const home = expandHome(stringFromEnv("GARY_HOME", "~/.gary"));
  const stateDir = expandHome(stringFromEnv("GARY_STATE_DIR", "~/.gary/state"));
  const reposDir = expandHome(stringFromEnv("GARY_REPOS_DIR", "~/.gary/repos"));
  const workspacesDir = expandHome(
    stringFromEnv("GARY_WORKSPACES_DIR", "~/.gary/workspaces"),
  );
  const dbPath = resolve(stateDir, "gary.db");

  const allowedRepos = reposSchema.parse(
    stringFromEnv("GARY_ALLOWED_REPOS", "707-Labs/ertai"),
  );

  return {
    name: stringFromEnv("GARY_NAME", "Gary"),
    linearUserId: stringFromEnv("GARY_LINEAR_USER_ID"),
    home,
    stateDir,
    reposDir,
    workspacesDir,
    dbPath,
    allowedRepos,
  };
}

export function loadLinearConfig(): LinearConfig {
  return {
    apiKey: stringFromEnv("LINEAR_API_KEY"),
    teamId: stringFromEnv("LINEAR_TEAM_ID"),
    inProgressStateId: stringFromEnv("LINEAR_IN_PROGRESS_STATE_ID"),
  };
}

export function loadGitHubConfig(): GitHubConfig {
  const appId = optionalString("GITHUB_APP_ID");
  if (appId) {
    return {
      kind: "app",
      appId,
      privateKey: loadAppPrivateKey(),
      installationId: stringFromEnv("GITHUB_APP_INSTALLATION_ID"),
      username: stringFromEnv("GITHUB_APP_USERNAME", "gary-707-labs[bot]"),
    };
  }
  return {
    kind: "pat",
    token: stringFromEnv("GITHUB_PAT"),
    username: stringFromEnv("GITHUB_USERNAME", "gary"),
  };
}

function loadAppPrivateKey(): string {
  const path = optionalString("GITHUB_APP_PRIVATE_KEY_PATH");
  if (path) {
    return readFileSync(expandHome(path), "utf8");
  }
  const inline = stringFromEnv("GITHUB_APP_PRIVATE_KEY");
  // Allow the env var to contain literal "\n" sequences (common when shoving
  // a multi-line key into a single line) by normalizing them to real newlines.
  return inline.includes("\\n") ? inline.replace(/\\n/g, "\n") : inline;
}

export function loadGLMConfig(): GLMConfig {
  return {
    apiKey: stringFromEnv("Z_AI_API_KEY"),
    baseUrl: stringFromEnv("Z_AI_BASE_URL", "https://api.z.ai/api/anthropic"),
    model: stringFromEnv("Z_AI_MODEL", "glm-4.6"),
  };
}

export function loadRuntimeConfig(): RuntimeConfig {
  return {
    pollIntervalMs: intFromEnv("POLL_INTERVAL_MS", 60_000),
    maxAttemptsPerTicket: intFromEnv("MAX_ATTEMPTS_PER_TICKET", 5),
    circuitBreakerWindowHours: intFromEnv("CIRCUIT_BREAKER_WINDOW_HOURS", 6),
    maxCiAttempts: intFromEnv("MAX_CI_ATTEMPTS", 3),
    agentLoopMaxIterations: intFromEnv("AGENT_LOOP_MAX_ITERATIONS", 50),
    agentLoopTimeoutMs: intFromEnv("AGENT_LOOP_TIMEOUT_MS", 900_000),
  };
}

export function loadConfig(): Config {
  return {
    gary: loadGaryConfig(),
    linear: loadLinearConfig(),
    github: loadGitHubConfig(),
    glm: loadGLMConfig(),
    runtime: loadRuntimeConfig(),
  };
}
