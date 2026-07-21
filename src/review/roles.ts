import type { ProviderName } from "../providers.ts";

/**
 * Reviewer roles. Each role is an independent pass over the same diff with
 * its own system prompt and its own provider preference.
 *
 * The split exists because a single reviewer decorrelates on model weights
 * but still shares one prompt scaffold, one tool shape, and one
 * context-assembly blind spot. Two roles with different mandates catch
 * different failure classes; running them in parallel costs wall-clock
 * nothing beyond the slower of the two.
 *
 * Ported from the pi agent library (`~/.pi/agent/agents/`):
 * `brutal-code-reviewer` → correctness, `adversarial-reviewer` → adversarial.
 */
export type ReviewRole = "correctness" | "adversarial";

export const ALL_REVIEW_ROLES: readonly ReviewRole[] = ["correctness", "adversarial"];

const KNOWN_ROLES: ReadonlySet<string> = new Set(ALL_REVIEW_ROLES);

/**
 * Parse a comma-separated role list, dropping unknown names. An empty or
 * fully-invalid list degrades to `["correctness"]` rather than to no review
 * at all — losing the reviewer entirely is a much worse failure than losing
 * one role, and this is the documented single-role escape hatch
 * (`GARY_REVIEW_ROLES=correctness`).
 */
export function parseReviewRoles(raw: string | undefined): readonly ReviewRole[] {
  if (raw === undefined) return ALL_REVIEW_ROLES;
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is ReviewRole => KNOWN_ROLES.has(s));
  const deduped = [...new Set(parsed)];
  return deduped.length > 0 ? deduped : ["correctness"];
}

/**
 * Rotate a provider order left by `n`.
 *
 * Roles run in parallel, so a role cannot observe which provider a sibling
 * role landed on and sink it the way `decorrelatedOrder` sinks the author's
 * providers. Rotating each role's order by its index gives distinct primaries
 * whenever at least two providers are unarmed, without any sequencing.
 *
 * This is a preference, not a guarantee: if arming leaves one provider
 * standing, both roles run on it. That is still strictly better than today's
 * single pass, so it is never treated as an error.
 */
export function rotateOrder<T>(order: readonly T[], n: number): readonly T[] {
  if (order.length === 0) return order;
  const shift = ((n % order.length) + order.length) % order.length;
  return [...order.slice(shift), ...order.slice(0, shift)];
}

/** Provider order for `role`, given the already-decorrelated base order. */
export function orderForRole(
  base: readonly ProviderName[],
  role: ReviewRole,
  roles: readonly ReviewRole[],
): readonly ProviderName[] {
  const idx = roles.indexOf(role);
  return rotateOrder(base, idx < 0 ? 0 : idx);
}
