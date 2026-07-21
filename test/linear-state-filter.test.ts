import { afterEach, describe, expect, it } from "bun:test";
import {
  isSkippedStateType,
  LinearAdapter,
  resolveSkippedStateTypes,
} from "../src/adapters/linear.ts";

const ENV_KEY = "GARY_SKIP_STATE_TYPES";

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("isSkippedStateType", () => {
  describe("happy path", () => {
    it("skips backlog so parked tickets stay parked", () => {
      expect(isSkippedStateType("backlog")).toBe(true);
    });

    it("works unstarted (Todo) tickets", () => {
      expect(isSkippedStateType("unstarted")).toBe(false);
    });

    it("works started (In Progress) tickets", () => {
      expect(isSkippedStateType("started")).toBe(false);
    });

    it("still skips completed", () => {
      expect(isSkippedStateType("completed")).toBe(true);
    });

    it("still skips canceled", () => {
      expect(isSkippedStateType("canceled")).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("works triage tickets — a human assigned it on purpose", () => {
      expect(isSkippedStateType("triage")).toBe(false);
    });

    it("fails open on a missing state rather than going dark", () => {
      expect(isSkippedStateType(undefined)).toBe(false);
    });

    it("fails open on an unrecognized state type", () => {
      expect(isSkippedStateType("some_future_linear_type")).toBe(false);
    });
  });
});

describe("resolveSkippedStateTypes", () => {
  describe("happy path", () => {
    it("defaults to terminal states plus backlog", () => {
      expect(resolveSkippedStateTypes()).toEqual(
        LinearAdapter.DEFAULT_SKIPPED_STATE_TYPES,
      );
    });

    it("honors an override that also parks triage", () => {
      process.env[ENV_KEY] = "backlog,triage";
      expect(resolveSkippedStateTypes()).toContain("triage");
    });

    it("lets an override un-park backlog", () => {
      process.env[ENV_KEY] = "";
      expect(resolveSkippedStateTypes()).not.toContain("backlog");
    });
  });

  describe("invariants", () => {
    it("always keeps completed even when overridden away", () => {
      process.env[ENV_KEY] = "backlog";
      expect(resolveSkippedStateTypes()).toContain("completed");
    });

    it("always keeps canceled even when overridden away", () => {
      process.env[ENV_KEY] = "";
      expect(resolveSkippedStateTypes()).toContain("canceled");
    });

    it("dedupes a redundant override", () => {
      process.env[ENV_KEY] = "completed,backlog";
      const out = resolveSkippedStateTypes();
      expect(out.filter((s) => s === "completed")).toHaveLength(1);
    });

    it("tolerates whitespace in the override", () => {
      process.env[ENV_KEY] = " backlog , triage ";
      expect(resolveSkippedStateTypes()).toEqual([
        "completed",
        "canceled",
        "backlog",
        "triage",
      ]);
    });
  });
});
