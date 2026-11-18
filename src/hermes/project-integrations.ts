/** Read capabilities supplied by the trusted host. No credentials or network clients are created here. */
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { AssignedIssue, IssueComment } from '../adapters/linear.ts';
import type { ProjectAudience } from './project-assistant.ts';

export type ProjectIntegrationBinding = Readonly<{
  projectId: string; repo: string; teamKey: string; audience: Readonly<ProjectAudience>;
}>;
export type RepositoryRequest = Readonly<{ operation: 'revision' | 'read' | 'search'; path?: string; query?: string; startLine?: number }>;
export interface ProjectTicketSnapshot {
  issue: AssignedIssue; comments: readonly IssueComment[]; commentsTruncated: boolean; observedAt: string;
}
export interface ProjectIntegrations {
  ticketDetail?: (binding: ProjectIntegrationBinding, identifier: string, signal?: AbortSignal) => Promise<ProjectTicketSnapshot | null>;
  repository?: (binding: ProjectIntegrationBinding, request: RepositoryRequest, signal?: AbortSignal) => Promise<unknown>;
  /** Actual host-bound repository registrations; omitted only for a callback covering every registered project. */
  repositoryProjectIds?: readonly string[];
  controller?: (binding: ProjectIntegrationBinding, request: Readonly<{ operation: 'status' | 'handoff'; ticket?: string; requestId: string }>, signal?: AbortSignal) => Promise<unknown>;
}
export const REPOSITORY = /^707-Labs\/[a-z0-9][a-z0-9-]{0,80}$/;
export const TEAM_KEY = /^[A-Z][A-Z0-9]{1,15}$/;
export function projectTicketIdentifier(value: unknown, teamKey: string): string {
  if (typeof value !== 'string' || !TEAM_KEY.test(teamKey) || !new RegExp('^' + teamKey + '-[1-9][0-9]{0,9}$').test(value)) throw new Error('ticket_denied');
  return value;
}
export function repositoryPath(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 512 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('path_denied');
  const parts = value.split('/');
  if (isAbsolute(value) || value.includes('\\') || parts.some(p => !p || p === '.' || p === '..')
    || parts.some(p => /^(?:\.git|\.env(?:\..*)?|\.aws|\.ssh|\.npmrc|\.pypirc|secrets?|credentials?|node_modules)$/i.test(p))
    || /\.(?:pem|key|p12|pfx|sqlite|db|env)$/i.test(value)
    || !(/\.(?:md|txt|rst|ts|tsx|js|jsx|mjs|cjs|py|rs|go|swift|json|toml|ya?ml|css|html|sql|sh|graphql|svelte|vue)$/.test(value)
      || /^(?:Dockerfile|Makefile|LICENSE|NOTICE|\.gitignore)$/.test(parts.at(-1)!))) throw new Error('path_denied');
  return value;
}
export function boundedSourcePage(text: string, startLine = 1, maxBytes = 24_000) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 524_288 || text.includes('\0')
    || !Number.isSafeInteger(startLine) || startLine < 1 || startLine > 100_000) throw new Error('source_unavailable');
  const lines = text.split('\n');
  if (startLine > lines.length) throw new Error('invalid_arguments');
  const selected: string[] = []; let bytes = 0, clippedLine = false;
  for (let i = startLine - 1; i < lines.length && selected.length < 400; i++) {
    const line = lines[i]!;
    if (bytes + Buffer.byteLength(line) + 1 > maxBytes) {
      if (!selected.length) {
        let prefix = line.slice(0, maxBytes); while (Buffer.byteLength(prefix) > maxBytes) prefix = prefix.slice(0, -1);
        selected.push(prefix); clippedLine = true;
      }
      break;
    }
    selected.push(line); bytes += Buffer.byteLength(line) + 1;
  }
  const nextLine = startLine + selected.length <= lines.length ? startLine + selected.length : null;
  return { text: selected.join('\n'), startLine, nextLine, totalLines: lines.length, truncated: clippedLine || nextLine !== null, clippedLine };
}

/** Reuse the already-authorized Linear client; match the issue before fetching its comments. */
export function createLinearTicketReader(linear: Pick<import('../adapters/linear.ts').LinearAdapter, 'fetchByIdentifier' | 'fetchComments'>): NonNullable<ProjectIntegrations['ticketDetail']> {
  return async (binding, identifier, signal) => {
    signal?.throwIfAborted(); projectTicketIdentifier(identifier, binding.teamKey);
    if (!REPOSITORY.test(binding.repo)) throw new Error('ticket_denied');
    const issue = await linear.fetchByIdentifier(identifier); signal?.throwIfAborted();
    if (!issue) return null;
    if (issue.identifier !== identifier || issue.teamKey !== binding.teamKey) throw new Error('ticket_denied');
    const comments = await linear.fetchComments(issue.id, 21); signal?.throwIfAborted();
    return { issue, comments: comments.slice(0, 20), commentsTruncated: comments.length >= 21, observedAt: new Date().toISOString() };
  };
}
export interface LocalRepositoryRegistration { projectId: string; repo: string; teamKey: string; root: string }
/** Local regular Git blobs only. Host verifies the root-to-repository mapping before registration. */
export function createLocalRepositoryReader(registrations: readonly LocalRepositoryRegistration[]): NonNullable<ProjectIntegrations['repository']> {
  const registry = new Map<string, Readonly<LocalRepositoryRegistration & { dev: number; ino: number }>>();
  for (const registration of registrations) {
    if (!REPOSITORY.test(registration.repo) || !TEAM_KEY.test(registration.teamKey) || registry.has(registration.projectId)
      || !isAbsolute(registration.root) || realpathSync(registration.root) !== registration.root || !lstatSync(registration.root).isDirectory()) throw new Error('repository_registration_rejected');
    const stat = lstatSync(registration.root);
    if (stat.uid !== process.getuid?.()) throw new Error('repository_registration_rejected');
    registry.set(registration.projectId, Object.freeze({ ...registration, dev: stat.dev, ino: stat.ino }));
  }
  return async (binding, request, signal) => {
    signal?.throwIfAborted();
    const registration = registry.get(binding.projectId);
    if (!registration || registration.repo !== binding.repo || registration.teamKey !== binding.teamKey) throw new Error('source_unavailable');
    const root = registration.root;
    const stat = lstatSync(root);
    if (realpathSync(root) !== root || !stat.isDirectory() || stat.uid !== process.getuid?.()
      || stat.dev !== registration.dev || stat.ino !== registration.ino) throw new Error('source_unavailable');
    const deadline = performance.now() + 8000;
    const git = (args: string[], maxBuffer = 2_097_152): Buffer => {
      signal?.throwIfAborted();
      const timeout = Math.floor(deadline - performance.now()); if (timeout <= 0) throw new Error('source_unavailable');
      const result = spawnSync('/usr/bin/git', ['--no-pager', '--no-optional-locks', '-c', 'protocol.allow=never', '-c', 'protocol.ext.allow=never', '-C', root, ...args], {
        env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
          GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_PROTOCOL_FROM_USER: '0' },
        timeout, maxBuffer, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'],
      });
      signal?.throwIfAborted();
      if (result.error || result.status !== 0 || performance.now() > deadline) throw new Error('source_unavailable');
      return result.stdout;
    };
    const revision = git(['rev-parse', '--verify', 'HEAD^{commit}'], 1024).toString('utf8').trim();
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('source_unavailable');
    const provenance = { project: binding.projectId, repo: binding.repo, revision, source: 'local_committed_git',
      observedAt: new Date().toISOString(), upstreamFreshness: 'unverified', uncommittedChangesIncluded: false };
    if (request.operation === 'revision') return provenance;
    const entries = git(['ls-tree', '-rz', '-l', revision]).toString('utf8').split('\0').filter(Boolean);
    const files = new Map<string, { oid: string; size: number }>();
    for (const entry of entries) {
      const match = /^(100644|100755) blob ([a-f0-9]{40})\s+([0-9]+)\t([^\x00]+)$/.exec(entry);
      if (!match) continue;
      try { repositoryPath(match[4]); } catch { continue; }
      const size = Number(match[3]); if (!Number.isSafeInteger(size) || size > 524_288) continue;
      files.set(match[4]!, { oid: match[2]!, size });
    }
    const read = (path: string) => {
      const blob = files.get(path); if (!blob) throw new Error('path_denied');
      const bytes = git(['cat-file', 'blob', blob.oid], 524_289);
      const text = bytes.toString('utf8');
      if (bytes.length !== blob.size || bytes.includes(0) || !Buffer.from(text).equals(bytes)) throw new Error('source_unavailable');
      return text;
    };
    if (request.operation === 'read') {
      const path = repositoryPath(request.path);
      return { ...provenance, path, ...boundedSourcePage(read(path), request.startLine) };
    }
    if (request.operation !== 'search' || typeof request.query !== 'string' || !request.query || Buffer.byteLength(request.query) > 128) throw new Error('invalid_arguments');
    const query = request.query.toLowerCase(), matches: Array<{ path: string; line: number; text: string }> = [];
    let scannedBytes = 0, scannedFiles = 0, truncated = false;
    for (const [path, blob] of files) {
      if (scannedBytes + blob.size > 2_097_152 || scannedFiles >= 300 || performance.now() >= deadline) { truncated = true; break; }
      const text = read(path); scannedBytes += blob.size; scannedFiles++;
      if (path.toLowerCase().includes(query)) matches.push({ path, line: 0, text: 'File path matches query.' });
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && matches.length < 30; i++) if (lines[i]!.toLowerCase().includes(query)) matches.push({ path, line: i + 1, text: lines[i]!.slice(0, 500) });
      if (matches.length >= 30) { truncated = true; break; }
    }
    return { ...provenance, query: request.query, matches, scannedBytes, scannedFiles, availableFiles: files.size, truncated };
  };
}
