/**
 * Immutable-image stdio worker. Pure specification: no Docker call on import.
 * The trusted operator supplies the reviewed local image ID; no tag resolution,
 * source bind, credential mount, socket mount or host environment inheritance.
 * Inspect supplied images for absence of VOLUME/healthcheck declarations first.
 *
 * One foreground container per task. Await cleanupCommand on every completion,
 * failure, abort and timeout: killing the attached Docker CLI alone is not enough.
 * --rm covers ordinary exits. A killed host requires recovery by the exact name.
 */
import { randomUUID } from "node:crypto";

export const CONTAINER_RUNTIME_DIRECTORY = "/opt/gary-hermes-runtime";
const dockerExecutables = new Set(["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/usr/bin/docker"]);
export interface ContainerSpecOptions {
  /** Full reviewed immutable local ID, never a tag or registry reference. */
  imageDigest: string;
  dockerExecutable?: string;
  /** Explicit local daemon socket; affects the host CLI only, never mounted. */
  dockerHost?: string;
}
export interface ContainerSpec {
  readonly containerName: string;
  readonly command: readonly string[];
  readonly cleanupCommand: readonly string[];
  readonly cwd: string;
  /** Pass exactly to launch AND cleanup; never merge process.env. */
  readonly env: Readonly<Record<string, string>>;
}
export function createContainerSpec(options: ContainerSpecOptions): ContainerSpec {
  if (!options || typeof options !== "object" || Array.isArray(options)
      || Reflect.ownKeys(options).some(key => typeof key !== "string"
        || !["imageDigest", "dockerExecutable", "dockerHost"].includes(key))) {
    throw new Error("unsupported container option");
  }
  if (typeof options.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(options.imageDigest)) {
    throw new Error("full immutable local image digest required");
  }
  const docker = options.dockerExecutable === undefined ? "/usr/local/bin/docker" : options.dockerExecutable;
  if (!dockerExecutables.has(docker)) throw new Error("unreviewed Docker executable");
  const dockerHost = options.dockerHost === undefined ? "unix:///var/run/docker.sock" : options.dockerHost;
  if (typeof dockerHost !== "string" || !/^unix:\/\/(\/[A-Za-z0-9_.-]+)+\.sock$/.test(dockerHost)
      || dockerHost.slice(7).split("/").some(part => part === "." || part === "..")) {
    throw new Error("canonical local Docker Unix socket required");
  }
  const containerName = `gary-hermes-worker-${randomUUID()}`;
  const command = Object.freeze([
    docker, "container", "run", "--rm", "--interactive", "--init",
    "--name", containerName, "--pull", "never", "--restart", "no",
    "--network", "none", "--read-only", "--user", "65532:65532",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true",
    "--pids-limit", "128", "--memory", "4g", "--memory-swap", "4g", "--cpus", "2",
    "--ulimit", "nofile=256:256", "--stop-timeout", "5", "--no-healthcheck", "--log-driver", "none",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777",
    "--workdir", CONTAINER_RUNTIME_DIRECTORY, "--entrypoint", "/usr/bin/env", options.imageDigest,
    "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp",
    "python", "-I", "-B", "python/gary_runtime.py", "--stdio",
  ]);
  return Object.freeze({
    containerName, command,
    cleanupCommand: Object.freeze([docker, "container", "rm", "--force", containerName]),
    cwd: "/",
    env: Object.freeze({
      PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
      DOCKER_CONFIG: "/var/empty/gary-hermes-no-docker-config",
      DOCKER_HOST: dockerHost,
    }),
  });
}
