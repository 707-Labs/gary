/**
 * Detection logic for @mentions and pickup requests on Linear tickets.
 *
 * Strict triggers only — fuzzy matching invites Gary to grab tickets that
 * weren't really meant for him. The phrase has to look like an explicit
 * imperative aimed at him.
 *
 * Note: regex parsing uses String.match to dodge the same security-scan
 * false positive that hits `RegExp.exec` (see CLAUDE.md gotchas).
 */

// Strict patterns: @gary directly precedes the imperative verb. These match
// without any further check because the @gary adjacency is already encoded.
const STRICT_PICKUP_TRIGGERS: readonly RegExp[] = [
  /@gary[,]?\s+take\s+(this|it)\b/i,
  /@gary[,]?\s+pick\s+(this|it)\s+up\b/i,
  /@gary[,]?\s+pick\s+up\s+(this|it)\b/i,
  /@gary[,]?\s+handle\s+(this|it)\b/i,
  /@gary[,]?\s+grab\s+(this|it)\b/i,
  // Retry phrasings — re-attempt a ticket Gary previously bounced/escalated.
  /@gary[,]?\s+try\s+(this|it|that)(\s+one)?\s+again\b/i,
  /@gary[,]?\s+try\s+again\b/i,
  /@gary[,]?\s+retry\s+(this|it|that)(\s+one)?\b/i,
  /@gary[,]?\s+(take|have)\s+another\s+(look|pass|crack|shot|go)\b/i,
  /@gary[,]?\s+give\s+(this|it|that)(\s+one)?\s+another\s+(go|shot|try|pass)\b/i,
];

// Relaxed patterns: imperative verb appears anywhere with a polite/interrogative
// prefix. These only fire when @gary is also in the comment (looksLikeMention),
// otherwise "please take this approach" or "can you handle it" in unrelated
// discussion would falsely trigger pickup.
const RELAXED_PICKUP_TRIGGERS: readonly RegExp[] = [
  // "please <verb>"
  /\bplease\s+take\s+(this|it)\b/i,
  /\bplease\s+pick\s+(this|it)\s+up\b/i,
  /\bplease\s+pick\s+up\s+(this|it)\b/i,
  /\bplease\s+handle\s+(this|it)\b/i,
  /\bplease\s+grab\s+(this|it)\b/i,
  // "can you <verb>" — interrogative imperative
  /\bcan\s+you\s+take\s+(this|it)\b/i,
  /\bcan\s+you\s+pick\s+(this|it)\s+up\b/i,
  /\bcan\s+you\s+pick\s+up\s+(this|it)\b/i,
  /\bcan\s+you\s+handle\s+(this|it)\b/i,
  /\bcan\s+you\s+grab\s+(this|it)\b/i,
  // Retry phrasings
  /\bplease\s+try\s+(this|it|that)(\s+one)?\s+again\b/i,
  /\bcan\s+you\s+try\s+(this|it|that)(\s+one)?\s+again\b/i,
  /\bplease\s+retry\b/i,
  /\bcan\s+you\s+retry\b/i,
  /\bgive\s+(this|it|that)(\s+one)?\s+another\s+(go|shot|try|pass)\b/i,
];

const MENTION_PATTERN = /@gary\b/i;

export function looksLikePickup(body: string): boolean {
  for (const re of STRICT_PICKUP_TRIGGERS) {
    if (body.match(re) !== null) return true;
  }
  if (!looksLikeMention(body)) return false;
  for (const re of RELAXED_PICKUP_TRIGGERS) {
    if (body.match(re) !== null) return true;
  }
  return false;
}

export function looksLikeMention(body: string): boolean {
  return body.match(MENTION_PATTERN) !== null;
}

export interface MentionableComment {
  id: string;
  body: string;
  createdAt: string;
  userId: string | null;
}

export type MentionAnalysis =
  | { kind: "pickup"; comment: MentionableComment }
  | { kind: "mention"; comment: MentionableComment }
  | { kind: "none" };

/**
 * Scan the comment thread for the most recent allowlisted-author comment
 * that mentions Gary. Returns "pickup" if it's a strict pickup trigger,
 * "mention" if it's a general @gary, "none" otherwise.
 *
 * Comments authored by Gary or by non-allowlisted users are ignored.
 */
export function analyzeMentions(args: {
  comments: readonly MentionableComment[];
  garyUserId: string;
  allowlistedUserIds: readonly string[];
}): MentionAnalysis {
  if (args.allowlistedUserIds.length === 0) return { kind: "none" };
  const allowed = new Set(args.allowlistedUserIds);
  // Walk newest-first so the most recent intent wins.
  const sorted = [...args.comments].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  for (const c of sorted) {
    if (c.userId === args.garyUserId) continue;
    if (c.userId === null || !allowed.has(c.userId)) continue;
    if (looksLikePickup(c.body)) return { kind: "pickup", comment: c };
    if (looksLikeMention(c.body)) return { kind: "mention", comment: c };
  }
  return { kind: "none" };
}
