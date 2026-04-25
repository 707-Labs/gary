import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// voice.md sits at the project root. Load once at module init; the spec
// says changes take effect on process restart.
const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");
const VOICE_PATH = resolve(PROJECT_ROOT, "voice.md");

let voiceCache: string | null = null;

export function loadVoice(): string {
  if (voiceCache !== null) return voiceCache;
  voiceCache = readFileSync(VOICE_PATH, "utf8");
  return voiceCache;
}

/** Compose: voice.md + task instructions + ticket/PR context. Verbatim — no
 * paraphrasing per spec §5. */
export function composeSystemPrompt(args: {
  taskInstructions: string;
  context?: string;
}): string {
  const parts = [loadVoice().trim(), "---", args.taskInstructions.trim()];
  if (args.context && args.context.trim().length > 0) {
    parts.push("---", args.context.trim());
  }
  return parts.join("\n\n");
}
