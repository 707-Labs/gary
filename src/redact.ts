/**
 * Replace any GitHub token embedded in an `x-access-token:` URL with a
 * placeholder. Both the App installation flow and the PAT flow embed tokens
 * via `https://x-access-token:<token>@github.com/...`, so a single pattern
 * covers both. Match is intentionally narrow: only inside that URL prefix,
 * never bare strings that happen to look like tokens.
 *
 * Use at every output boundary that might log git stderr or argv:
 * - `gitMust`'s error message
 * - the structured logger's emit step (defense in depth)
 */
const TOKEN_URL = /https:\/\/x-access-token:[^@\s]+@/g;

export function redactGitHubTokens(input: string): string {
  return input.replace(TOKEN_URL, "https://x-access-token:[REDACTED]@");
}

/**
 * Apply `redactGitHubTokens` recursively to a JSON-serializable value. Used
 * by the logger so token URLs that surface inside `error` fields get
 * scrubbed before they hit stdout/stderr.
 */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") {
    return redactGitHubTokens(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v)) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactValue(v);
    }
    return out as T;
  }
  return value;
}
