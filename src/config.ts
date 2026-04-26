import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  createProvider,
  createProviderChain,
  type ProviderChain,
  type ProviderConfig,
  type ProviderName,
} from "./providers.ts";

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

const REPO_SHAPE = /^[^/]+\/[^/]+$/;

export function parseRepoMap(raw: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const trimmed = raw.trim();
  if (trimmed.length === 0) return map;
  for (const entry of trimmed.split(",")) {
    const cleaned = entry.trim();
    if (cleaned.length === 0) continue;
    const colonAt = cleaned.indexOf(":");
    if (colonAt < 0) {
      throw new Error(
        `GARY_REPO_MAP entry "${cleaned}" expected "<TEAM_KEY>:<owner>/<repo>"`,
      );
    }
    const teamKey = cleaned.slice(0, colonAt).trim();
    const repo = cleaned.slice(colonAt + 1).trim();
    if (teamKey.length === 0) {
      throw new Error(`GARY_REPO_MAP entry "${cleaned}" has empty team key`);
    }
    if (repo.length === 0) {
      throw new Error(`GARY_REPO_MAP entry "${cleaned}" has empty repo`);
    }
    if (!REPO_SHAPE.test(repo)) {
      throw new Error(
        `GARY_REPO_MAP entry "${cleaned}" repo must be owner/repo, got "${repo}"`,
      );
    }
    if (map.has(teamKey)) {
      throw new Error(`GARY_REPO_MAP duplicate team key "${teamKey}"`);
    }
    map.set(teamKey, repo);
  }
  return map;
}

export interface GaryConfig {
  name: string;
  linearUserId: string;
  home: string;
  stateDir: string;
  reposDir: string;
  workspacesDir: string;
  dbPath: string;
  /** Linear team key → "owner/repo". Empty map disables the coding pipeline. */
  repoMap: ReadonlyMap<string, string>;
  /**
   * Linear user ids permitted to summon Gary via @mention on tickets he's
   * not assigned to. Empty list disables the @mention pipeline entirely.
   */
  allowlistedMentionUserIds: readonly string[];
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

/**
 * Single-provider config. The legacy `loadGLMConfig` returns this for
 * Z.ai compatibility with the older probe scripts; the chain-aware
 * `loadProviderConfigs` returns an array.
 */
export interface GLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface CloudflareConfig {
  apiToken: string;
  accountId: string;
  /** Worker names Gary is allowed to query observability for. */
  observabilityWorkers: readonly string[];
  /**
   * Alias → D1 database UUID. Aliases keep the agent's tool calls readable
   * (e.g. d1_query({ database: "mulligan-labs", sql: ... })).
   */
  d1Databases: Readonly<Record<string, string>>;
}

export interface RuntimeConfig {
  pollIntervalMs: number;
  maxAttemptsPerTicket: number;
  circuitBreakerWindowHours: number;
  maxCiAttempts: number;
  agentLoopMaxIterations: number;
  agentLoopTimeoutMs: number;
  /** How long an idle, CI-green PR can sit before nudge_reviewer fires. */
  stalePrAfterMs: number;
}

export interface Config {
  gary: GaryConfig;
  linear: LinearConfig;
  github: GitHubConfig;
  /** Ordered LLM provider chain — primary first. */
  providers: readonly ProviderConfig[];
  cloudflare: CloudflareConfig | null;
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

  const repoMap = parseRepoMap(
    stringFromEnv("GARY_REPO_MAP", "ERT:707-Labs/ertai"),
  );

  const allowlistRaw = optionalString("GARY_ALLOWLISTED_MENTION_USER_IDS");
  const allowlistedMentionUserIds = allowlistRaw
    ? allowlistRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  return {
    name: stringFromEnv("GARY_NAME", "Gary"),
    linearUserId: stringFromEnv("GARY_LINEAR_USER_ID"),
    home,
    stateDir,
    reposDir,
    workspacesDir,
    dbPath,
    repoMap,
    allowlistedMentionUserIds,
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

const DEFAULT_BACKOFF_MS = 60_000;

const PROVIDER_DEFAULTS: Record<
  ProviderName,
  { baseUrl: string; model: string; apiKeyEnv: string; defaultBackoffMs: number }
> = {
  "z.ai": {
    apiKeyEnv: "Z_AI_API_KEY",
    baseUrl: "https://api.z.ai/api/anthropic",
    model: "glm-4.6",
    defaultBackoffMs: DEFAULT_BACKOFF_MS,
  },
  kimi: {
    apiKeyEnv: "KIMI_API_KEY",
    baseUrl: "https://api.kimi.com/coding",
    model: "kimi-for-coding",
    defaultBackoffMs: DEFAULT_BACKOFF_MS,
  },
  deepseek: {
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/anthropic",
    model: "deepseek-v4-pro",
    defaultBackoffMs: DEFAULT_BACKOFF_MS,
  },
};

const PROVIDER_ENV_PREFIX: Record<ProviderName, string> = {
  "z.ai": "Z_AI",
  kimi: "KIMI",
  deepseek: "DEEPSEEK",
};

function loadProviderConfig(name: ProviderName): ProviderConfig | null {
  const defaults = PROVIDER_DEFAULTS[name];
  const apiKey = optionalString(defaults.apiKeyEnv);
  if (!apiKey) return null;
  const prefix = PROVIDER_ENV_PREFIX[name];
  return {
    name,
    apiKey,
    baseUrl: stringFromEnv(`${prefix}_BASE_URL`, defaults.baseUrl),
    model: stringFromEnv(`${prefix}_MODEL`, defaults.model),
    defaultBackoffMs: intFromEnv(
      `${prefix}_DEFAULT_BACKOFF_MS`,
      defaults.defaultBackoffMs,
    ),
  };
}

/**
 * Load every configured provider, in priority order (Z.ai → Kimi → DeepSeek).
 * Z.ai is required; Kimi and DeepSeek are optional (omit their key to
 * disable). The returned array is non-empty.
 */
export function loadProviderConfigs(): readonly ProviderConfig[] {
  // Z.ai stays required so existing deployments keep working without
  // env changes. Kimi/DeepSeek are opt-in fallbacks.
  const zai = loadProviderConfig("z.ai");
  if (!zai) {
    throw new Error("Missing required env var: Z_AI_API_KEY");
  }
  const out: ProviderConfig[] = [zai];
  const kimi = loadProviderConfig("kimi");
  if (kimi) out.push(kimi);
  const deepseek = loadProviderConfig("deepseek");
  if (deepseek) out.push(deepseek);
  return out;
}

/** Convenience: build the production provider chain in one shot. */
export function loadGLMChain(): ProviderChain {
  return createProviderChain(loadProviderConfigs().map((p) => createProvider(p)));
}

const DEFAULT_OBSERVABILITY_WORKERS = [
  "mulligan-labs",
  "mulligan-labs-party",
  "mulligan-labs-feedback",
  "mulligan-labs-discord-bot",
];

const DEFAULT_D1_DATABASES: Readonly<Record<string, string>> = {
  // ID copied from ertai/wrangler.json; same UUID is used by all envs.
  "mulligan-labs": "d0d963f1-53dd-4f57-b24d-b3fb3da56753",
};

/**
 * Cloudflare config is optional — Gary runs without it, just without log
 * access. Returns null if the API token isn't set.
 */
export function loadCloudflareConfig(): CloudflareConfig | null {
  const apiToken = optionalString("CLOUDFLARE_API_TOKEN");
  if (!apiToken) return null;
  const accountId = stringFromEnv("CLOUDFLARE_ACCOUNT_ID");
  const workersRaw = optionalString("CLOUDFLARE_OBSERVABILITY_WORKERS");
  const observabilityWorkers = workersRaw
    ? workersRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_OBSERVABILITY_WORKERS;
  const d1Raw = optionalString("CLOUDFLARE_D1_DATABASES");
  const d1Databases = d1Raw ? parseAliasMap(d1Raw) : DEFAULT_D1_DATABASES;
  return { apiToken, accountId, observabilityWorkers, d1Databases };
}

function parseAliasMap(raw: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [alias, id] = pair.split("=").map((s) => s.trim());
    if (!alias || !id) {
      throw new Error(`bad alias=id pair in CLOUDFLARE_D1_DATABASES: ${pair}`);
    }
    out[alias] = id;
  }
  return out;
}

export function loadRuntimeConfig(): RuntimeConfig {
  return {
    pollIntervalMs: intFromEnv("POLL_INTERVAL_MS", 60_000),
    maxAttemptsPerTicket: intFromEnv("MAX_ATTEMPTS_PER_TICKET", 5),
    circuitBreakerWindowHours: intFromEnv("CIRCUIT_BREAKER_WINDOW_HOURS", 6),
    maxCiAttempts: intFromEnv("MAX_CI_ATTEMPTS", 3),
    agentLoopMaxIterations: intFromEnv("AGENT_LOOP_MAX_ITERATIONS", 50),
    agentLoopTimeoutMs: intFromEnv("AGENT_LOOP_TIMEOUT_MS", 900_000),
    stalePrAfterMs: intFromEnv("STALE_PR_HOURS", 72) * 60 * 60 * 1000,
  };
}

export function loadConfig(): Config {
  return {
    gary: loadGaryConfig(),
    linear: loadLinearConfig(),
    github: loadGitHubConfig(),
    providers: loadProviderConfigs(),
    cloudflare: loadCloudflareConfig(),
    runtime: loadRuntimeConfig(),
  };
}
