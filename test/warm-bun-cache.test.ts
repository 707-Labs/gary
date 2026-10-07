import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../docker/executor/warm-bun-cache.sh");
const created: string[] = [];
const imageId = `sha256:${"a".repeat(64)}`;

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "gary-cache-test-"));
  created.push(dir);
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  await mkdir(repo);
  await mkdir(bin);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  async function git(...args: string[]) {
    const proc = Bun.spawn(["git", "-C", repo, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    if (await proc.exited !== 0) throw new Error(stderr);
    return stdout.trim();
  }
  await git("init", "--quiet");
  await writeFile(join(repo, "package.json"), '{"name":"reviewed"}\n');
  await writeFile(join(repo, "bun.lock"), '{"lockfileVersion":1}\n');
  await git("add", "package.json", "bun.lock");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "reviewed manifests");
  const commit = await git("rev-parse", "HEAD");
  await writeFile(join(bin, "docker"), `#!/bin/sh
set -eu
printf '%s\\n' "$@" >> "$FAKE_DOCKER_LOG"
case "$1" in
  image) printf '%s\\n' '${imageId}' ;;
  volume) ;;
  run) cat > "$FAKE_DOCKER_ARCHIVE"; exit "\${FAKE_DOCKER_EXIT:-0}" ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
  async function run(args: string[] = [repo, commit], extraEnv: Record<string, string> = {}) {
    const proc = Bun.spawn(["sh", script, ...args], {
      env: { ...env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir,
        GARY_EXECUTOR_IMAGE: "reviewed-executor:local", GARY_BUN_CACHE_VOLUME: "reviewed-cache",
        FAKE_DOCKER_LOG: join(dir, "docker.log"), FAKE_DOCKER_ARCHIVE: join(dir, "manifests.tar"), ...extraEnv },
      stdout: "pipe", stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { code: await proc.exited, stdout, stderr };
  }
  return { dir, repo, commit, run };
}

describe("reviewed Bun cache warm-up", () => {
  it("streams only committed manifests and pins the local image without host mounts", async () => {
    const { dir, repo, commit, run } = await fixture();
    await writeFile(join(repo, "package.json"), '{"name":"unreviewed","scripts":{"postinstall":"bad"}}\n');
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`from commit ${commit} using ${imageId}`);
    const args = (await readFile(join(dir, "docker.log"), "utf8")).split("\n");
    expect(args).toContain(imageId);
    expect(args).toContain("--pull=never");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges");
    expect(args).toContain("type=volume,src=reviewed-cache,dst=/bun-cache");
    expect(args.some((arg) => arg.includes("type=bind"))).toBe(false);
    expect(args.some((arg) => arg.includes("bun install --ignore-scripts --frozen-lockfile"))).toBe(true);
    expect(args.some((arg) => arg.includes("tar --no-same-owner -xf -"))).toBe(true);
    const listing = Bun.spawn(["tar", "-tf", join(dir, "manifests.tar")], { stdout: "pipe" });
    expect((await new Response(listing.stdout).text()).trim().split("\n")).toEqual(["package.json", "bun.lock"]);
    expect(await listing.exited).toBe(0);
    const content = Bun.spawn(["tar", "-xOf", join(dir, "manifests.tar"), "package.json"], { stdout: "pipe" });
    expect(await new Response(content.stdout).text()).toBe('{"name":"reviewed"}\n');
    expect(await content.exited).toBe(0);
  });

  it("requires an explicit existing reviewed commit before touching Docker", async () => {
    const { dir, repo, run } = await fixture();
    expect((await run([repo])).code).not.toBe(0);
    expect((await run([repo, "missing-commit"])).code).not.toBe(0);
    expect(await Bun.file(join(dir, "docker.log")).exists()).toBe(false);
  });

  it("rejects unsafe Docker volume names before touching Docker", async () => {
    const { dir, run } = await fixture();
    expect((await run(undefined, { GARY_BUN_CACHE_VOLUME: "-bad" })).code).toBe(2);
    expect((await run(undefined, { GARY_BUN_CACHE_VOLUME: "cache,readonly" })).code).toBe(2);
    expect(await Bun.file(join(dir, "docker.log")).exists()).toBe(false);
  });

  it("does not report a successful warm-up after an install failure", async () => {
    const { run } = await fixture();
    const result = await run(undefined, { FAKE_DOCKER_EXIT: "42" });
    expect(result.code).toBe(42);
    expect(result.stdout).not.toContain("warmed ");
  });
});
