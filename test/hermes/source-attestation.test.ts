import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectSourceAttestation, verifySourceAttestation } from "../../src/hermes/source-attestation.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(reverse = false): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gary-source-attestation-")));
  roots.push(root);
  mkdirSync(join(root, "python")); mkdirSync(join(root, "vendor/hermes/pkg"), { recursive: true });
  const files = [["python/gary_runtime.py", "# isolated wrapper\n"], ["vendor/hermes/run_agent.py", "class AIAgent: pass\n"], ["vendor/hermes/pkg/__init__.py", "# package\n"]];
  for (const [path, content] of reverse ? [...files].reverse() : files) writeFileSync(join(root, path!), content!, { mode: 0o644 });
  return root;
}

describe("offline source attestation", () => {
  test("hashes names and file bytes deterministically independent of root and creation order", () => {
    const a = inspectSourceAttestation(fixture()), b = inspectSourceAttestation(fixture(true));
    expect(a).toEqual(b);
    expect(a.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(a.files).toBe(3);
    expect(Object.isFrozen(a)).toBe(true); expect(Object.isFrozen(a.entries)).toBe(true);
    expect(a.entries.every(Object.isFrozen)).toBe(true);
  });
  test("verifies only an externally supplied matching digest", () => {
    const root = fixture();
    // This fixture digest is an independently fixed review value, not read
    // from the candidate tree inside the verification operation.
    const expected = "sha256:8cafb31b3887b3f721e8865bf4cb84ae1df2a5a8a4ecd3beebf5ef03a04f720e";
    expect(verifySourceAttestation(root, expected).digest).toBe(expected);
  });
  test.each([undefined, null, "", "sha256:abc", "a".repeat(64), `sha256:${"A".repeat(64)}`])("rejects absent or malformed external digest %#", expected => {
    expect(() => verifySourceAttestation(fixture(), expected as string)).toThrow("external_expected_digest_required");
  });
  test("does not trust SOURCE.json or a colocated self-approved manifest", () => {
    const root = fixture(), baseline = inspectSourceAttestation(root).digest;
    writeFileSync(join(root, "vendor/hermes/run_agent.py"), "# replaced\n");
    writeFileSync(join(root, "SOURCE.json"), JSON.stringify({ hermes_revision: "trusted-looking", source_digest: inspectSourceAttestation(root).digest }));
    expect(() => verifySourceAttestation(root, baseline)).toThrow("digest_mismatch");
  });
  test.each(["changed", "added", "missing", "renamed", "empty-directory", "executable-bit"])("rejects altered source against external baseline: %s", change => {
    const root = fixture(), baseline = inspectSourceAttestation(root).digest;
    const file = join(root, "vendor/hermes/run_agent.py");
    if (change === "changed") writeFileSync(file, "class Different: pass\n");
    else if (change === "added") writeFileSync(join(root, "vendor/hermes/extra.py"), "# injected\n");
    else if (change === "missing") rmSync(file);
    else if (change === "renamed") renameSync(file, join(root, "vendor/hermes/renamed.py"));
    else if (change === "empty-directory") mkdirSync(join(root, "vendor/hermes/new-directory"));
    else chmodSync(file, 0o755);
    expect(() => verifySourceAttestation(root, baseline)).toThrow("digest_mismatch");
  });
  test.each(["wrapper", "nested-file", "nested-directory", "vendor-root", "vendor-parent", "python-parent"])("rejects symlink including ancestors: %s", kind => {
    const root = fixture(), outside = fixture();
    const path = kind === "wrapper" ? "python/gary_runtime.py" : kind === "nested-file" ? "vendor/hermes/run_agent.py"
      : kind === "nested-directory" ? "vendor/hermes/pkg" : kind === "vendor-root" ? "vendor/hermes"
      : kind === "vendor-parent" ? "vendor" : "python";
    rmSync(join(root, path), { recursive: true, force: true });
    symlinkSync(join(outside, path), join(root, path));
    expect(() => inspectSourceAttestation(root)).toThrow("symlink_denied");
  });
  test("rejects even an in-tree symlink and external hardlink", () => {
    const root = fixture();
    symlinkSync("run_agent.py", join(root, "vendor/hermes/alias.py"));
    expect(() => inspectSourceAttestation(root)).toThrow("symlink_denied");
    rmSync(join(root, "vendor/hermes/alias.py"));
    linkSync(join(root, "python/gary_runtime.py"), join(root, "hardlink-outside-scope"));
    expect(() => inspectSourceAttestation(root)).toThrow("hardlink_denied");
  });
  test("rejects noncanonical/out-of-tree roots", () => {
    const root = fixture();
    for (const input of ["relative", root + "/../" + root.split("/").at(-1), root + "/", root + "\n"]) {
      expect(() => inspectSourceAttestation(input)).toThrow("canonical_absolute_root_required");
    }
  });
  test("unrelated test artifacts are out of scope without exempting anything in Hermes", () => {
    const root = fixture(), baseline = inspectSourceAttestation(root).digest;
    writeFileSync(join(root, "python/offline_fixture.py"), "# not imported by the isolated wrapper\n");
    writeFileSync(join(root, "SOURCE.json"), "{}");
    expect(verifySourceAttestation(root, baseline).digest).toBe(baseline);
  });
});
