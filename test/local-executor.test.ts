import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutor, WorkspaceBoundaryError } from "../src/executors/local.ts";

describe("LocalExecutor", () => {
  let workspace: string;
  let exec: LocalExecutor;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "gary-exec-"));
    exec = new LocalExecutor(workspace);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  describe("readFile / writeFile", () => {
    it("round-trips a relative path", async () => {
      await exec.writeFile("hello.txt", "hi");
      expect(await exec.readFile("hello.txt")).toBe("hi");
    });

    it("creates parent directories on write", async () => {
      await exec.writeFile("nested/deep/file.txt", "x");
      expect(await exec.readFile("nested/deep/file.txt")).toBe("x");
    });

    it("rejects writing outside the workspace via ..", async () => {
      await expect(exec.writeFile("../escape.txt", "x")).rejects.toThrow(
        WorkspaceBoundaryError,
      );
    });

    it("rejects reading outside the workspace via absolute path", async () => {
      await expect(exec.readFile("/etc/passwd")).rejects.toThrow(
        WorkspaceBoundaryError,
      );
    });
  });

  describe("listFiles", () => {
    it("lists files matching a glob, relative to root", async () => {
      await exec.writeFile("a.ts", "");
      await exec.writeFile("b.ts", "");
      await exec.writeFile("nested/c.ts", "");
      await exec.writeFile("d.txt", "");
      const tsFiles = await exec.listFiles("**/*.ts");
      expect(tsFiles.sort()).toEqual(["a.ts", "b.ts", "nested/c.ts"]);
    });
  });

  describe("grep", () => {
    it("finds matches with line numbers", async () => {
      await exec.writeFile(
        "src/foo.ts",
        ["function bar() {}", "// TODO: clean this up", "export {};"].join("\n"),
      );
      const matches = await exec.grep("TODO:");
      expect(matches).toHaveLength(1);
      expect(matches[0]?.path).toBe("src/foo.ts");
      expect(matches[0]?.line).toBe(2);
    });

    it("skips noise dirs by default", async () => {
      // simulate a vendored file that should not be searched
      writeFileSync(join(workspace, "node_modules-dummy"), "");
      // create a real file with the pattern
      await exec.writeFile("src/real.ts", "MARKER");
      const matches = await exec.grep("MARKER");
      expect(matches.map((m) => m.path)).toEqual(["src/real.ts"]);
    });
  });

  describe("run", () => {
    it("captures stdout and exit code 0 on success", async () => {
      const r = await exec.run("echo hello");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("hello");
      expect(r.timedOut).toBe(false);
    });

    it("captures stderr and non-zero exit on failure", async () => {
      const r = await exec.run("ls /definitely-does-not-exist-xyz123");
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr.length).toBeGreaterThan(0);
    });

    it("runs in workspace root by default", async () => {
      await exec.writeFile("marker.txt", "");
      const r = await exec.run("ls -1");
      expect(r.stdout).toContain("marker.txt");
    });

    it("times out and reports timedOut", async () => {
      const r = await exec.run("sleep 5", { timeoutMs: 200 });
      expect(r.timedOut).toBe(true);
    });
  });

  describe("constructor", () => {
    it("rejects relative workspace roots", () => {
      expect(() => new LocalExecutor("relative/path")).toThrow();
    });
  });
});
