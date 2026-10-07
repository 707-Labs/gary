/** Concrete immutable Docker worker launcher. Construction is inert. */
import { execFile } from "node:child_process";
import { createContainerSpec, CONTAINER_RUNTIME_DIRECTORY, type ContainerSpecOptions } from "./container-spec.ts";
import type { StdioLaunchOptions } from "./stdio-launcher.ts";
import type { GaryRuntimeLauncher } from "./gary-loop-adapter.ts";

export type DockerCommandRunner = (command: readonly string[], env: Readonly<Record<string, string>>,
  timeoutMs: number, signal?: AbortSignal) => Promise<{ exitCode: number; stdout: string }>;
/** Test seams are trusted host dependencies, never supplied by the model. */
export interface DockerLauncherDependencies {
  run?: DockerCommandRunner;
  stdio?: (options: StdioLaunchOptions) => GaryRuntimeLauncher;
}
const runDocker: DockerCommandRunner = async (command, env, timeoutMs, signal) => new Promise((resolve, reject) => {
  execFile(command[0]!, command.slice(1), {
    cwd: "/", env: { ...env }, timeout: timeoutMs, maxBuffer: 1_048_576,
    encoding: "utf8", killSignal: "SIGKILL", ...(signal ? { signal } : {}),
  }, (error, stdout) => {
    if (error && (typeof error.code !== "number" || error.killed)) reject(new Error("worker_docker_command_failed"));
    else resolve({ exitCode: error?.code as number ?? 0, stdout });
  });
});
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function verifyImage(raw: string, expected: string): void {
  try {
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length !== 1 || !object(entries[0])) throw 0;
    const image = entries[0], config = image.Config;
    if (image.Id !== expected || image.Os !== "linux" || image.Architecture !== "arm64" || !object(config)
        || config.User !== "65532:65532" || config.WorkingDir !== CONTAINER_RUNTIME_DIRECTORY
        || (config.Volumes !== undefined && config.Volumes !== null
          && (!object(config.Volumes) || Object.keys(config.Volumes).length !== 0))
        || config.Healthcheck !== undefined && config.Healthcheck !== null) throw 0;
  } catch { throw new Error("worker_image_preflight_failed"); }
}

/** The supplied immutable image ID is the external review boundary. This checks
 * its local metadata; it cannot establish that arbitrary baked image code is safe.
 * Every invocation gets a fresh exact name and independent awaited cleanup.
 */
export function createDockerRuntimeLauncher(options: ContainerSpecOptions, dependencies: DockerLauncherDependencies = {}): GaryRuntimeLauncher {
  // Validate/copy caller configuration once; later caller mutation cannot expand it.
  const baseline = createContainerSpec(options);
  const frozen = Object.freeze({ imageDigest: options.imageDigest, dockerExecutable: baseline.command[0]!, dockerHost: baseline.env.DOCKER_HOST! });
  const run = dependencies.run ?? runDocker, stdio = dependencies.stdio;
  return async (manifest, handle, signal) => {
    if (signal.aborted || Date.now() >= manifest.deadlineMs) throw new Error("worker_launch_expired");
    const spec = createContainerSpec(frozen);
    try {
      const inspected = await run([spec.command[0]!, "image", "inspect", frozen.imageDigest], spec.env,
        Math.max(1, Math.min(10_000, manifest.deadlineMs - Date.now())), signal);
      if (inspected.exitCode !== 0) throw 0;
      verifyImage(inspected.stdout, frozen.imageDigest);
    } catch { throw new Error("worker_image_preflight_failed"); }
    if (signal.aborted || Date.now() >= manifest.deadlineMs) throw new Error("worker_launch_expired");
    const cleanup = async () => {
      try {
        // Cleanup has an independent bounded budget even after the task aborts.
        await run(spec.cleanupCommand, spec.env, 10_000);
        const remaining = await run([spec.command[0]!, "container", "ls", "--all", "--filter",
          `name=^${spec.containerName}$`, "--format", "{{.ID}}"], spec.env, 10_000);
        // A successful empty listing distinguishes --rm from a daemon failure.
        if (remaining.exitCode !== 0 || remaining.stdout.trim()) throw 0;
      } catch { throw new Error("worker_cleanup_failed"); }
    };
    const createStdio = stdio ?? (await import("./stdio-launcher.ts")).createStdioLauncher;
    return createStdio({ command: spec.command, cwd: spec.cwd, env: spec.env, cleanup })(manifest, handle, signal);
  };
}
