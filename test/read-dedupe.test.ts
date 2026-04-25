import { describe, expect, it } from "bun:test";
import { makeToolset } from "../src/agent/tools.ts";
import type { ExecResult, Executor, GrepMatch } from "../src/executors/index.ts";

function fakeExecutor(initial: Record<string, string> = {}): Executor {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    workspaceRoot: "/tmp/fake",
    async readFile(path: string) {
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return v;
    },
    async writeFile(path: string, content: string) {
      files.set(path, content);
    },
    async listFiles(): Promise<string[]> {
      return Array.from(files.keys());
    },
    async grep(): Promise<GrepMatch[]> {
      return [];
    },
    async run(): Promise<ExecResult> {
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    },
  };
}

describe("read_file dedupe", () => {
  it("first read returns full contents and adds the path to the cache", async () => {
    const tools = makeToolset(fakeExecutor({ "x.ts": "the contents" }));
    const r = await tools.handlers["read_file"]!.run({ path: "x.ts" });
    expect(r).toBe("the contents");
    expect(tools.readCache.has("x.ts")).toBe(true);
  });

  it("second read of the same path returns a pointer, not the full contents", async () => {
    const tools = makeToolset(fakeExecutor({ "x.ts": "the contents" }));
    await tools.handlers["read_file"]!.run({ path: "x.ts" });
    const second = await tools.handlers["read_file"]!.run({ path: "x.ts" });
    expect(second).not.toBe("the contents");
    expect(second).toMatch(/already read/);
    expect(second).toContain("x.ts");
  });

  it("write_file invalidates the cache so the next read returns fresh content", async () => {
    const tools = makeToolset(fakeExecutor({ "y.ts": "v1" }));
    await tools.handlers["read_file"]!.run({ path: "y.ts" });
    expect(tools.readCache.has("y.ts")).toBe(true);

    await tools.handlers["write_file"]!.run({ path: "y.ts", content: "v2" });
    expect(tools.readCache.has("y.ts")).toBe(false);

    const reread = await tools.handlers["read_file"]!.run({ path: "y.ts" });
    expect(reread).toBe("v2");
  });

  it("edit_file invalidates the cache so the next read returns fresh content", async () => {
    const tools = makeToolset(fakeExecutor({ "z.ts": "alpha beta gamma" }));
    await tools.handlers["read_file"]!.run({ path: "z.ts" });
    await tools.handlers["edit_file"]!.run({
      path: "z.ts",
      old_string: "beta",
      new_string: "DELTA",
    });
    expect(tools.readCache.has("z.ts")).toBe(false);

    const reread = await tools.handlers["read_file"]!.run({ path: "z.ts" });
    expect(reread).toBe("alpha DELTA gamma");
  });

  it("a missing-file error does NOT poison the cache", async () => {
    const tools = makeToolset(fakeExecutor({}));
    const r = await tools.handlers["read_file"]!.run({ path: "missing.ts" });
    expect(r).toMatch(/ENOENT|error/);
    expect(tools.readCache.has("missing.ts")).toBe(false);
  });

  it("write_file to an unread path doesn't break (delete is a no-op)", async () => {
    const tools = makeToolset(fakeExecutor());
    await tools.handlers["write_file"]!.run({
      path: "fresh.ts",
      content: "new",
    });
    // No prior read; cache stays empty either way.
    expect(tools.readCache.has("fresh.ts")).toBe(false);
  });
});
