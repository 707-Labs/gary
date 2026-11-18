/** Executes only the fixed host-owned bootstrap against in-memory builtins.
 * No archive, package manager, filesystem operation or network is executed. */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { ENGINEERING_DEPENDENCY_SANDBOX_SCRIPT } from '../../src/hermes/engineering-dependency-bundle.ts';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
async function bootstrap(kind: 'npm' | 'bun', lifecycle = false, failAt = -1) {
  const root = '/task/dependency-bundle', filename = 'a'.repeat(64) + '.tgz';
  const sources = new Map([['package.json', Buffer.from('{"scripts":{"test":"node --test"}}')],
    [kind === 'bun' ? 'bun.lock' : 'package-lock.json', Buffer.from('synthetic lock')], [filename, Buffer.from('unexecuted archive')]]);
  const manifest = { version: 1, kind, planHash: 'b'.repeat(64), lockfileName: kind === 'bun' ? 'bun.lock' : 'package-lock.json',
    allowLifecycleScripts: lifecycle, packages: [{ url: 'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz', fileName: filename }],
    files: [...sources].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) })) };
  const raw = Buffer.from(JSON.stringify(manifest)), files = new Map([...sources].map(([name, bytes]) => [root + '/' + name, bytes]));
  files.set(root + '/manifest.json', raw);
  files.set('/workspace/package.json', sources.get('package.json')!); files.set('/workspace/' + manifest.lockfileName, sources.get(manifest.lockfileName)!);
  const events: string[] = [], calls: { bin: string; args: string[]; opts: Record<string, unknown> }[] = [];
  let mirrorHandler: ((req: unknown, res: unknown) => void) | undefined;
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const result: { exitCode?: number } = {};
  const processStub = { argv: ['node', root + '/install.cjs', sha(raw)], set exitCode(value: number) { result.exitCode = value; finish(); } };
  const mocks: Record<string, unknown> = {
    'node:fs': {
      lstatSync(path: string) { if (path === '/workspace') return { isDirectory: () => true }; const b = files.get(path); if (!b) throw Error('unexpected read'); return { isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: b.length }; },
      readFileSync(path: string) { return files.get(path); }, realpathSync(path: string) { return path; },
      mkdirSync(path: string) { events.push('mkdir:' + path); }, rmSync(path: string) { events.push('remove:' + path); },
    },
    'node:path': {}, 'node:crypto': { createHash },
    'node:child_process': { spawn(bin: string, args: string[], opts: Record<string, unknown>) {
      calls.push({ bin, args, opts }); events.push(bin + ':' + args.join(' '));
      const child = new EventEmitter(), index = calls.length - 1;
      queueMicrotask(() => child.emit('exit', index === failAt ? 1 : 0, null)); return child;
    } },
    'node:http': { createServer(handler: (req: unknown, res: unknown) => void) {
      mirrorHandler = handler; const server = new EventEmitter() as EventEmitter & Record<string, unknown>;
      server.listen = (port: number, host: string, callback: () => void) => { expect(port).toBe(0); expect(host).toBe('127.0.0.1'); events.push('mirror:start'); callback(); };
      server.address = () => ({ port: 12345 }); server.close = (callback: () => void) => { events.push('mirror:closed'); callback(); }; return server;
    } },
  };
  const prints: string[] = [];
  runInNewContext(ENGINEERING_DEPENDENCY_SANDBOX_SCRIPT, { require: (name: string) => { if (!(name in mocks)) throw Error('unexpected builtin'); return mocks[name]; },
    process: processStub, URL, console: { log: (value: string) => { prints.push(value); finish(); }, error: (value: string) => prints.push(value) } });
  await finished;
  return { calls, events, prints, result, mirrorHandler };
}
test('fixed npm bootstrap imports exact tarball into isolated cache and proves frozen offline install before optional sandbox lifecycle', async () => {
  for (const lifecycle of [false, true]) {
    const flow = await bootstrap('npm', lifecycle);
    expect(flow.calls.map(call => [call.bin, call.args])).toEqual([
      ['npm', ['cache', 'add', '/task/dependency-bundle/' + 'a'.repeat(64) + '.tgz', '--ignore-scripts', '--offline']],
      ['npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund']],
      ...(lifecycle ? [['npm', ['ci', '--offline', '--no-audit', '--no-fund']]] : []),
    ]);
    for (const call of flow.calls) { expect(call.opts.shell).toBe(false); expect(call.opts.cwd).toBe('/workspace'); expect(Object.keys(call.opts.env as object)).not.toContain('GITHUB_TOKEN'); }
    expect(JSON.parse(flow.prints[0]!).lifecycleScripts).toBe(lifecycle);
  }
});
test('fixed Bun bootstrap closes loopback mirror before removing node_modules and proving default-registry offline reinstall', async () => {
  const flow = await bootstrap('bun', true);
  expect(flow.events.indexOf('mirror:closed')).toBeLessThan(flow.events.indexOf('remove:/workspace/node_modules'));
  expect(flow.calls.map(call => call.args)).toEqual([
    ['install', '--frozen-lockfile', '--ignore-scripts', '--registry=http://127.0.0.1:12345'],
    ['install', '--frozen-lockfile', '--offline', '--ignore-scripts'], ['install', '--frozen-lockfile', '--offline'],
  ]);
  expect(JSON.parse(flow.prints[0]!).offlineInstall).toBe(true);
  for (const [method, url, headers, expected] of [
    ['GET', '/demo/-/demo-1.0.0.tgz', {}, 200], ['HEAD', '/demo/-/demo-1.0.0.tgz', {}, 200],
    ['POST', '/demo/-/demo-1.0.0.tgz', {}, 403], ['GET', '/secret', {}, 403],
    ['GET', '/demo/-/demo-1.0.0.tgz', { 'content-length': '12' }, 403],
  ] as const) {
    let status = 0; flow.mirrorHandler!({ method, url, headers }, { writeHead(value: number) { status = value; }, end() {} }); expect(status).toBe(expected);
  }
});
test('failed install never advances to lifecycle or a successful evidence receipt', async () => {
  for (const kind of ['npm', 'bun'] as const) {
    const flow = await bootstrap(kind, true, 0);
    expect(flow.result.exitCode).toBe(1); expect(flow.calls).toHaveLength(1); expect(flow.prints).toEqual(['dependency_sandbox:failed']);
    if (kind === 'bun') expect(flow.events.at(-1)).toBe('mirror:closed');
  }
});
