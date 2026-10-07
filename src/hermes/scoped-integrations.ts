/** Credentials and adapter objects stay in the trusted host, never in a manifest. */
import type { LinearAdapter } from '../adapters/linear.ts';
import type { GitHubClient } from '../adapters/github.ts';
import type { CloudflareClient, QueryArgs } from '../adapters/cloudflare.ts';
import type { ToolsetOptions, SubagentRunnerResult } from '../agent/tools.ts';
import { fetchPublicUrl, validatePublicHttpUrl, type PublicFetchGuards } from '../safe-fetch.ts';
import type { DeadlineOptions } from '../deadline.ts';

export const INTEGRATION_TOOL_NAMES = ['fetch_url', 'get_linear_issue', 'unassign_self',
  'set_ticket_state', 'update_ticket_description', 'get_pr', 'query_cloudflare_logs',
  'list_cloudflare_invocations', 'd1_query', 'dispatch_subagent'] as const;

export interface ScopedIntegrationBindings {
  linear?: {
    client: Pick<LinearAdapter, 'fetchByIdentifier' | 'fetchComments' | 'unassign' | 'setStateByType' | 'updateDescription'>;
    /** Current and referenced tickets must be admitted by the host, not by tool arguments. */
    readIdentifiers: readonly string[];
    currentIssue?: { id: string; identifier: string; teamId: string };
  };
  github?: { client: Pick<GitHubClient, 'getPullRequestDetail'>; defaultRepo: string };
  cloudflare?: {
    client: Pick<CloudflareClient, 'queryLogs' | 'listInvocations' | 'queryD1'>;
    allowedServices: readonly string[];
    allowedDatabases: readonly string[];
  };
  publicFetch?: {
    policy: { kind: 'public' } | { kind: 'origins'; origins: readonly string[] } | { kind: 'urls'; urls: readonly string[] };
    /** Optional offline transport seams; authorization/DNS safety checks still run. */
    transport?: Pick<PublicFetchGuards, 'resolve' | 'fetch'>;
  };
  /** The host must bind recursion, read-only execution, and the parent's spending ledger. */
  subagentRunner?: (task: string, signal?: AbortSignal) => Promise<SubagentRunnerResult>;
}

export class IntegrationScopeError extends Error {
  constructor() { super('integration_scope_denied'); }
}
const deny = (): never => { throw new IntegrationScopeError(); };
const identifier = /^[A-Z]+-\d+$/;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const nonempty = (s: string) => typeof s === 'string' && s.length > 0 && s.length <= 512 && !/[\x00-\x1f]/.test(s);
function scopeSet(values: readonly string[], valid: (s: string) => boolean): Set<string> {
  if (!Array.isArray(values) || values.length > 256 || values.some(s => !valid(s)) || new Set(values).size !== values.length) {
    throw new Error('invalid integration scope');
  }
  return new Set(values);
}

/** Reject mutating CTE/PRAGMA forms that the legacy prefix-only check accepts. */
export function assertScopedReadOnlySql(sql: string): void {
  if (sql.length > 65_536) deny();
  // Strip quoted literal/identifier contents and comments before examining keywords.
  const tokens = sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:[^\]])*\]|\/\*[\s\S]*?\*\/|--[^\n]*/g, ' ').trim();
  const one = tokens.replace(/;\s*$/, '');
  if (one.includes(';') || !/^(SELECT|WITH|EXPLAIN|PRAGMA)\b/i.test(one)
      || /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(one)) deny();
  if (/\bload_extension\s*\(/i.test(one)
      || (/^EXPLAIN\b/i.test(one) && !/^EXPLAIN\s+(?:QUERY\s+PLAN\s+)?(?:SELECT|WITH)\b/i.test(one))) deny();
  // Only introspection pragmas; no assignments or write-affecting connection options.
  if (/^PRAGMA\b/i.test(one) && !/^PRAGMA\s+(?:table_info|table_xinfo|index_info|index_xinfo|index_list|foreign_key_list|database_list|compile_options|integrity_check|quick_check)\s*(?:\([^;=]*\))?\s*$/i.test(one)) deny();
}

/** Returns only the limited adapter surface used by Gary's existing handlers. */
export function bindScopedIntegrations(bindings: ScopedIntegrationBindings | undefined,
  live: () => void, operation: <T>(fn: () => Promise<T>) => Promise<T>, deadline: DeadlineOptions): {
    toolset: ToolsetOptions; availableTools: readonly string[];
  } {
  const out: ToolsetOptions = {};
  const available: string[] = [];
  if (!bindings) return { toolset: out, availableTools: available };
  if (bindings.linear) {
    const { client } = bindings.linear;
    const reads = scopeSet(bindings.linear.readIdentifiers, s => identifier.test(s));
    const current = bindings.linear.currentIssue ? Object.freeze({ ...bindings.linear.currentIssue }) : undefined;
    if (current && (!nonempty(current.id) || !nonempty(current.teamId) || !identifier.test(current.identifier))) throw new Error('invalid current issue');
    const knownIssues = new Set<string>();
    const onlyCurrent = (id: string) => { if (!current || id !== current.id) deny(); };
    out.linear = {
      fetchByIdentifier: (name: string) => operation(async () => {
        if (!reads.has(name)) deny();
        const issue = await client.fetchByIdentifier(name); live();
        if (issue) {
          if (issue.identifier !== name || !nonempty(issue.id)) deny();
          if (current?.identifier === name && issue.id !== current.id) deny();
          knownIssues.add(issue.id);
        }
        return issue;
      }),
      fetchComments: (id: string, limit: number) => operation(() => {
        if (!knownIssues.has(id)) deny();
        return client.fetchComments(id, Math.min(limit, 10));
      }),
      unassign: (id: string) => operation(() => { onlyCurrent(id); return client.unassign(id); }),
      updateDescription: (id: string, text: string) => operation(() => { onlyCurrent(id); return client.updateDescription(id, text); }),
      setStateByType: (id: string, teamId: string, type: Parameters<LinearAdapter['setStateByType']>[2]) => operation(() => {
        onlyCurrent(id); if (teamId !== current!.teamId) deny();
        // Legacy setStateByType checks this signal between its state lookup and mutation.
        // The accessor adds owner checks at that exact boundary without duplicating the handler.
        const guardedDeadline: DeadlineOptions = {
          get deadlineMs() { live(); return deadline.deadlineMs!; },
          get signal() { live(); return deadline.signal!; },
        };
        return client.setStateByType(id, teamId, type, guardedDeadline);
      }),
    } as LinearAdapter;
    available.push('get_linear_issue');
    if (current) {
      out.currentIssue = current;
      available.push('unassign_self', 'set_ticket_state', 'update_ticket_description');
    }
  }
  if (bindings.github) {
    const { client, defaultRepo } = bindings.github;
    if (!repoPattern.test(defaultRepo) || defaultRepo.split('/').some(s => s === '.' || s === '..')) throw new Error('invalid repository scope');
    out.defaultRepo = defaultRepo;
    out.github = { getPullRequestDetail: (owner: string, repo: string, number: number) => operation(() => {
      if (`${owner}/${repo}` !== defaultRepo) deny();
      return client.getPullRequestDetail(owner, repo, number);
    }) } as GitHubClient;
    available.push('get_pr');
  }
  if (bindings.cloudflare) {
    const { client } = bindings.cloudflare;
    const services = scopeSet(bindings.cloudflare.allowedServices, nonempty);
    const databases = scopeSet(bindings.cloudflare.allowedDatabases, nonempty);
    // An omitted service fans out only over the explicit task allowlist. Each await
    // has an ownership check, so a revoked first request cannot start the second.
    const scopedLogs = async <T extends { service: string }>(args: QueryArgs, call: (args: QueryArgs) => Promise<T[]>): Promise<T[]> => {
      const names = args.service === undefined ? [...services] : [args.service];
      if (!names.length || names.some(name => !services.has(name))) deny();
      const limit = Math.min(args.limit ?? 50, 200);
      const all: T[] = [];
      for (const service of names) {
        const rows = await operation(() => call({ ...args, service, limit, sinceMinutes: Math.min(args.sinceMinutes ?? 60, 10080) }));
        live();
        if (rows.some(row => row.service !== service)) deny();
        all.push(...rows.slice(0, limit - all.length));
        if (all.length >= limit) break;
      }
      return all;
    };
    out.cloudflare = {
      queryLogs: (args: QueryArgs = {}) => operation(() => scopedLogs(args, args => client.queryLogs(args))),
      listInvocations: (args: QueryArgs = {}) => operation(() => scopedLogs(args, args => client.listInvocations(args))),
      queryD1: (args: Parameters<CloudflareClient['queryD1']>[0]) => operation(async () => {
        if (!databases.has(args.database)) deny();
        assertScopedReadOnlySql(args.sql);
        const result = await client.queryD1(args); live();
        if (result.rowsWritten !== 0) deny();
        return result;
      }),
    } as CloudflareClient;
    if (services.size) available.push('query_cloudflare_logs', 'list_cloudflare_invocations');
    if (databases.size) available.push('d1_query');
  }
  if (bindings.publicFetch) {
    const { policy, transport } = bindings.publicFetch;
    const kind = policy.kind;
    if (!['public', 'origins', 'urls'].includes(kind)) throw new Error('invalid public fetch policy');
    const scopes = kind === 'public' ? undefined : scopeSet(kind === 'origins' ? policy.origins : policy.urls, value => {
      try { const url = validatePublicHttpUrl(value); return kind === 'origins' ? value === url.origin : value === url.href; } catch { return false; }
    });
    const authorizeUrl = (url: URL) => { if (scopes && !scopes.has(kind === 'origins' ? url.origin : url.href)) deny(); };
    out.fetchPublicUrl = (url, init = {}) => operation(async () => {
      const signals = [init.signal, deadline.signal].filter((signal): signal is AbortSignal => signal instanceof AbortSignal);
      const signal = signals.length ? AbortSignal.any(signals) : undefined;
      const response = await fetchPublicUrl(url, { ...init, ...(signal ? { signal } : {}) },
        { ...transport, authorizeUrl, assertActive: live });
      live();
      // Buffer a bounded body before returning to the legacy handler's .text().
      // No response can smuggle an unbounded stream into the model or trace.
      const reader = response.body?.getReader();
      if (!reader) return response;
      const chunks: Uint8Array[] = []; let size = 0;
      const maxBytes = 200_000;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
      try {
        while (size < maxBytes) {
          live(); signal?.throwIfAborted(); const next = await reader.read(); live(); signal?.throwIfAborted();
          if (next.done) break;
          const chunk = next.value.subarray(0, maxBytes - size);
          chunks.push(chunk); size += chunk.byteLength;
        }
      } finally {
        signal?.removeEventListener('abort', cancel);
        try { await reader.cancel(); } finally { reader.releaseLock(); }
        live();
      }
      const body = Buffer.concat(chunks);
      const headers = new Headers(response.headers);
      // Reaching the bound is conservatively reported as truncation, even if the
      // server ended at exactly this byte count; no extra read can stall the task.
      if (size === maxBytes) headers.set('x-gary-body-truncated', 'true');
      return new Response(body, { status: response.status, headers });
    });
    available.push('fetch_url');
  }
  if (bindings.subagentRunner) {
    const runner = bindings.subagentRunner;
    out.subagentRunner = task => operation(() => runner(task, deadline.signal));
    available.push('dispatch_subagent');
  }
  return { toolset: out, availableTools: available };
}
