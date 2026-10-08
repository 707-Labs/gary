/** Fixed host policy for newly admitted Hermes coding work. No I/O at import. */
import { fingerprintJson } from './audit-trace.ts';

export const HERMES_CODING_RUNTIME_POLICY = Object.freeze({
  version: 1,
  provider: 'deepseek',
  model: 'deepseek-v4-pro',
  thinking: 'disabled',
  maxAllocationMicros: 10_000_000,
  actionTimeoutMs: 900_000,
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
