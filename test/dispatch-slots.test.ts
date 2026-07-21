import { describe, expect, it } from "bun:test";
import { dispatchSlots } from "../src/loop.ts";

describe("dispatchSlots", () => {
  describe("happy path", () => {
    it("dispatches every candidate when well under all bounds", () => {
      expect(dispatchSlots({ unarmedProviders: 3, candidates: 2, maxInFlight: 3 })).toBe(2);
    });

    it("is bounded by provider capacity", () => {
      expect(dispatchSlots({ unarmedProviders: 1, candidates: 9, maxInFlight: 3 })).toBe(1);
    });

    it("is bounded by the governor", () => {
      expect(dispatchSlots({ unarmedProviders: 3, candidates: 9, maxInFlight: 2 })).toBe(2);
    });
  });

  describe("the regression this fixes", () => {
    it("no longer opens 10 tickets just because 3 providers are free", () => {
      expect(dispatchSlots({ unarmedProviders: 3, candidates: 10, maxInFlight: 3 })).toBe(3);
    });

    it("paces a large assigned set to the cap, not the provider count", () => {
      const slots = dispatchSlots({
        unarmedProviders: 3,
        candidates: 10,
        maxInFlight: 2,
      });
      expect(slots).toBeLessThan(3);
    });
  });

  describe("edge cases", () => {
    it("returns 0 when every provider is armed", () => {
      expect(dispatchSlots({ unarmedProviders: 0, candidates: 5, maxInFlight: 3 })).toBe(0);
    });

    it("returns 0 when there is nothing to do", () => {
      expect(dispatchSlots({ unarmedProviders: 3, candidates: 0, maxInFlight: 3 })).toBe(0);
    });

    it("never returns negative for a nonsensical cap", () => {
      expect(dispatchSlots({ unarmedProviders: 3, candidates: 5, maxInFlight: -1 })).toBe(0);
    });
  });
});
