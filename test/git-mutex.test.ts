import { describe, expect, it } from "bun:test";
import { withBareLock } from "../src/git.ts";

describe("withBareLock", () => {
  it("serializes work for the same key", async () => {
    // Without the lock, both inner functions would interleave: the second
    // would start before the first finishes. With the lock, the second
    // starts only after the first resolves.
    const order: string[] = [];
    const a = withBareLock("/tmp/repo-a.git", async () => {
      order.push("a:start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a:end");
      return "a";
    });
    const b = withBareLock("/tmp/repo-a.git", async () => {
      order.push("b:start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("b:end");
      return "b";
    });
    const [ar, br] = await Promise.all([a, b]);
    expect(ar).toBe("a");
    expect(br).toBe("b");
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("runs concurrently for different keys", async () => {
    // Two different bare repos shouldn't block each other.
    const order: string[] = [];
    const a = withBareLock("/tmp/repo-a.git", async () => {
      order.push("a:start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a:end");
    });
    const b = withBareLock("/tmp/repo-b.git", async () => {
      order.push("b:start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("b:end");
    });
    await Promise.all([a, b]);
    // b started before a finished — interleaving observed.
    expect(order.indexOf("b:start")).toBeLessThan(order.indexOf("a:end"));
  });

  it("releases the lock after the inner function rejects", async () => {
    // A failure in slot 1 must not wedge slot 2.
    const order: string[] = [];
    const failing = withBareLock("/tmp/repo-c.git", async () => {
      order.push("fail:start");
      throw new Error("boom");
    }).catch((e) => e.message);
    const ok = withBareLock("/tmp/repo-c.git", async () => {
      order.push("ok:start");
      return "ok";
    });
    const [f, o] = await Promise.all([failing, ok]);
    expect(f).toBe("boom");
    expect(o).toBe("ok");
    // Both ran, in order.
    expect(order).toEqual(["fail:start", "ok:start"]);
  });
});
