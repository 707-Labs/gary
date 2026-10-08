import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as files from "node:fs/promises";
import { chmod, link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadSlackCredentials, SlackCredentialError } from "../../src/slack/credentials.ts";

const bot = "xoxb-offline-fixture-not-a-real-token";
const app = "xapp-offline-fixture-not-a-real-token";
const data = `SLACK_BOT_TOKEN=${bot}\nSLACK_APP_TOKEN=${app}\n`;
const dirs: string[] = [];
async function fixture(contents: string | Uint8Array = data): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "gary-slack-fake-"))); dirs.push(dir);
  const path = join(dir, "fake-credentials");
  await writeFile(path, contents, { mode: 0o600 });
  return path;
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { force: true, recursive: true }); });

describe("Slack credentials, fake files only", () => {
  test.each([0o400, 0o600])("reads only owner-readable regular files mode %i as literal data", async mode => {
    const path = await fixture(`# Fake fixture only\r\n${data.replaceAll("\n", "\r\n")}`);
    await chmod(path, mode);
    const loaded = await loadSlackCredentials(path);
    expect(loaded).toEqual({ botToken: bot, appToken: app });
    expect(Object.isFrozen(loaded)).toBe(true);
  });
  test.each([0o644, 0o640, 0o660, 0o604, 0o700, 0o000])("rejects insecure/special mode %i", async mode => {
    const path = await fixture(); await chmod(path, mode);
    await expect(loadSlackCredentials(path)).rejects.toThrow("slack_credentials_rejected");
  });
  test("rejects another owner before reading", async () => {
    const path = await fixture();
    const uid = process.getuid!();
    const fake = spyOn(process, "getuid").mockReturnValue(uid + 1);
    try { await expect(loadSlackCredentials(path)).rejects.toThrow(SlackCredentialError); }
    finally { fake.mockRestore(); }
  });
  test("requires an owned 0700 parent even when the final file is 0600", async () => {
    const path = await fixture(); await chmod(dirname(path), 0o755);
    await expect(loadSlackCredentials(path)).rejects.toThrow(SlackCredentialError);
  });
  test("rejects a writable ancestor above a private immediate parent", async () => {
    const original = await fixture(); const ancestor = dirname(original);
    const parent = join(ancestor, "private"); await mkdir(parent, { mode: 0o700 });
    const path = join(parent, "fake-credentials"); await writeFile(path, data, { mode: 0o600 });
    await chmod(ancestor, 0o770);
    await expect(loadSlackCredentials(path)).rejects.toThrow(SlackCredentialError);
  });
  test("rejects parent symlinks and noncanonical path components", async () => {
    const path = await fixture(); const parent = dirname(path);
    const alias = `${parent}-alias`; await symlink(parent, alias); dirs.push(alias);
    for (const rejected of [join(alias, "fake-credentials"), `${parent}/./fake-credentials`, `${parent}//fake-credentials`]) {
      await expect(loadSlackCredentials(rejected)).rejects.toThrow(SlackCredentialError);
    }
  });
  test("rejects directory replacement during descriptor opening", async () => {
    const path = await fixture(); const parent = dirname(path), moved = `${parent}-moved`;
    const originalOpen = files.open;
    const replacement = spyOn(files, "open").mockImplementation(async (...args: Parameters<typeof files.open>) => {
      const handle = await originalOpen(...args);
      if (args[0] === path) {
        await rename(parent, moved); dirs.push(moved);
        await mkdir(parent, { mode: 0o700 }); await writeFile(path, data, { mode: 0o600 });
      }
      return handle;
    });
    try { await expect(loadSlackCredentials(path)).rejects.toThrow(SlackCredentialError); }
    finally { replacement.mockRestore(); }
  });
  test("rejects symlinks, hardlinks, directories, missing and relative paths", async () => {
    const path = await fixture();
    const sym = `${path}-symlink`; await symlink(path, sym);
    await expect(loadSlackCredentials(sym)).rejects.toThrow(SlackCredentialError);
    const hard = `${path}-hard`; await link(path, hard);
    await expect(loadSlackCredentials(hard)).rejects.toThrow(SlackCredentialError);
    await expect(loadSlackCredentials(path)).rejects.toThrow(SlackCredentialError);
    const directory = `${path}-directory`; await mkdir(directory, { mode: 0o700 });
    for (const rejected of [directory, `${path}-missing`, "fake-credentials", `${path}\0`]) {
      await expect(loadSlackCredentials(rejected)).rejects.toThrow(SlackCredentialError);
    }
  });
  test.each([
    "", `${data}SLACK_BOT_TOKEN=${bot}\n`, `SLACK_BOT_TOKEN=${bot}\n`, `${data}OTHER_TOKEN=fake\n`,
    `export SLACK_BOT_TOKEN=${bot}\nSLACK_APP_TOKEN=${app}\n`,
    `SLACK_BOT_TOKEN='${bot}'\nSLACK_APP_TOKEN=${app}\n`,
    `SLACK_BOT_TOKEN=$(echo fake)\nSLACK_APP_TOKEN=${app}\n`,
    `SLACK_BOT_TOKEN=\u0024FAKE_TOKEN\nSLACK_APP_TOKEN=${app}\n`,
    `SLACK_BOT_TOKEN=${app}\nSLACK_APP_TOKEN=${bot}\n`,
    `SLACK_BOT_TOKEN=${bot} #comment\nSLACK_APP_TOKEN=${app}\n`,
    `SLACK_BOT_TOKEN=${bot}\nSLACK_APP_TOKEN=${app}\0\n`, "a".repeat(8193),
  ])("rejects ambiguous, executable, incomplete or oversized data %#", async contents => {
    const path = await fixture(contents);
    await expect(loadSlackCredentials(path)).rejects.toThrow(SlackCredentialError);
  });
  test("rejects invalid UTF-8 and never exposes paths, tokens or native error text", async () => {
    const path = await fixture(new Uint8Array([0xff, 0xfe]));
    try { await loadSlackCredentials(path); throw new Error("expected rejection"); }
    catch (error) {
      expect(error).toBeInstanceOf(SlackCredentialError);
      expect(String(error)).toBe("SlackCredentialError: slack_credentials_rejected");
      expect(JSON.stringify(error)).not.toContain(path);
      expect(JSON.stringify(error)).not.toContain(bot);
      expect(JSON.stringify(error)).not.toContain(app);
    }
  });
});
