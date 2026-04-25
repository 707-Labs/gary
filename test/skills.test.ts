import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  formatProjectContext,
  loadProjectContext,
  loadSkillIndex,
} from "../src/skills.ts";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(resolve(tmpdir(), "gary-skills-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function writeSkill(name: string, frontmatter: string, body: string): void {
  const dir = resolve(workspace, ".claude/skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`);
}

describe("loadSkillIndex", () => {
  it("returns [] when .claude/skills is missing", () => {
    expect(loadSkillIndex(workspace)).toEqual([]);
  });

  it("parses name + description from SKILL.md frontmatter", () => {
    writeSkill("tdd", "name: tdd\ndescription: Enforce TDD", "body");
    writeSkill("typecheck", "name: typecheck\ndescription: Run tsc", "body");
    const skills = loadSkillIndex(workspace);
    expect(skills).toHaveLength(2);
    expect(skills[0]).toMatchObject({
      name: "tdd",
      description: "Enforce TDD",
      path: ".claude/skills/tdd/SKILL.md",
    });
    expect(skills[1]?.name).toBe("typecheck");
  });

  it("returns sorted by name", () => {
    writeSkill("zoo", "name: zoo\ndescription: z", "");
    writeSkill("alpha", "name: alpha\ndescription: a", "");
    writeSkill("middle", "name: middle\ndescription: m", "");
    expect(loadSkillIndex(workspace).map((s) => s.name)).toEqual([
      "alpha",
      "middle",
      "zoo",
    ]);
  });

  it("skips skills without complete frontmatter", () => {
    writeSkill("good", "name: good\ndescription: ok", "");
    writeSkill("missing-name", "description: has no name", "");
    writeSkill("missing-desc", "name: missing-desc", "");
    writeSkill("no-frontmatter", "", "just body, no frontmatter");
    const skills = loadSkillIndex(workspace);
    expect(skills.map((s) => s.name)).toEqual(["good"]);
  });
});

describe("loadProjectContext", () => {
  it("returns nulls when files missing", () => {
    expect(loadProjectContext(workspace)).toEqual({
      claudeMd: null,
      agentsMd: null,
    });
  });

  it("reads CLAUDE.md and AGENTS.md", () => {
    writeFileSync(resolve(workspace, "CLAUDE.md"), "# project rules");
    writeFileSync(resolve(workspace, "AGENTS.md"), "# agent guidance");
    const ctx = loadProjectContext(workspace);
    expect(ctx.claudeMd).toBe("# project rules");
    expect(ctx.agentsMd).toBe("# agent guidance");
  });

  it("truncates oversized files", () => {
    const huge = "x".repeat(20_000);
    writeFileSync(resolve(workspace, "CLAUDE.md"), huge);
    const ctx = loadProjectContext(workspace);
    expect(ctx.claudeMd?.length).toBeLessThan(huge.length);
    expect(ctx.claudeMd).toContain("[truncated to");
  });
});

describe("formatProjectContext", () => {
  it("returns empty string when nothing applies", () => {
    expect(formatProjectContext({ claudeMd: null, agentsMd: null }, [])).toBe("");
  });

  it("composes all three sections in order", () => {
    const out = formatProjectContext(
      { claudeMd: "# CM", agentsMd: "# AG" },
      [{ name: "tdd", description: "do tdd", path: ".claude/skills/tdd/SKILL.md" }],
    );
    const cmIdx = out.indexOf("CLAUDE.md (project instructions)");
    const agIdx = out.indexOf("AGENTS.md (agent guidance)");
    const skIdx = out.indexOf("Project skills");
    expect(cmIdx).toBeGreaterThan(-1);
    expect(agIdx).toBeGreaterThan(cmIdx);
    expect(skIdx).toBeGreaterThan(agIdx);
    expect(out).toContain("`.claude/skills/tdd/SKILL.md` — do tdd");
  });

  it("omits empty sections cleanly", () => {
    const out = formatProjectContext(
      { claudeMd: "# CM", agentsMd: null },
      [],
    );
    expect(out).toContain("CLAUDE.md");
    expect(out).not.toContain("AGENTS.md");
    expect(out).not.toContain("Project skills");
  });
});
