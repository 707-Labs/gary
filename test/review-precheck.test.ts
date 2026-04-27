import { describe, expect, it } from "bun:test";
import { findUntestedExports } from "../src/review/precheck.ts";
import { findUnwiredIdentifiers } from "../src/review/precheck.ts";

const DIFF_NEW_EXPORT_NO_TEST = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,7 @@
 import { something } from "./bar";

+export function buildPayload(input: string): string {
+  return input.toUpperCase();
+}
+
 export const VERSION = "1.0.0";
`;

describe("findUntestedExports", () => {
  it("flags a new exported function with no test reference", async () => {
    const findings = await findUntestedExports({
      diff: DIFF_NEW_EXPORT_NO_TEST,
      grep: async (_pattern: string) => [],
    });
    expect(findings.length).toBe(1);
    expect(findings[0]!.name).toBe("buildPayload");
    expect(findings[0]!.file).toBe("src/foo.ts");
    expect(findings[0]!.kind).toBe("untested_export");
  });

  it("does NOT flag exports that have a test reference", async () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,5 @@
+export function buildPayload(input: string): string {
+  return input.toUpperCase();
+}
`;
    const findings = await findUntestedExports({
      diff,
      grep: async (pattern: string) => {
        if (pattern === "buildPayload") {
          return [
            { path: "test/foo.test.ts", line: 4, text: 'import { buildPayload } from "../src/foo.ts";' },
          ];
        }
        return [];
      },
    });
    expect(findings).toEqual([]);
  });

  it("ignores private (non-exported) declarations", async () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
+function privateHelper() {}
`;
    const findings = await findUntestedExports({ diff, grep: async () => [] });
    expect(findings).toEqual([]);
  });

  it("detects exported const, class, and default function", async () => {
    const diff = `diff --git a/src/multi.ts b/src/multi.ts
index 1111111..2222222 100644
--- a/src/multi.ts
+++ b/src/multi.ts
@@ -1 +1,5 @@
+export const COLOR_TABLE = { red: "#ff0000" };
+export class Widget {}
+export default function defaultThing() {}
+export async function asyncOp() {}
`;
    const findings = await findUntestedExports({ diff, grep: async () => [] });
    const names = findings.map((f) => f.name).sort();
    expect(names).toEqual(["COLOR_TABLE", "Widget", "asyncOp", "defaultThing"]);
  });

  it("only considers added lines, not removed", async () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts
index 1111111..2222222 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,5 +1,5 @@
 export function staysTheSame() {}
-export function removedFn() {}
+export function addedFn() {}
`;
    const findings = await findUntestedExports({ diff, grep: async () => [] });
    expect(findings.map((f) => f.name)).toEqual(["addedFn"]);
  });
});

describe("findUnwiredIdentifiers", () => {
  it("flags a query param string that has no consumer", async () => {
    const diff = `diff --git a/src/routes/log/+page.svelte b/src/routes/log/+page.svelte
index 1111111..2222222 100644
--- a/src/routes/log/+page.svelte
+++ b/src/routes/log/+page.svelte
@@ -10,3 +10,5 @@
 <a href="/log">log</a>
+<a href="/log?unidentified=true">unidentified</a>
+<a href="/log?reviewed=true">reviewed</a>
`;
    const findings = await findUnwiredIdentifiers({
      diff,
      grep: async (pattern) => {
        if (pattern === "unidentified=true") {
          return [
            { path: "src/routes/log/+page.svelte", line: 12,
              text: '<a href="/log?unidentified=true">unidentified</a>' },
          ];
        }
        if (pattern === "reviewed=true") {
          return [
            { path: "src/routes/log/+page.svelte", line: 13, text: 'reviewed' },
            { path: "src/routes/log/quick/[sessionId]/+page.svelte", line: 8,
              text: 'if (params.has("reviewed")) {' },
          ];
        }
        return [];
      },
    });
    expect(findings.length).toBe(1);
    expect(findings[0]!.name).toBe("unidentified=true");
    expect(findings[0]!.kind).toBe("unwired_identifier");
  });

  it("flags an event name that no consumer listens for", async () => {
    const diff = `diff --git a/src/lib/events.ts b/src/lib/events.ts
index 1111111..2222222 100644
--- a/src/lib/events.ts
+++ b/src/lib/events.ts
@@ -1,1 +1,2 @@
 emit("user.created", payload);
+emit("session.expired", payload);
`;
    const findings = await findUnwiredIdentifiers({
      diff,
      grep: async (pattern) => {
        if (pattern === "session.expired") {
          return [
            { path: "src/lib/events.ts", line: 2,
              text: 'emit("session.expired", payload);' },
          ];
        }
        return [];
      },
    });
    expect(findings.length).toBe(1);
    expect(findings[0]!.name).toBe("session.expired");
  });

  it("does NOT flag identifiers when the diff has the consumer", async () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
+emit("foo.bar", x);
diff --git a/src/b.ts b/src/b.ts
+on("foo.bar", handler);
`;
    const findings = await findUnwiredIdentifiers({
      diff,
      grep: async (pattern) => {
        if (pattern === "foo.bar") {
          return [
            { path: "src/a.ts", line: 1, text: 'emit("foo.bar", x);' },
            { path: "src/b.ts", line: 1, text: 'on("foo.bar", handler);' },
          ];
        }
        return [];
      },
    });
    expect(findings).toEqual([]);
  });

  it("ignores short or generic strings", async () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts
+const z = "ok";
+const w = "1";
+const t = "";
`;
    const findings = await findUnwiredIdentifiers({ diff, grep: async () => [] });
    expect(findings).toEqual([]);
  });
});
