import { describe, expect, it } from "bun:test";
import { formatAge } from "../src/handlers/nudge-reviewer.ts";

describe("formatAge", () => {
  it("renders sub-day durations in hours", () => {
    expect(formatAge(0)).toBe("an hour");
    expect(formatAge(1)).toBe("an hour");
    expect(formatAge(5)).toBe("5 hours");
    expect(formatAge(23)).toBe("23 hours");
  });

  it("renders one-day duration as 'a day'", () => {
    expect(formatAge(24)).toBe("a day");
    expect(formatAge(35)).toBe("a day"); // rounds to 1
  });

  it("renders multi-day durations under a week as N days", () => {
    expect(formatAge(48)).toBe("2 days");
    expect(formatAge(72)).toBe("3 days");
    expect(formatAge(120)).toBe("5 days");
  });

  it("renders ~7-13 days as 'a week'", () => {
    expect(formatAge(24 * 7)).toBe("a week");
    expect(formatAge(24 * 10)).toBe("a week");
  });

  it("renders 14-29 days in week buckets", () => {
    expect(formatAge(24 * 14)).toBe("2 weeks");
    expect(formatAge(24 * 21)).toBe("3 weeks");
  });

  it("renders 30+ days in months", () => {
    expect(formatAge(24 * 30)).toBe("a month");
    expect(formatAge(24 * 60)).toBe("2 months");
  });
});
