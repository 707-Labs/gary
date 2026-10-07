import { describe, expect, test } from "bun:test";
import { createDockerRuntimeLauncher, type DockerCommandRunner } from "../../src/hermes/docker-launcher.ts";
import type { GaryRuntimeManifest } from "../../src/hermes/gary-loop-adapter.ts";
import type { StdioLaunchOptions } from "../../src/hermes/stdio-launcher.ts";
const imageDigest = "sha256:" + "a".repeat(64);
const manifest = (): GaryRuntimeManifest => ({ taskId: "t", requestId: "r", ownerEpoch: "o", capability: "c".repeat(40),
  modelBaseUrl: "http://127.0.0.1/v1", executorUrl: "http://127.0.0.1/tools/execute", stateUrl: "http://127.0.0.1/tools/state",
  model: "glm-5.3", prompt: "fixture", systemPrompt: "fixture", tools: [], maxIterations: 3, maxTokens: 100,
  temperature: 0.3, deadlineMs: Date.now() + 5000 });
const image = () => ({ Id: imageDigest, Os: "linux", Architecture: "arm64", Config: { User: "65532:65532", WorkingDir: "/opt/gary-hermes-runtime" } });
function fixture(metadata: unknown = [image()], cleanupMode = "ok") {
  const calls: { command: readonly string[]; env: Readonly<Record<string,string>>; signal?: AbortSignal }[] = [];
  const launches: StdioLaunchOptions[] = [];
  const run: DockerCommandRunner = async (command, env, _timeout, signal) => {
    calls.push({ command, env, ...(signal ? { signal } : {}) });
    if (command[1] === "image") return { exitCode: 0, stdout: JSON.stringify(metadata) };
    if (command[2] === "ls") return { exitCode: cleanupMode === "daemon-failure" ? 1 : 0, stdout: cleanupMode === "remaining" ? "123" : "" };
    return { exitCode: 1, stdout: "" }; // --rm may already have removed the exact name.
  };
  const launch = createDockerRuntimeLauncher({ imageDigest, dockerHost: "unix:///Users/tanner/.colima/default/docker.sock" }, {
    run, stdio(options) { launches.push(options); return async m => {
      await options.cleanup(); return { taskId: m.taskId, requestId: m.requestId, status: "no_finish", publicationApproved: false };
    }; },
  });
  return { launch, calls, launches };
}
describe("concrete immutable Docker launcher, offline injected command runner", () => {
  test("preflights each invocation, uses fresh names and awaits exact cleanup with clean environment", async () => {
    const f = fixture();
    expect(f.calls).toHaveLength(0);
    for (let n=0;n<2;n++) await f.launch(manifest(),async()=>Response.json({}),new AbortController().signal);
    expect(f.calls).toHaveLength(6);expect(f.launches).toHaveLength(2);
    const names = f.launches.map(x => x.command[x.command.indexOf("--name")+1]!);
    expect(names[0]).not.toBe(names[1]);
    for (let n=0;n<2;n++) {
      expect(f.calls[n*3]!.command).toEqual(["/usr/local/bin/docker","image","inspect",imageDigest]);
      expect(f.calls[n*3+1]!.command).toEqual(["/usr/local/bin/docker","container","rm","--force",names[n]!]);
      expect(f.calls[n*3+2]!.command).toContain(`name=^${names[n]}$`);
      expect(f.calls[n*3+1]!.signal).toBeUndefined();
      expect(f.launches[n]!.command).not.toContain("--mount");
      expect(Object.keys(f.calls[n*3]!.env).sort()).toEqual(["DOCKER_CONFIG","DOCKER_HOST","PATH"]);
    }
  });
  test.each([
    [], {}, [{...image(),Id:"sha256:"+"b".repeat(64)}], [{...image(),Os:"windows"}],
    [{...image(),Config:{...image().Config,Volumes:{"/workspace":{}}}}],
    [{...image(),Config:{...image().Config,User:"0"}}],
    [{...image(),Config:{...image().Config,WorkingDir:"/tmp"}}],
    [{...image(),Config:{...image().Config,Healthcheck:{Test:["CMD","curl"]}}}],
  ].map(metadata => ({ metadata })))("rejects unsafe/mismatched image metadata before any launch %#",async ({metadata})=>{
    const f=fixture(metadata);
    await expect(f.launch(manifest(),async()=>Response.json({}),new AbortController().signal)).rejects.toThrow("worker_image_preflight_failed");
    expect(f.calls).toHaveLength(1);expect(f.launches).toHaveLength(0);
  });
  test.each(["remaining","daemon-failure"])("fails closed when cleanup cannot prove absence: %s",async mode=>{
    const f=fixture([image()],mode);
    await expect(f.launch(manifest(),async()=>Response.json({}),new AbortController().signal)).rejects.toThrow("worker_cleanup_failed");
  });
  test("expired/aborted admission performs no Docker calls",async()=>{
    const f=fixture(),control=new AbortController();control.abort();
    await expect(f.launch(manifest(),async()=>Response.json({}),control.signal)).rejects.toThrow("worker_launch_expired");
    await expect(f.launch({...manifest(),deadlineMs:0},async()=>Response.json({}),new AbortController().signal)).rejects.toThrow("worker_launch_expired");
    expect(f.calls).toHaveLength(0);
  });
});
