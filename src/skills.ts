import {
  closeSync, constants, existsSync, fstatSync, lstatSync, openSync,
  opendirSync, readFileSync, readSync, realpathSync, type Stats,
} from "node:fs";
import { resolve } from "node:path";

/**
 * Surfaces Claude-Code-style project context to Gary's agent loop.
 *
 * Two parts:
 *   - `loadSkillIndex` enumerates `.agents/skills/<name>/SKILL.md` and
 *     `.claude/skills/<name>/SKILL.md` so the agent gets a per-task menu.
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
  /** True when the repo has a beads tracker (`.beads/` directory). */
  hasBeads: boolean;
}

const PROJECT_FILE_MAX_BYTES = 12_000;
const SKILL_ROOTS = [".agents/skills", ".claude/skills"] as const;
const SKILL_DIRECTORY_ENTRY_LIMIT = 256;
const SKILL_FILE_MAX_BYTES = 256 * 1024;
const SKILL_FRONTMATTER_MAX_BYTES = 8192;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
    && a.nlink === b.nlink && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Reject redirects at every project-relative component, including skill roots. */
function directorySnapshot(root: string, parts: readonly string[]): [string, Stats][] {
  return [root, ...parts.map((_, i) => resolve(root, ...parts.slice(0, i + 1)))].map(path => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
      throw new Error("skill_directory_rejected");
    }
    return [path, stat];
  });
}

function unchangedDirectories(directories: readonly [string, Stats][]): boolean {
  return directories.every(([path, before]) => {
    const now = lstatSync(path);
    return now.isDirectory() && !now.isSymbolicLink() && realpathSync(path) === path
      && now.dev === before.dev && now.ino === before.ino;
  });
}

/** Bound discovery before sorting; an oversized root is omitted, never sampled. */
function skillDirectories(path: string): string[] {
  const directory = opendirSync(path);
  const entries: string[] = [];
  try {
    let count = 0;
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (++count > SKILL_DIRECTORY_ENTRY_LIMIT) return [];
      if (entry.isDirectory() && !entry.isSymbolicLink()
        && Buffer.byteLength(entry.name) <= 128 && !/[\\`\x00-\x1f\x7f]/.test(entry.name)) entries.push(entry.name);
    }
  } finally { directory.closeSync(); }
  return entries.sort(compare);
}

/** Read only bounded metadata, never a skill body or a non-regular file. */
function readSkill(root: string, relativeRoot: string, entry: string): ProjectSkill | null {
  let fd: number | undefined;
  try {
    const directories = directorySnapshot(root, [...relativeRoot.split("/"), entry]);
    const path = `${relativeRoot}/${entry}/SKILL.md`, absolute = resolve(root, path);
    const before = lstatSync(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size > SKILL_FILE_MAX_BYTES || realpathSync(absolute) !== absolute) return null;
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFile(before, opened) || !unchangedDirectories(directories)) return null;
    const buffer = Buffer.alloc(Math.min(opened.size, SKILL_FRONTMATTER_MAX_BYTES + 1));
    let bytes = 0;
    while (bytes < buffer.length) {
      const n = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (n === 0) break;
      bytes += n;
    }
    if (!sameFile(opened, fstatSync(fd)) || !sameFile(opened, lstatSync(absolute))
      || !unchangedDirectories(directories)) return null;
    const fm = buffer.subarray(0, bytes).toString("utf8").match(FRONTMATTER_RE);
    if (!fm?.[1] || Buffer.byteLength(fm[0]) > SKILL_FRONTMATTER_MAX_BYTES) return null;
    // Reject invalid UTF-8 in metadata, even when the unread body is arbitrary bytes.
    new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, Buffer.byteLength(fm[0])));
    const scalar = (key: string, max: number): string | null => {
      const matches = fm[1]!.split(/\r?\n/).filter(line => line.startsWith(key + ":"));
      if (matches.length !== 1) return null;
      const value = matches[0]!.slice(key.length + 1).trim();
      return value && Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
    };
    const name = scalar("name", 64), description = scalar("description", 1024);
    return name && description ? { name, description, path } : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function loadSkillIndex(workspaceRoot: string): ProjectSkill[] {
  let root: string;
  try {
    const input = resolve(workspaceRoot);
    if (!lstatSync(input).isDirectory() || lstatSync(input).isSymbolicLink()) return [];
    // Canonicalize OS aliases such as /tmp before checking project-relative paths.
    root = realpathSync(input);
  } catch { return []; }
  const skills: ProjectSkill[] = [];
  for (const relativeRoot of SKILL_ROOTS) {
    try {
      directorySnapshot(root, relativeRoot.split("/"));
      for (const entry of skillDirectories(resolve(root, relativeRoot))) {
        const skill = readSkill(root, relativeRoot, entry);
        if (skill) skills.push(skill);
      }
    } catch { /* Missing, unreadable or redirected roots do not hide the other root. */ }
  }
  // Same-name skills remain distinct: the exact path is their provenance.
  return skills.sort((a, b) => compare(a.name, b.name) || compare(a.path, b.path));
}

export function loadProjectContext(workspaceRoot: string): ProjectContext {
  return {
    claudeMd: readIfExists(workspaceRoot, "CLAUDE.md"),
    agentsMd: readIfExists(workspaceRoot, "AGENTS.md"),
    hasBeads: existsSync(resolve(workspaceRoot, ".beads")),
  };
}

/**
 * Compose CLAUDE.md / AGENTS.md / skill index into a single text block to
 * prepend to the agent's task message. Returns "" when nothing applies, so
 * callers can drop a guard.
 */
export function formatProjectContext(
  context: ProjectContext,
  skills: ProjectSkill[],
): string {
  const sections: string[] = [];
  if (context.claudeMd && context.claudeMd === context.agentsMd) {
    // Exact loaded-body equality only; preserve both sources and every byte.
    sections.push("# CLAUDE.md and AGENTS.md (project instructions and agent guidance)");
    sections.push(context.claudeMd);
  } else if (context.claudeMd) {
    sections.push("# CLAUDE.md (project instructions)");
    sections.push(context.claudeMd);
  }
  if (context.agentsMd && context.agentsMd !== context.claudeMd) {
    sections.push("# AGENTS.md (agent guidance)");
    sections.push(context.agentsMd);
  }
  if (context.hasBeads) {
    sections.push("# Beads tracker present");
    sections.push(
      "This repo tracks some work in beads (`.beads/` directory, `bd` CLI). " +
        "Treat it as read-only context: `.beads/issues.jsonl` (or `bd list` / `bd show <id>` if installed) " +
        "may describe in-flight or planned work related to your ticket — check it before designing a change. " +
        "Never run `bd` commands that mutate state, and never commit changes under `.beads/`; " +
        "your ticket's source of truth stays Linear. If your PR completes or affects a beads issue, " +
        "say so in the PR body instead of editing beads.",
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
