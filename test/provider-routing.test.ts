import { describe, expect, it } from "bun:test";
import type { ProviderRoutingConfig } from "../src/config.ts";
import { phaseBudget } from "../src/handlers/code.ts";
import { providerOrderForAction } from "../src/loop.ts";
import type { ActionType } from "../src/priority.ts";

const routing: ProviderRoutingConfig = {
  main: ["kimi", "z.ai", "deepseek"],
  prFollowup: ["z.ai", "kimi", "deepseek"],
};

describe("providerOrderForAction", () => {
  it("routes PR follow-ups to the prFollowup order", () => {
    const followups: ActionType[] = [
      "fix_ci_failure",
      "respond_to_pr_review",
      "nudge_reviewer",
    ];
    for (const type of followups) {
      expect(providerOrderForAction(type, routing)).toBe(routing.prFollowup);
    }
  });

  it("routes everything else to the main order", () => {
    const main: ActionType[] = [
      "classify",
      "start_coding",
      "revisit_code",
      "write_answer",
      "answer_mention",
      "pickup_ticket",
      "bounce",
    ];
    for (const type of main) {
      expect(providerOrderForAction(type, routing)).toBe(routing.main);
    }
  });
});

describe("phaseBudget", () => {
  it("gives L a larger budget than M, and M larger than S", () => {
    const s = phaseBudget("S");
    const m = phaseBudget("M");
    const l = phaseBudget("L");
    expect(s.investigate + s.implement).toBeLessThan(m.investigate + m.implement);
    expect(m.investigate + m.implement).toBeLessThan(l.investigate + l.implement);
  });
});
