import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export interface SlackCredentials {
  readonly botToken: string;
  readonly appToken: string;
}

/** Fixed messages only: neither paths nor credential data belong in errors. */
export class SlackCredentialError extends Error {
  readonly code = "slack_credentials_rejected";
  constructor() { super("slack_credentials_rejected"); this.name = "SlackCredentialError"; }
}

export function validSlackCredentials(value: SlackCredentials): boolean {
  return !!value && typeof value.botToken === "string" && typeof value.appToken === "string"
    && /^xoxb-[A-Za-z0-9-]{10,1024}$/.test(value.botToken)
    && /^xapp-[A-Za-z0-9-]{10,1024}$/.test(value.appToken);
}

/**
 * Reads exactly two literal KEY=value entries. No process.env lookup, dotenv,
 * quoting, expansion, shell execution, token logging, or fallback locations.
 * Requires a canonical absolute path, an owned 0700 immediate parent, and
 * root/owner-controlled directory ancestors without group/other write access.
 * The file itself must be an owned 0400/0600 regular file with one hard link.
 */
export async function loadSlackCredentials(path: string): Promise<SlackCredentials> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let bytes: Buffer | undefined;
  try {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || resolve(path) !== path
        || typeof process.getuid !== "function" || !constants.O_NOFOLLOW) throw new SlackCredentialError();
    const uid = process.getuid();
    if (await realpath(path) !== path) throw new SlackCredentialError();
    const parent = dirname(path);
    const directories: Array<{ path: string; stat: Awaited<ReturnType<typeof lstat>> }> = [];
    for (let directory = parent; ;) {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0) || (stat.mode & 0o022) !== 0
          || (directory === parent && (stat.uid !== uid || (stat.mode & 0o7777) !== 0o700))) throw new SlackCredentialError();
      directories.push({ path: directory, stat });
      const ancestor = dirname(directory);
      if (ancestor === directory) break;
      directory = ancestor;
    }
    const unchangedDirectories = async () => {
      if (await realpath(path) !== path) throw new SlackCredentialError();
      for (const expected of directories) {
        const current = await lstat(expected.path);
        if (!current.isDirectory() || current.dev !== expected.stat.dev || current.ino !== expected.stat.ino
            || current.uid !== expected.stat.uid || current.mode !== expected.stat.mode) throw new SlackCredentialError();
      }
    };
    const initial = await lstat(path);
    const secure = (stat: typeof initial) => stat.isFile() && stat.uid === uid && stat.nlink === 1
      && [0o400, 0o600].includes(stat.mode & 0o7777) && stat.size > 0 && stat.size <= 8192;
    if (!secure(initial)) throw new SlackCredentialError();
    // NOFOLLOW stops final-component substitution; NONBLOCK prevents a raced
    // FIFO/device from hanging before fstat verifies the opened descriptor.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!secure(opened) || opened.dev !== initial.dev || opened.ino !== initial.ino) throw new SlackCredentialError();
    await unchangedDirectories();
    bytes = Buffer.alloc(8193);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (!secure(after) || offset !== opened.size || after.size !== opened.size
        || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new SlackCredentialError();
    await unchangedDirectories();
    const namedFile = await lstat(path);
    if (!secure(namedFile) || namedFile.dev !== opened.dev || namedFile.ino !== opened.ino) throw new SlackCredentialError();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    const entries = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      if (line === "" || line.startsWith("#")) continue;
      const match = /^(SLACK_BOT_TOKEN|SLACK_APP_TOKEN)=([^\s]+)$/.exec(line);
      if (!match || entries.has(match[1]!)) throw new SlackCredentialError();
      entries.set(match[1]!, match[2]!);
    }
    const result = { botToken: entries.get("SLACK_BOT_TOKEN") ?? "", appToken: entries.get("SLACK_APP_TOKEN") ?? "" };
    if (entries.size !== 2 || !validSlackCredentials(result)) throw new SlackCredentialError();
    return Object.freeze(result);
  } catch {
    throw new SlackCredentialError();
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}
