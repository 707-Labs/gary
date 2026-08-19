import { DockerExecutor } from "./docker.ts";
import type { Executor } from "./index.ts";
import { LocalExecutor } from "./local.ts";

export interface WorkspaceExecutorOptions {
  readOnly?: boolean;
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
  if (executorMode() === "local") return new LocalExecutor(workspaceRoot);
  const network = process.env.GARY_EXECUTOR_NETWORK?.trim() || "none";
  if (network !== "none" && network !== "bridge") {
    throw new Error(`GARY_EXECUTOR_NETWORK must be none or bridge, got ${network}`);
  }
  return new DockerExecutor(workspaceRoot, {
    image: process.env.GARY_EXECUTOR_IMAGE?.trim() || "gary-executor:ubuntu24.04",
    readOnly: opts.readOnly ?? false,
    networkMode: network,
    cpus: process.env.GARY_EXECUTOR_CPUS?.trim() || "4",
    memory: process.env.GARY_EXECUTOR_MEMORY?.trim() || "12g",
    pidsLimit: parsePositiveInt("GARY_EXECUTOR_PIDS_LIMIT", 512),
    bunCacheVolume: process.env.GARY_BUN_CACHE_VOLUME?.trim() || "gary-bun-cache",
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
