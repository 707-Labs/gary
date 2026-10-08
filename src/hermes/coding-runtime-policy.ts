/** Fixed host policy for newly admitted Hermes coding work. No I/O at import. */
import { fingerprintJson } from './audit-trace.ts';
import { CODING_VERIFICATION_POLICY } from '../verification-policy.ts';

export const HERMES_CODING_RUNTIME_POLICY = Object.freeze({
  version: 4,
  /** Parent coding workspace only; native worker and read-only children keep their own pins. */
  executor: Object.freeze({
    image: 'sha256:0efb49a8f21794948395f7bec2c15557a78473acd760207613fe7714e7c47f8c',
    bunCacheVolume: 'gary-bun-cache-20261007-node24',
    cpus: '4',
    memory: '12g',
    pidsLimit: 512,
    storybookScratch: true,
    fixedEnvironment: Object.freeze({
      PUBLIC_PARTYKIT_HOST: 'party.mulligan-labs.com',
      VITEST_MAX_WORKERS: '2',
      TMPDIR: '/workspace/node_modules/.cache/gary-preflight-tmp',
      WRANGLER_SEND_METRICS: 'false',
      DO_NOT_TRACK: '1',
      STORYBOOK_DISABLE_TELEMETRY: '1',
    }),
  }),
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  thinking: 'disabled',
  maxAllocationMicros: 10_000_000,
  actionTimeoutMs: 9_000_000,
  verification: CODING_VERIFICATION_POLICY,
  review: Object.freeze({providerOrder:Object.freeze(['deepseek'] as const),maxRounds:1,iterationCap:6,timeoutMs:180_000}),
} as const);

/** Call only after the activation's strict schema has validated the config.
 * Canonical JSON includes every configured scope/image plus the fixed runtime
 * policy. This fingerprint does not replace the ticket-state fingerprint. */
export function fingerprintHermesCodingActivation(config: unknown): string {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('invalid_coding_activation_config');
  }
  return 'sha256:' + fingerprintJson({ config, policy: HERMES_CODING_RUNTIME_POLICY }).sha256;
}
