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

const PICKUP_TRIGGERS: readonly RegExp[] = [
  /@gary[,]?\s+take\s+(this|it)\b/i,
  /@gary[,]?\s+pick\s+(this|it)\s+up\b/i,
  /@gary[,]?\s+handle\s+(this|it)\b/i,
  /@gary[,]?\s+grab\s+(this|it)\b/i,
];

const MENTION_PATTERN = /@gary\b/i;

export function looksLikePickup(body: string): boolean {
  return PICKUP_TRIGGERS.some((re) => body.match(re) !== null);
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
