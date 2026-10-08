import { DockerExecutor } from "./docker.ts";
import type { Executor } from "./index.ts";
import { LocalExecutor } from "./local.ts";

/** Trusted caller-selected parent profile; never populated from task/model JSON. */
export interface WorkspaceExecutorProfile {
  readonly image: string;
  readonly bunCacheVolume: string;
  readonly cpus: string;
  readonly memory: string;
  readonly pidsLimit: number;
  readonly fixedEnvironment: Readonly<Record<string, string>>;
  readonly storybookScratch?: true;
}

export interface WorkspaceExecutorOptions {
  readOnly?: boolean;
  profile?: WorkspaceExecutorProfile;
}

export function executorMode(): "local" | "docker" {
  const mode = process.env.GARY_EXECUTOR?.trim() || "local";
  if (mode !== "local" && mode !== "docker") {
    throw new Error(`GARY_EXECUTOR must be local or docker, got ${mode}`);
  }
  return mode;
}

export function createWorkspaceExecutor(
  workspaceRoot: string,
  opts: WorkspaceExecutorOptions = {},
): Executor {
  const mode = executorMode();
  if (opts.profile && (mode !== "docker" || opts.readOnly === true)) {
    throw new Error("fixed_executor_profile_requires_writable_offline_docker");
  }
  if (mode === "local") return new LocalExecutor(workspaceRoot);
  const network = process.env.GARY_EXECUTOR_NETWORK?.trim() || "none";
  if (network !== "none" && network !== "bridge") {
    throw new Error(`GARY_EXECUTOR_NETWORK must be none or bridge, got ${network}`);
  }
  if (opts.profile && (network !== "none" || !/^sha256:[a-f0-9]{64}$/.test(opts.profile.image)
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(opts.profile.bunCacheVolume))) {
    throw new Error("invalid_fixed_executor_profile");
  }
  return new DockerExecutor(workspaceRoot, {
    image: opts.profile?.image ?? (process.env.GARY_EXECUTOR_IMAGE?.trim() || "gary-executor:ubuntu24.04"),
    readOnly: opts.readOnly ?? false,
    networkMode: network,
    cpus: opts.profile ? opts.profile.cpus : (process.env.GARY_EXECUTOR_CPUS?.trim() || "4"),
    memory: opts.profile ? opts.profile.memory : (process.env.GARY_EXECUTOR_MEMORY?.trim() || "12g"),
    pidsLimit: opts.profile ? opts.profile.pidsLimit : parsePositiveInt("GARY_EXECUTOR_PIDS_LIMIT", 512),
    bunCacheVolume: opts.profile?.bunCacheVolume ?? (process.env.GARY_BUN_CACHE_VOLUME?.trim() || "gary-bun-cache"),
    ...(opts.profile ? { fixedEnvironment: opts.profile.fixedEnvironment } : {}),
    ...(opts.profile?.storybookScratch !== undefined ? { storybookScratch: opts.profile.storybookScratch } : {}),
  });
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return parsed;
}
