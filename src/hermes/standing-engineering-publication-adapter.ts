/** Host composition only. Construction performs no I/O and exposes no tool.
 * Funding authority is supplied by the real host allocator; a receipt-shaped
 * object or a coding-pool balance does not establish CI authority. */
import type { Database } from 'bun:sqlite';
import type { GitHubClient } from '../adapters/github.ts';
import type { LinearAdapter } from '../adapters/linear.ts';
import { createStandingPublicationGitHub, publishStandingEngineeringDraft, readStandingPublicationTarget,
  type StandingPublicationAuthority, type StandingPublicationBinding, type StandingPublicationReceipt,
  type StandingPublicationTarget, type VerifiedStandingPublicationArtifact } from './standing-engineering-publication.ts';

export interface StandingEngineeringPublicationInput {
  proof: unknown;
  assertOwner(): void;
  signal: AbortSignal;
  deadlineMs: number;
}
export interface StandingEngineeringPublicationAdapter {
  publish(input: StandingEngineeringPublicationInput): Promise<StandingPublicationReceipt>;
  /** Lookup alone confers no authority. Runtime must bind an authenticated
   * explicit continuation to this exact target before preparing a workspace. */
  lookup(publicationId: string): StandingPublicationTarget;
}
export interface StandingEngineeringPublicationAdapterOptions {
  db: Database;
  github: Pick<GitHubClient, 'engineeringInstallationCredential' | 'openPullRequest'>;
  app: { appId: number; installationId: number };
  linear?: Pick<LinearAdapter, 'postComment'>;
  verifyArtifact(proof: unknown): VerifiedStandingPublicationArtifact;
  /** Must revalidate the genuine funded CI hold and exact runner/workflow scope
   * for both push and PR events. Reserve idempotently for this artifact binding.
   * Missing funding is a specific publication blocker, not a per-task approval. */
  authorizePublication(binding: StandingPublicationBinding, input: StandingEngineeringPublicationInput): Promise<StandingPublicationAuthority>;
  fetch?: typeof fetch;
  now?: () => number;
}
function fail(code: string): never { throw new Error('standing_publication:' + code); }

export function createStandingEngineeringPublicationAdapter(options: StandingEngineeringPublicationAdapterOptions): StandingEngineeringPublicationAdapter {
  const app = Object.freeze({ ...options.app }), now = options.now ?? Date.now;
  if (!options.github.engineeringInstallationCredential || !Number.isSafeInteger(app.appId) || app.appId <= 0
      || !Number.isSafeInteger(app.installationId) || app.installationId <= 0) fail('app_required');
  return Object.freeze({
    lookup(publicationId: string) { return readStandingPublicationTarget(options.db, publicationId); },
    async publish(raw: StandingEngineeringPublicationInput) {
      const input = Object.freeze({ ...raw });
      if (!Number.isSafeInteger(input.deadlineMs)) fail('deadline');
      const guard = () => { input.assertOwner(); input.signal.throwIfAborted(); if (now() >= input.deadlineMs) fail('deadline'); };
      guard();
      // No cancellation support is assumed for the canonical Linear SDK. A
      // deadline/abort after dispatch is an unknown outcome and remains latched
      // by the publication journal. Late completion cannot trigger another step.
      const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
        guard(); let timer: ReturnType<typeof setTimeout> | undefined;
        let abort: (() => void) | undefined;
        try {
          const stop = new Promise<never>((_, reject) => {
            abort = () => reject(new Error('standing_publication:delivery_unknown'));
            input.signal.addEventListener('abort', abort, { once: true });
            timer = setTimeout(abort, Math.max(1, Math.min(15_000, input.deadlineMs - now())));
          });
          guard(); const result = await Promise.race([operation(), stop]); guard(); return result;
        } finally {
          if (timer) clearTimeout(timer);
          if (abort) input.signal.removeEventListener('abort', abort);
        }
      };
      const github = createStandingPublicationGitHub(options.github, app, options.fetch, {
        assertOwner: guard, signal: input.signal, deadlineMs: input.deadlineMs, now });
      return publishStandingEngineeringDraft({ db: options.db, proof: input.proof,
        verifyArtifact: options.verifyArtifact, assertOwner: guard, now, github,
        authorizePublication: binding => bounded(() => options.authorizePublication(binding, input)),
        ...(options.linear ? { linear: { postComment: (issueId: string, body: string) =>
          bounded(() => options.linear!.postComment(issueId, body)) } } : {}),
      });
    },
  });
}
