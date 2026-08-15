import { describe, expect, it } from "bun:test";
import { mapBlockedBy } from "../src/adapters/linear.ts";

describe("mapBlockedBy", () => {
  it("keeps only 'blocks' relations", () => {
    const out = mapBlockedBy([
      {
        type: "blocks",
        issue: {
          id: "a",
          identifier: "ERT-1",
          state: { name: "In Progress", type: "started" },
        },
      },
      {
        type: "related",
        issue: {
          id: "b",
          identifier: "ERT-2",
          state: { name: "Todo", type: "unstarted" },
        },
      },
      {
        type: "duplicate",
        issue: {
          id: "c",
          identifier: "ERT-3",
          state: { name: "Todo", type: "unstarted" },
        },
      },
    ]);
    expect(out.map((b) => b.identifier)).toEqual(["ERT-1"]);
  });

  it("marks completed and canceled blockers as not open", () => {
    const out = mapBlockedBy([
      {
        type: "blocks",
        issue: { id: "a", identifier: "ERT-1", state: { name: "Done", type: "completed" } },
      },
      {
        type: "blocks",
        issue: { id: "b", identifier: "ERT-2", state: { name: "Canceled", type: "canceled" } },
      },
      {
        type: "blocks",
        issue: { id: "c", identifier: "ERT-3", state: { name: "Backlog", type: "backlog" } },
      },
    ]);
    expect(out.map((b) => b.isOpen)).toEqual([false, false, true]);
  });

  it("fails CLOSED on relations it can't interpret (null issue or state)", () => {
    const out = mapBlockedBy([
      { type: "blocks", issue: null },
      { type: "blocks", issue: { id: "a", identifier: "ERT-9", state: null } },
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((b) => b.isOpen)).toBe(true);
    expect(out[0]?.identifier).toBe("(inaccessible)");
    expect(out[1]?.identifier).toBe("ERT-9");
  });

  it("returns [] for no relations", () => {
    expect(mapBlockedBy([])).toEqual([]);
  });
});
