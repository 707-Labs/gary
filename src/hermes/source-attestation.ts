/**
 * Read-only, offline source attestation. Scope is exactly the candidate wrapper
 * plus every entry of the extracted Hermes archive; no extension/ignore rules.
 * The digest covers sorted UTF-8 relative names, types, executable bits, sizes
 * and SHA-256 file bytes. SOURCE.json is neither included nor trusted.
 *
 * inspectSourceAttestation() produces REVIEW MATERIAL ONLY. Verification requires
 * a digest supplied by a trusted reviewer, never one learned from SOURCE.json,
 * an adjacent manifest, or the current tree in the same activation operation.
 *
 * This is not an immutable snapshot. Detected races fail closed, but a trusted
 * host can mutate source after verification, including through a read-only
 * container bind. Before cutover, build from a reviewed archive/wrapper in a
 * case-sensitive environment and use an immutable copied artifact/image.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export const SOURCE_ATTESTATION_SCOPE = "gary-hermes-wrapper-and-archive-v1";
export type SourceEntry = Readonly<{ path: string; type: "directory" } | {
  path: string; type: "file"; size: number; executable: boolean; sha256: string;
}>;
export interface SourceAttestation {
  readonly scope: typeof SOURCE_ATTESTATION_SCOPE;
  readonly digest: string;
  readonly files: number;
  readonly bytes: number;
  readonly entries: readonly SourceEntry[];
}
const MAX_ENTRIES = 50_000;
const MAX_TOTAL_BYTES = 1_073_741_824;
const MAX_FILE_BYTES = 134_217_728;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const sameNode = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const sortNames = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
function fault(code: string): never { throw new Error("source_attestation:" + code); }
function stat(path: string): BigIntStats {
  try { return lstatSync(path, { bigint: true }); } catch { return fault("missing_or_unreadable_entry"); }
}
function directory(path: string): BigIntStats {
  const metadata = stat(path);
  if (metadata.isSymbolicLink()) fault("symlink_denied");
  if (!metadata.isDirectory()) fault("directory_required");
  return metadata;
}
function names(path: string): string[] {
  try {
    return readdirSync(path, { encoding: "buffer" }).map(raw => {
      const name = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      if (!name || name === "." || name === ".." || /[\x00-\x1f\x7f/\\]/.test(name)) fault("unsafe_entry_name");
      return name;
    }).sort(sortNames);
  } catch { return fault("invalid_directory_entries"); }
}

/** Deterministic observation only: never an approval and never writes the source. */
export function inspectSourceAttestation(root: string): SourceAttestation {
  if (typeof root !== "string" || !isAbsolute(root) || root !== resolve(root) || /[\x00-\x1f\x7f]/.test(root)) fault("canonical_absolute_root_required");
  directory(root);
  try { if (realpathSync(root) !== root) fault("canonical_absolute_root_required"); }
  catch { fault("canonical_absolute_root_required"); }
  const entries: SourceEntry[] = [];
  let files = 0, bytes = 0;
  const add = (entry: SourceEntry) => {
    if (entries.length >= MAX_ENTRIES) fault("entry_limit");
    entries.push(Object.freeze(entry));
  };
  const inspect = (name: string): void => {
    const path = join(root, name);
    if (relative(root, path) !== name || name.length > 4096 || isAbsolute(name)
        || name.split("/").some(part => part === ".." || part === "." || !part)) fault("out_of_tree_path");
    const before = stat(path);
    if (before.isSymbolicLink()) fault("symlink_denied");
    if (before.isDirectory()) {
      add({ path: name, type: "directory" });
      const beforeNames = names(path);
      for (const child of beforeNames) inspect(name + "/" + child);
      if (!sameNode(before, stat(path)) || JSON.stringify(beforeNames) !== JSON.stringify(names(path))) fault("source_changed_during_read");
      return;
    }
    if (!before.isFile()) fault("nonregular_entry_denied");
    // Hard links can alias an external writable source without a symlink.
    if (before.nlink !== 1n) fault("hardlink_denied");
    if (before.size > BigInt(MAX_FILE_BYTES) || before.size < 0n) fault("file_size_limit");
    const size = Number(before.size);
    if (bytes + size > MAX_TOTAL_BYTES) fault("total_size_limit");
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { return fault("file_open_rejected"); }
    try {
      if (!sameNode(before, fstatSync(fd, { bigint: true }))) fault("source_changed_during_read");
      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(65_536);
      let readBytes = 0;
      for (;;) {
        const count = readSync(fd, chunk, 0, chunk.length, null);
        if (count === 0) break;
        readBytes += count;
        if (readBytes > size) fault("source_changed_during_read");
        hash.update(chunk.subarray(0, count));
      }
      if (readBytes !== size || !sameNode(before, fstatSync(fd, { bigint: true })) || !sameNode(before, stat(path))) fault("source_changed_during_read");
      add({ path: name, type: "file", size, executable: (before.mode & 0o111n) !== 0n, sha256: hash.digest("hex") });
      files++; bytes += size;
    } finally { closeSync(fd); }
  };
  // Ancestor directories are checked even where their unrelated children are
  // outside scope. The Python wrapper does not import sibling fixture scripts.
  const python = directory(join(root, "python"));
  const vendor = directory(join(root, "vendor"));
  inspect("python/gary_runtime.py");
  inspect("vendor/hermes");
  if (!sameNode(python, stat(join(root, "python"))) || !sameNode(vendor, stat(join(root, "vendor")))) fault("source_changed_during_read");
  entries.sort((a, b) => sortNames(a.path, b.path));
  const records = entries.map(entry => entry.type === "directory" ? ["directory", entry.path]
    : ["file", entry.path, entry.size, entry.executable ? 1 : 0, entry.sha256]);
  const digest = "sha256:" + sha256(SOURCE_ATTESTATION_SCOPE + "\0" + JSON.stringify(records));
  return Object.freeze({ scope: SOURCE_ATTESTATION_SCOPE, digest, files, bytes, entries: Object.freeze(entries) });
}

/** expectedDigest must come from the external review/approval boundary. */
export function verifySourceAttestation(root: string, expectedDigest: string): SourceAttestation {
  if (typeof expectedDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(expectedDigest)) fault("external_expected_digest_required");
  const observation = inspectSourceAttestation(root);
  if (!timingSafeEqual(Buffer.from(observation.digest), Buffer.from(expectedDigest))) fault("digest_mismatch");
  return observation;
}

if (import.meta.main) {
  const [mode, root, expected, ...extra] = process.argv.slice(2);
  if (!root || extra.length || (mode !== "inspect" && mode !== "verify") || (mode === "inspect" && expected !== undefined)
      || (mode === "verify" && expected === undefined)) {
    process.stderr.write("usage: source-attestation.ts inspect ROOT | verify ROOT EXTERNALLY_APPROVED_SHA256\n");
    process.exitCode = 2;
  } else {
    try {
      const result = mode === "inspect" ? inspectSourceAttestation(root) : verifySourceAttestation(root, expected!);
      process.stdout.write(JSON.stringify({ status: mode === "inspect" ? "review-only-unapproved" : "matches-supplied-digest", ...result }) + "\n");
    } catch (error) {
      process.stderr.write(error instanceof Error && error.message.startsWith("source_attestation:") ? error.message + "\n" : "source_attestation:read_failed\n");
      process.exitCode = 1;
    }
  }
}
