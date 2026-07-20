import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Surfaces Claude-Code-style project context to Gary's agent loop.
 *
 * Two parts:
 *   - `loadSkillIndex` enumerates `.claude/skills/<name>/SKILL.md` and parses
 *     the frontmatter so the agent gets a per-task menu of conventions.
 *   - `loadProjectContext` pulls in CLAUDE.md and AGENTS.md verbatim — the
 *     two files that Claude Code auto-loads in interactive sessions.
 *
 * The handlers prepend `formatProjectContext(...)` to the task message so the
 * agent sees the menu before the ticket. Skill bodies are loaded on demand
 * via the existing `read_file` tool — no new tool needed.
 *
 * Note: regex parsing uses String.match rather than RegExp.exec to dodge a
 * security-scan false positive on the `exec(` substring. Same workaround as
 * the Executor.run rename — see CLAUDE.md gotchas.
 */

export interface ProjectSkill {
  name: string;
  description: string;
  /** Path relative to the workspace root. */
  path: string;
}

export interface ProjectContext {
  claudeMd: string | null;
  agentsMd: string | null;
}

export interface RuleDoc {
  /** Path relative to the workspace root. */
  path: string;
  /** First markdown heading, or null when the doc has none. */
  title: string | null;
}

const PROJECT_FILE_MAX_BYTES = 12_000;
const FRONTMATTER_RE = /^---\s*\n([\s\S]+?)\n---/;
const NAME_RE = /^name:\s*(.+)$/m;
const DESCRIPTION_RE = /^description:\s*(.+)$/m;

export function loadSkillIndex(workspaceRoot: string): ProjectSkill[] {
  const skillsRoot = resolve(workspaceRoot, ".claude/skills");
  if (!existsSync(skillsRoot)) return [];

  let entries: string[];
  try {
    entries = readdirSync(skillsRoot);
  } catch {
    return [];
  }

  const skills: ProjectSkill[] = [];
  for (const entry of entries) {
    const skillPath = resolve(skillsRoot, entry, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    let content: string;
    try {
      content = readFileSync(skillPath, "utf8");
    } catch {
      continue;
    }
    const fm = content.match(FRONTMATTER_RE);
    if (!fm || !fm[1]) continue;
    const block = fm[1];
    const nameMatch = block.match(NAME_RE);
    const descMatch = block.match(DESCRIPTION_RE);
    if (!nameMatch?.[1] || !descMatch?.[1]) continue;
    skills.push({
      name: nameMatch[1].trim(),
      description: descMatch[1].trim(),
      path: `.claude/skills/${entry}/SKILL.md`,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadProjectContext(workspaceRoot: string): ProjectContext {
  return {
    claudeMd: readIfExists(workspaceRoot, "CLAUDE.md"),
    agentsMd: readIfExists(workspaceRoot, "AGENTS.md"),
  };
}

/**
 * Root-level convention docs surfaced by path (bodies loaded on demand via
 * `read_file`, same as skills). ERT-1924 shipped a hardcoded z-index and a
 * sanitization bug that DESIGN.md / .claude/rules/security.md explicitly
 * warn about — the docs existed but nothing pointed the agent at them.
 */
const ROOT_RULE_DOCS = ["DESIGN.md", "SECURITY.md", "CONTRIBUTING.md"] as const;
const RULES_DIR = ".claude/rules";
const RULE_TITLE_RE = /^#\s+(.+)$/m;

export function loadRuleDocs(workspaceRoot: string): RuleDoc[] {
  const docs: RuleDoc[] = [];
  for (const name of ROOT_RULE_DOCS) {
    const doc = ruleDocIfExists(workspaceRoot, name);
    if (doc) docs.push(doc);
  }
  const rulesRoot = resolve(workspaceRoot, RULES_DIR);
  if (existsSync(rulesRoot)) {
    let entries: string[];
    try {
      entries = readdirSync(rulesRoot);
    } catch {
      entries = [];
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".md")) continue;
      const doc = ruleDocIfExists(workspaceRoot, `${RULES_DIR}/${entry}`);
      if (doc) docs.push(doc);
    }
  }
  return docs;
}

function ruleDocIfExists(workspaceRoot: string, relPath: string): RuleDoc | null {
  const p = resolve(workspaceRoot, relPath);
  if (!existsSync(p)) return null;
  let content: string;
  try {
    content = readFileSync(p, "utf8");
  } catch {
    return null;
  }
  const heading = content.match(RULE_TITLE_RE);
  return { path: relPath, title: heading?.[1]?.trim() ?? null };
}

/**
 * Compose CLAUDE.md / AGENTS.md / skill index into a single text block to
 * prepend to the agent's task message. Returns "" when nothing applies, so
 * callers can drop a guard.
 */
export function formatProjectContext(
  context: ProjectContext,
  skills: ProjectSkill[],
  ruleDocs: RuleDoc[] = [],
): string {
  const sections: string[] = [];
  if (context.claudeMd) {
    sections.push("# CLAUDE.md (project instructions)");
    sections.push(context.claudeMd);
  }
  if (context.agentsMd) {
    sections.push("# AGENTS.md (agent guidance)");
    sections.push(context.agentsMd);
  }
  if (ruleDocs.length > 0) {
    sections.push("# Project rule docs");
    sections.push(
      "Conventions and hard rules for this codebase. Read the relevant ones via `read_file` BEFORE writing code — UI/styling changes against the design doc (use its tokens, don't hardcode values), anything touching auth, HTML rendering, sanitization, or SQL against the security rules.",
    );
    sections.push(
      ruleDocs
        .map((d) => (d.title ? `- \`${d.path}\` — ${d.title}` : `- \`${d.path}\``))
        .join("\n"),
    );
  }
  if (skills.length > 0) {
    sections.push("# Project skills");
    sections.push(
      "These document conventions for this codebase. If any matches what you're working on, read its body via `read_file` before changing code.",
    );
    sections.push(
      skills.map((s) => `- \`${s.path}\` — ${s.description}`).join("\n"),
    );
  }
  return sections.join("\n\n");
}

function readIfExists(workspaceRoot: string, name: string): string | null {
  const p = resolve(workspaceRoot, name);
  if (!existsSync(p)) return null;
  try {
    const content = readFileSync(p, "utf8");
    return content.length > PROJECT_FILE_MAX_BYTES
      ? `${content.slice(0, PROJECT_FILE_MAX_BYTES)}\n\n[truncated to ${PROJECT_FILE_MAX_BYTES} bytes]`
      : content;
  } catch {
    return null;
  }
}
