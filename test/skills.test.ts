import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  formatProjectContext,
  loadProjectContext,
  loadSkillIndex,
} from "../src/skills.ts";

let workspace: string;
let outside: string;

beforeEach(() => {
  workspace = mkdtempSync(resolve(tmpdir(), "gary-skills-"));
  outside = mkdtempSync(resolve(tmpdir(), "gary-skills-outside-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function writeSkill(name: string, frontmatter: string, body: string, root = ".claude/skills"): void {
  const dir = resolve(workspace, root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`);
}

describe("loadSkillIndex", () => {
  it("returns [] when both skill roots are missing", () => {
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

  it("discovers .agents skills when the legacy root is absent", () => {
    writeSkill("beads", "name: beads\ndescription: Project issue workflow", "body", ".agents/skills");
    expect(loadSkillIndex(workspace)).toEqual([
      { name: "beads", description: "Project issue workflow", path: ".agents/skills/beads/SKILL.md" },
    ]);
  });

  it("preserves identical and conflicting same-name skills with deterministic path provenance", () => {
    writeSkill("z-copy", "name: shared\ndescription: Shared convention", "same", ".claude/skills");
    writeSkill("a-copy", "name: shared\ndescription: Shared convention", "same", ".agents/skills");
    writeSkill("b-copy", "name: shared\ndescription: Different convention", "different", ".agents/skills");
    writeSkill("first", "name: alpha\ndescription: First", "", ".claude/skills");
    const skills = loadSkillIndex(workspace);
    expect(skills.map(s => s.path)).toEqual([
      ".claude/skills/first/SKILL.md", ".agents/skills/a-copy/SKILL.md",
      ".agents/skills/b-copy/SKILL.md", ".claude/skills/z-copy/SKILL.md",
    ]);
    const menu = formatProjectContext({ claudeMd: null, agentsMd: null, hasBeads: false }, skills);
    for (const skill of skills) expect(menu).toContain(`\`${skill.path}\` — ${skill.description}`);
    expect(loadSkillIndex(workspace)).toEqual(skills);
  });

  it("accepts CRLF and reads metadata without decoding the skill body", () => {
    writeSkill("crlf", "name: crlf\ndescription: Read metadata", "");
    const header = "---\r\nname: crlf\r\ndescription: Read metadata\r\n---\r\n";
    writeFileSync(resolve(workspace, ".claude/skills/crlf/SKILL.md"), Buffer.concat([
      Buffer.from(header), Buffer.from([0xff]), Buffer.alloc(20_000, 0xff),
    ]));
    expect(loadSkillIndex(workspace).map(s => s.name)).toEqual(["crlf"]);
  });

  it("rejects malformed, duplicate, blank and oversized metadata while retaining valid siblings", () => {
    writeSkill("good", "name: good\ndescription: Valid", "");
    writeSkill("blank", "name:\ndescription: Not a name", "");
    writeSkill("duplicate", "name: first\nname: second\ndescription: Ambiguous", "");
    writeSkill("duplicate-desc", "name: duplicate-desc\ndescription: first\ndescription: second", "");
    writeSkill("long-name", `name: ${"n".repeat(65)}\ndescription: Long name`, "");
    writeSkill("long-description", `name: long-description\ndescription: ${"é".repeat(513)}`, "");
    writeSkill("large-frontmatter", `name: large\ndescription: Bounded\n# ${"x".repeat(8192)}`, "");
    writeSkill("bad-close", "name: bad-close\ndescription: Closing delimiter must be a whole line", "");
    writeFileSync(resolve(workspace, ".claude/skills/bad-close/SKILL.md"), "---\nname: bad\ndescription: bad\n---not-a-delimiter\n");
    writeSkill("bad-utf8", "name: bad-utf8\ndescription: Bad encoding", "");
    writeFileSync(resolve(workspace, ".claude/skills/bad-utf8/SKILL.md"), Buffer.concat([
      Buffer.from("---\nname: bad-utf8\ndescription: "), Buffer.from([0xff]), Buffer.from("\n---\n"),
    ]));
    expect(loadSkillIndex(workspace).map(s => s.name)).toEqual(["good"]);
  });

  it("bounds the entire regular file and rejects non-regular SKILL.md entries", () => {
    writeSkill("large-file", "name: large-file\ndescription: Large body", "x".repeat(256 * 1024));
    mkdirSync(resolve(workspace, ".agents/skills/directory/SKILL.md"), { recursive: true });
    writeSkill("good", "name: good\ndescription: Valid", "", ".agents/skills");
    expect(loadSkillIndex(workspace).map(s => s.name)).toEqual(["good"]);
  });

  it.each([".agents", ".agents/skills", ".agents/skills/redirect"])("rejects a symlink at %s without hiding the legacy root", component => {
    const target = resolve(outside, "target");
    const rest = component === ".agents" ? "skills/redirect" : component === ".agents/skills" ? "redirect" : ".";
    mkdirSync(resolve(target, rest), { recursive: true });
    writeFileSync(resolve(target, rest, "SKILL.md"), "---\nname: leaked\ndescription: Outside data\n---\n");
    mkdirSync(resolve(workspace, component, ".."), { recursive: true });
    symlinkSync(target, resolve(workspace, component));
    writeSkill("good", "name: good\ndescription: Valid", "");
    expect(loadSkillIndex(workspace).map(s => s.name)).toEqual(["good"]);
  });

  it("rejects linked skill files and a redirected workspace root", () => {
    const target = resolve(outside, "SKILL.md");
    writeFileSync(target, "---\nname: leaked\ndescription: Outside data\n---\n");
    for (const name of ["symlink", "hardlink"]) mkdirSync(resolve(workspace, ".agents/skills", name), { recursive: true });
    symlinkSync(target, resolve(workspace, ".agents/skills/symlink/SKILL.md"));
    linkSync(target, resolve(workspace, ".agents/skills/hardlink/SKILL.md"));
    writeSkill("good", "name: good\ndescription: Valid", "");
    expect(loadSkillIndex(workspace).map(s => s.name)).toEqual(["good"]);
    symlinkSync(workspace, resolve(outside, "workspace-alias"));
    expect(loadSkillIndex(resolve(outside, "workspace-alias"))).toEqual([]);
  });

  it("omits an oversized root rather than taking a filesystem-order-dependent subset", () => {
    for (let i = 0; i < 257; i++) mkdirSync(resolve(workspace, ".agents/skills", `entry-${i}`), { recursive: true });
    writeFileSync(resolve(workspace, ".agents/skills/entry-0/SKILL.md"), "---\nname: overflow\ndescription: Too many entries\n---\n");
    writeSkill("good", "name: good\ndescription: Valid", "");
    expect(loadSkillIndex(workspace).map(s => s.name)).toEqual(["good"]);
  });
});

describe("loadProjectContext", () => {
  it("returns nulls when files missing", () => {
    expect(loadProjectContext(workspace)).toEqual({
      claudeMd: null,
      agentsMd: null,
      hasBeads: false,
    });
  });

  it("detects a beads tracker directory", () => {
    mkdirSync(resolve(workspace, ".beads"));
    expect(loadProjectContext(workspace).hasBeads).toBe(true);
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
    expect(
      formatProjectContext(
        { claudeMd: null, agentsMd: null, hasBeads: false },
        [],
      ),
    ).toBe("");
  });

  it("composes all three sections in order", () => {
    const out = formatProjectContext(
      { claudeMd: "# CM", agentsMd: "# AG", hasBeads: false },
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
      { claudeMd: "# CM", agentsMd: null, hasBeads: false },
      [],
    );
    expect(out).toContain("CLAUDE.md");
    expect(out).not.toContain("AGENTS.md");
    expect(out).not.toContain("Project skills");
    expect(out).not.toContain("Beads");
  });

  it("adds a read-only beads note when the repo has a tracker", () => {
    const out = formatProjectContext(
      { claudeMd: "# CM", agentsMd: null, hasBeads: true },
      [],
    );
    expect(out).toContain("Beads tracker present");
    expect(out).toContain("read-only");
    expect(out).toContain("never commit changes under `.beads/`");
  });
});
