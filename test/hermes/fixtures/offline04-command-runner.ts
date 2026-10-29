/** Test-only bounded process-group custody. Never used by a live executor. */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Phase = 'author' | 'verifier';
const templateFile = JSON.parse(readFileSync(join(import.meta.dir, 'offline04-command-templates.json'), 'utf8')) as {
  commands: { phase: Phase; command: string; stdin: string | null }[];
};
export function admitFixtureCommand(phase: Phase, command: string, stdin: string | undefined, base: string): void {
  if (!/^[a-f0-9]{40}$/.test(base)) throw Error('offline04_base');
  const nonces = new Set([...command.matchAll(/(?:hermes-snap-|__HERMES_CWD_)([a-f0-9]{12})(?=\.sh|__)/g)].map(m => m[1]));
  if (nonces.size > 1) throw Error('offline04_snapshot_identity');
  let normalized = command.replaceAll(base, '__BASE_COMMIT__');
  for (const nonce of nonces) normalized = normalized.replaceAll('hermes-snap-' + nonce + '.sh', 'hermes-snap-__SNAPSHOT_NONCE__.sh')
    .replaceAll('__HERMES_CWD_' + nonce + '__', '__HERMES_CWD___SNAPSHOT_NONCE____');
  if (!templateFile.commands.some(t => t.phase === phase && t.command === normalized && t.stdin === (stdin ?? null))) {
    throw Error('offline04_unreviewed_command_or_stdin');
  }
}
export interface OwnedResult { output: string; exitCode: number; groupAbsent: true; timedOut: boolean; }
export function fixtureGroupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error: any) { if (error.code === 'ESRCH') return false; throw error; }
}
export function startOwnedFixtureCommand(command: string, options: {
  cwd: string; env: Record<string, string>; stdin?: string; timeoutMs: number; maxOutputBytes?: number;
}) {
  const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', command], {
    cwd: options.cwd, env: options.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', bytes = 0, timedOut = false, uncertain = false, exited = false, completed = false;
  const max = options.maxOutputBytes ?? 1024 * 1024;
  let settled: OwnedResult | undefined;
  // Signals target only this still-unreaped child session. If the leader has
  // already exited but descendants remain, fail closed without guessing an owner.
  function stopOwned() {
    if (!child.pid || completed) return;
    if (child.exitCode !== null || child.signalCode !== null || exited) {
      if (fixtureGroupExists(child.pid)) uncertain = true;
      return;
    }
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error: any) { if (error.code !== 'ESRCH') uncertain = true; }
  }
  const completion = new Promise<OwnedResult>((resolve, reject) => {
    const timer = setTimeout(() => { timedOut = true; stopOwned(); }, options.timeoutMs);
    const uncertaintyTimer = setTimeout(() => {
      uncertain = true; stopOwned(); child.stdout.destroy(); child.stderr.destroy();
      reject(Error('offline04_command_cleanup_uncertain'));
    }, options.timeoutMs + 1500);
    function data(chunk: Buffer) {
      bytes += chunk.length;
      if (bytes > max) { timedOut = true; stopOwned(); return; }
      output += chunk.toString('utf8');
    }
    child.stdout.on('data', data); child.stderr.on('data', data);
    child.once('exit', () => { exited = true; });
    child.once('error', error => { clearTimeout(timer); clearTimeout(uncertaintyTimer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(uncertaintyTimer);
      if (uncertain || (child.pid && fixtureGroupExists(child.pid))) { reject(Error('offline04_command_cleanup_uncertain')); return; }
      completed = true; settled = { output, exitCode: code ?? 137, groupAbsent: true, timedOut };
      resolve(settled);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdin ?? '');
  });
  // Attach immediately; the session may not poll until another event-loop turn.
  void completion.catch(() => {});
  return {
    completion,
    async assertAbsent() { const result = await completion; if (!result.groupAbsent || (child.pid && fixtureGroupExists(child.pid))) throw Error('offline04_command_cleanup_uncertain'); },
    async stop() { if (!completed) stopOwned(); await this.assertAbsent(); },
    result: () => settled,
  };
}
