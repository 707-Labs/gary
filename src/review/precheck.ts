export type PrecheckKind = "untested_export" | "unwired_identifier";

export interface PrecheckFinding {
  kind: PrecheckKind;
  name: string;
  file: string;
  line?: number;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export type GrepFn = (pattern: string, pathGlob?: string) => Promise<readonly GrepMatch[]>;

export interface FindUntestedExportsArgs {
  diff: string;
  grep: GrepFn;
  skipPrefixes?: readonly string[];
}

interface AddedExport { name: string; file: string }

const DEFAULT_SKIP_PREFIXES: readonly string[] = ["test/", "tests/"];

const EXPORT_PATTERNS: readonly RegExp[] = [
  /^\+\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\+\s*export\s+class\s+([A-Za-z_$][\w$]*)/,
  /^\+\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^\+\s*export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\+\s*export\s+default\s+class\s+([A-Za-z_$][\w$]*)/,
];

export function parseAddedExports(
  diff: string,
  skipPrefixes: readonly string[] = DEFAULT_SKIP_PREFIXES,
): AddedExport[] {
  const lines = diff.split("\n");
  const out: AddedExport[] = [];
  let currentFile: string | null = null;
  for (const line of lines) {
    if (line.startsWith("+++ b/")) { currentFile = line.slice("+++ b/".length); continue; }
    if (line.startsWith("--- ") || line.startsWith("diff --git ")) continue;
    if (currentFile === null) continue;
    if (skipPrefixes.some((p) => currentFile!.startsWith(p))) continue;
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const pattern of EXPORT_PATTERNS) {
      const m = line.match(pattern);
      if (m && m[1]) { out.push({ name: m[1], file: currentFile }); break; }
    }
  }
  return out;
}

export async function findUntestedExports(args: FindUntestedExportsArgs): Promise<PrecheckFinding[]> {
  const exports = parseAddedExports(args.diff, args.skipPrefixes);
  const findings: PrecheckFinding[] = [];
  for (const exp of exports) {
    const matches = await args.grep(exp.name, "test/**/*.ts");
    if (matches.length === 0) {
      findings.push({ kind: "untested_export", name: exp.name, file: exp.file });
    }
  }
  return findings;
}

export interface FindUnwiredIdentifiersArgs {
  diff: string;
  grep: GrepFn;
}

interface AddedIdentifier { name: string; file: string }

// Identifier shapes we care about: query params and dotted event/topic names.
// Deliberately narrow — a quoted lowercase string isn't enough on its own
// because the codebase is full of error codes, CSS classes, and one-off
// labels. Requiring `=` (query param) or `.` (dotted name) gives much higher
// signal at the cost of missing flat snake_case event names. False negatives
// here are tolerable; false positives flood the reviewer's context.
const IDENTIFIER_PATTERNS: readonly RegExp[] = [
  /[?&]([a-z][a-z0-9_-]{2,}=[a-z0-9_-]{2,})/gi,
  /["']([a-z][a-z0-9_-]{2,}(?:\.[a-z][a-z0-9_-]{2,})+)["']/gi,
];

const STOPWORDS = new Set(["true", "false", "null", "undefined", "none", "default"]);

function looksGenericName(s: string): boolean {
  if (STOPWORDS.has(s.toLowerCase())) return true;
  if (/^[0-9.]+$/.test(s)) return true;
  if (s.length < 4) return true;
  return false;
}

export function parseAddedIdentifiers(diff: string): AddedIdentifier[] {
  const lines = diff.split("\n");
  const out: AddedIdentifier[] = [];
  const seen = new Set<string>();
  let currentFile: string | null = null;
  for (const line of lines) {
    if (line.startsWith("+++ b/")) { currentFile = line.slice("+++ b/".length); continue; }
    if (line.startsWith("--- ") || line.startsWith("diff --git ")) continue;
    if (currentFile === null) continue;
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const pattern of IDENTIFIER_PATTERNS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(line)) !== null) {
        const name = m[1]!;
        if (looksGenericName(name)) continue;
        const key = `${currentFile}::${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name, file: currentFile });
      }
    }
  }
  return out;
}

export async function findUnwiredIdentifiers(args: FindUnwiredIdentifiersArgs): Promise<PrecheckFinding[]> {
  const ids = parseAddedIdentifiers(args.diff);
  const findings: PrecheckFinding[] = [];
  for (const id of ids) {
    const matches = await args.grep(id.name);
    const otherFiles = new Set<string>();
    for (const m of matches) if (m.path !== id.file) otherFiles.add(m.path);
    if (otherFiles.size === 0) {
      findings.push({ kind: "unwired_identifier", name: id.name, file: id.file });
    }
  }
  return findings;
}
