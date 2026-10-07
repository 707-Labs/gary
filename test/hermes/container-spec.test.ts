import { describe, expect, test } from "bun:test";
import { CONTAINER_RUNTIME_DIRECTORY, createContainerSpec, type ContainerSpecOptions } from "../../src/hermes/container-spec.ts";

// A format-only fixture, not an installed or verified image. Tests never invoke Docker.
const imageDigest = `sha256:${"a".repeat(64)}`;
const socket = "unix:///Users/tanner/.colima/default/docker.sock";
function flag(command: readonly string[], name: string): string | undefined {
  const index = command.indexOf(name);
  return index < 0 ? undefined : command[index + 1];
}

describe("isolated stdio container specification, no Docker execution", () => {
  test("pins the baked image and worker with no host mount and fixed resource bounds", () => {
    const spec = createContainerSpec({ imageDigest, dockerHost: socket });
    expect(spec.cwd).toBe("/");
    expect(spec.env.DOCKER_HOST).toBe(socket);
    expect(spec.command.slice(0, 3)).toEqual(["/usr/local/bin/docker", "container", "run"]);
    expect(flag(spec.command, "--pull")).toBe("never");
    expect(flag(spec.command, "--network")).toBe("none");
    expect(spec.command).toContain("--read-only");
    expect(flag(spec.command, "--user")).toBe("65532:65532");
    expect(flag(spec.command, "--cap-drop")).toBe("ALL");
    expect(flag(spec.command, "--security-opt")).toBe("no-new-privileges=true");
    expect(flag(spec.command, "--pids-limit")).toBe("128");
    expect(flag(spec.command, "--memory")).toBe("4g");
    expect(flag(spec.command, "--memory-swap")).toBe("4g");
    expect(flag(spec.command, "--cpus")).toBe("2");
    expect(flag(spec.command, "--log-driver")).toBe("none");
    expect(spec.command).toContain("--no-healthcheck");
    expect(flag(spec.command, "--tmpfs")).toBe("/tmp:rw,noexec,nosuid,nodev,size=268435456,mode=1777");
    expect(spec.command).not.toContain("--mount");
    expect(flag(spec.command, "--workdir")).toBe(CONTAINER_RUNTIME_DIRECTORY);
    expect(flag(spec.command, "--entrypoint")).toBe("/usr/bin/env");
    expect(spec.command.slice(spec.command.indexOf(imageDigest))).toEqual([
      imageDigest, "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp",
      "python", "-I", "-B", "python/gary_runtime.py", "--stdio",
    ]);
    for (const disallowed of ["--privileged", "--device", "--env", "--env-file", "--volume", "--volumes-from", "--publish", "--publish-all", "--use-api-socket", "--detach", "--tty"]) {
      expect(spec.command).not.toContain(disallowed);
    }
  });

  test("uses unique names and cleanup targets precisely its own non-restarting foreground container", () => {
    const first = createContainerSpec({ imageDigest });
    const second = createContainerSpec({ imageDigest });
    expect(first.containerName).toMatch(/^gary-hermes-worker-[0-9a-f-]{36}$/);
    expect(first.containerName).not.toBe(second.containerName);
    expect(flag(first.command, "--name")).toBe(first.containerName);
    expect(flag(first.command, "--restart")).toBe("no");
    expect(first.command).toContain("--rm");
    expect(first.command).toContain("--interactive");
    expect(first.cleanupCommand).toEqual(["/usr/local/bin/docker", "container", "rm", "--force", first.containerName]);
    expect(first.cleanupCommand).not.toContain(second.containerName);
  });

  test("freezes the complete specification and never inherits host environment", () => {
    const spec = createContainerSpec({ imageDigest });
    expect(spec.env).toEqual({
      PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
      DOCKER_CONFIG: "/var/empty/gary-hermes-no-docker-config",
      DOCKER_HOST: "unix:///var/run/docker.sock",
    });
    for (const value of [spec, spec.command, spec.cleanupCommand, spec.env]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => (spec.command as string[]).push("--privileged")).toThrow();
    expect(() => { (spec.env as Record<string, string>).PROVIDER_KEY = "fake"; }).toThrow();
  });

  test.each([
    "python:latest", "python:3.11", "sha256:abc", `sha256:${"A".repeat(64)}`,
    `example.test/worker@sha256:${"a".repeat(64)}`, `sha256:${"a".repeat(64)} --privileged`,
    `sha256:${"a".repeat(64)}\n`, "", undefined, null,
  ])("rejects mutable, abbreviated or injected image reference %#", (image) => {
    expect(() => createContainerSpec({ imageDigest: image } as ContainerSpecOptions)).toThrow("immutable local image digest");
  });

  test.each([
    "tcp://127.0.0.1:2375", "ssh://host", "unix://relative.sock", "unix:///tmp/../docker.sock",
    "unix:///tmp/./docker.sock", "unix:///tmp//docker.sock", "unix:///tmp/a.sock\n", "unix:///tmp/a.sock --privileged",
    "unix:///tmp/a.sock,other", "unix:///tmp/a.sock;echo-secret", "unix:///tmp/a.sock?query", null,
  ])("rejects remote, aliased or injected daemon endpoints %#", (dockerHost) => {
    expect(() => createContainerSpec({ imageDigest, dockerHost } as ContainerSpecOptions)).toThrow("local Docker Unix socket");
  });

  test.each([
    { sourceDirectory: "/" }, { sourceDirectory: "/tmp/candidate" }, { mounts: ["/:/host"] }, { volumes: ["/var/run/docker.sock:/var/run/docker.sock"] },
    { env: { API_KEY: "fake" } }, { envFile: "/private/env" }, { workspace: "/tmp/work" },
    { network: "host" }, { containerName: "existing-gary" }, { command: ["sh"] },
    { extraArgs: ["--privileged"] }, { memory: "unlimited" },
  ])("rejects unreviewed configuration surfaces and mounts %#", (extra) => {
    expect(() => createContainerSpec({ imageDigest, ...extra } as ContainerSpecOptions)).toThrow("unsupported container option");
  });

  test.each(["docker", "/tmp/docker", "/usr/local/bin/docker --host tcp://remote", "/usr/local/bin/docker\n", "/bin/sh"])("rejects unreviewed Docker executable %#", (dockerExecutable) => {
    expect(() => createContainerSpec({ imageDigest, dockerExecutable })).toThrow("unreviewed Docker executable");
  });

  test.each(["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/usr/bin/docker"])("uses the same allowlisted CLI for launch and cleanup %#", (dockerExecutable) => {
    const spec = createContainerSpec({ imageDigest, dockerExecutable });
    expect(spec.command[0]).toBe(dockerExecutable);
    expect(spec.cleanupCommand[0]).toBe(dockerExecutable);
  });
});
