import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineeringSession, createBunEngineeringCommandRunner, createMemoryEngineeringSessionJournal, validateEngineeringWorkspace,
  type EngineeringCommandRunner, type EngineeringInvocation, type EngineeringRunningCommand,
  type EngineeringSessionBinding, type EngineeringSessionJournal, type EngineeringSessionResourceProfile, type EngineeringTaskJournal } from '../../src/executors/engineering-session.ts';

// No Docker or subprocess seam is used: every command is interpreted by this fake.
const binding: EngineeringSessionBinding = { taskId: 'task-fixture', sessionId: 'session-fixture', ownerEpoch: 'epoch-1', admissionId: 'admission-fixture' };
const containerId = 'a'.repeat(64), image = `sha256:${'b'.repeat(64)}`;
const ok = { output: '', outputTruncated: false, exitCode: 0, timedOut: false };
class Process implements EngineeringRunningCommand {
  output = ''; running = true; exitCode: number | null = null; timedOut = false; stopped = false; truncated = false;
  async poll() { return { running: this.running, exitCode: this.exitCode, timedOut: this.timedOut }; }
  async read(max: number) { const output = this.output.slice(0, max); this.output = this.output.slice(max); return { output, outputTruncated: this.truncated }; }
  async stop() { this.stopped = true; this.running = false; this.exitCode ??= 137; }
}
class Runner implements EngineeringCommandRunner {
  readonly synthetic = true;
  calls: EngineeringInvocation[] = []; processes: Process[] = [];
  failCreate = false; failRemove = false; foreign = false; remains = false;
  removed = false;
  onRun?: (invocation: EngineeringInvocation) => void | Promise<void>;
  onStart?: () => void | Promise<void>;
  async run(invocation: EngineeringInvocation) {
    this.calls.push(invocation); await this.onRun?.(invocation);
    const op = invocation.argv[1];
    if (op === 'create') return this.failCreate ? { ...ok, timedOut: true } : { ...ok, output: containerId };
    if (op === 'inspect') return { ...ok, output: JSON.stringify({ Id: containerId, Config: { Labels: {
      'gary.task': this.foreign ? 'foreign-task' : binding.taskId, 'gary.session': binding.sessionId,
      'gary.owner': binding.ownerEpoch, 'gary.admission': binding.admissionId } } }) };
    if (op === 'rm') { this.removed = !this.failRemove; return { ...ok, exitCode: this.failRemove ? 1 : 0 }; }
    if (op === 'ps') return { ...ok, output: this.remains || !this.removed ? containerId : '' };
    if (op !== 'start' && op !== 'exec') throw new Error('unexpected fake control command');
    return ok;
  }
  async start(invocation: EngineeringInvocation) {
    this.calls.push(invocation); if (invocation.argv[1] !== 'exec') throw new Error('unexpected fake process');
    const process = new Process(); this.processes.push(process); await this.onStart?.(); return process;
  }
}
function setup(extra: { journal?: EngineeringSessionJournal; binding?: EngineeringSessionBinding; maxProcesses?: number; maxCommands?: number; bunCacheVolume?: string; dockerSocketPath?: string; resourceProfile?: EngineeringSessionResourceProfile } = {}) {
  const runner = new Runner(), journal = extra.journal ?? createMemoryEngineeringSessionJournal();
  let clock = 1_000, owner = binding.ownerEpoch;
  const session = new EngineeringSession({ binding: extra.binding ?? binding, workspaceRoot: '/offline/fixture', image,
    deadlineMs: 61_000, runner, journal, now: () => clock, validateWorkspace: () => {},
    assertOwner: current => { if (current.ownerEpoch !== owner) throw new Error('owner_lost'); },
    ...(extra.maxProcesses ? { maxProcesses: extra.maxProcesses } : {}), ...(extra.maxCommands ? { maxCommands: extra.maxCommands } : {}),
    ...(extra.bunCacheVolume ? { bunCacheVolume: extra.bunCacheVolume } : {}), ...(extra.dockerSocketPath ? { dockerSocketPath: extra.dockerSocketPath } : {}),
    ...(extra.resourceProfile ? { resourceProfile: extra.resourceProfile } : {}) });
  let sequence = 0;
  const next = () => `op-${++sequence}`;
  const execute = (command = 'printf fixture', timeoutMs = 10_000) => session.operation({ operation: 'execute', arguments: { binding: extra.binding ?? binding, operationId: next(), command, timeoutMs } });
  const poll = (processId: string, maxOutputBytes = 100) => session.operation({ operation: 'poll', arguments: { binding: extra.binding ?? binding, operationId: next(), processId, maxOutputBytes } });
  const close = () => session.operation({ operation: 'close', arguments: { binding: extra.binding ?? binding, operationId: next() } });
  const state = () => journal.transaction(binding.taskId, state => structuredClone(state));
  return { session, runner, journal, execute, poll, close, state, next, setClock: (value: number) => { clock = value; }, setOwner: (value: string) => { owner = value; } };
}

describe('persistent engineering session, synthetic command runner only', () => {
  it('keeps one container, uses scoped opaque handles, and reads bounded output incrementally', async () => {
    const f = setup();
    const first = await f.execute('printf first'); const second = await f.execute('printf second');
    expect(first.processId).not.toBe(second.processId);
    expect(first.processId).not.toContain(containerId);
    expect(f.runner.calls.filter(call => call.argv[1] === 'create')).toHaveLength(1);
    f.runner.processes[0]!.output = 'abcdefgh';
    expect(await f.poll(first.processId!, 4)).toMatchObject({ status: 'running', output: 'abcd', outputTruncated: false });
    f.runner.processes[0]!.running = false; f.runner.processes[0]!.exitCode = 0;
    expect(await f.poll(first.processId!, 4)).toMatchObject({ status: 'exited', output: 'efgh', exitCode: 0 });
    expect(await f.close()).toMatchObject({ cleanupConfirmed: true, status: 'closed' });
    expect(f.runner.processes.every(process => process.stopped)).toBe(true);
    expect(f.state().activeSessionId).toBeNull();
  });

  it('pins aggregate resources, one independent workspace mount and empty inherited environment', async () => {
    const f = setup(); await f.execute('env');
    const create = f.runner.calls.find(call => call.argv[1] === 'create')!;
    expect(create.argv).toContain('--network=none'); expect(create.argv).toContain('--cpus=4');
    expect(create.argv).toContain('--memory=12288m'); expect(create.argv).toContain('--memory-swap=12288m'); expect(create.argv).toContain('--pids-limit=512');
    expect(create.argv).toContain('--read-only'); expect(create.argv).toContain('--cap-drop=ALL');
    expect(create.argv.filter(value => value === '--mount')).toHaveLength(1);
    expect(create.argv).toContain('type=bind,src=/offline/fixture,dst=/workspace');
    expect(create.argv).toContain(image); expect(create.argv).not.toContain('--privileged');
    for (const call of f.runner.calls) {
      expect(Object.keys(call.env).sort()).toEqual(['DOCKER_CONFIG', 'DOCKER_HOST', 'HOME', 'PATH']);
      expect(call.argv.join(' ')).not.toContain('docker.sock');
      expect(call.timeoutMs).toBeLessThanOrEqual(10_000);
    }
    await f.close();
  });

  it('snapshots and journals a smaller host-admitted profile and caps swap at the memory limit', async () => {
    const profile = { cpus: 2, memoryMiB: 4096 }, f = setup({ resourceProfile: profile });
    profile.cpus = 4; profile.memoryMiB = 12288;
    await f.execute(); const create = f.runner.calls.find(call => call.argv[1] === 'create')!;
    expect(create.argv).toContain('--cpus=2'); expect(create.argv).toContain('--memory=4096m');
    expect(create.argv).toContain('--memory-swap=4096m');
    expect(f.state().sessions[binding.sessionId]!.resourceProfile).toEqual({ cpus: 2, memoryMiB: 4096 });
    await f.close();
    for (const resourceProfile of [{ cpus: 5, memoryMiB: 4096 }, { cpus: 2, memoryMiB: 12289 },
      { cpus: 0, memoryMiB: 4096 }, { cpus: 2, memoryMiB: 255 }, { cpus: 1.5, memoryMiB: 4096 }]) {
      expect(() => setup({ resourceProfile })).toThrow('engineering_invalid_limit');
    }
  });

  it('passes stdin as data and does not journal raw commands or input', async () => {
    const f = setup();
    await f.session.operation({ operation: 'execute', arguments: { binding, operationId: 'stdin-op', command: 'cat > artifact', stdin: 'private-fixture', timeoutMs: 1000 } });
    expect(f.runner.calls.at(-1)!.stdin).toBe('private-fixture');
    const serialized = JSON.stringify(f.state());
    expect(serialized).not.toContain('private-fixture'); expect(serialized).not.toContain('cat > artifact');
    expect(f.state().receipts.some(receipt => receipt.commandHash?.length === 64)).toBe(true);
    await f.close();
  });

  it('uses only a host-selected Unix socket and read-only dependency cache', async () => {
    const f = setup({ bunCacheVolume: 'reviewed-fixture-cache', dockerSocketPath: '/offline/docker.sock' }); await f.execute();
    expect(f.runner.calls[0]!.env.DOCKER_HOST).toBe('unix:///offline/docker.sock');
    expect(f.runner.calls[0]!.argv).toContain('type=volume,src=reviewed-fixture-cache,dst=/bun-cache,readonly');
    expect(f.runner.calls.at(-1)!.argv).toContain('BUN_INSTALL_CACHE_DIR=/tmp/bun-cache');
    expect(f.runner.calls.filter(call => call.argv[1] === 'exec')).toHaveLength(2); // cache completed before model command
    await f.close();
    expect(() => setup({ dockerSocketPath: 'tcp://remote:2375' })).toThrow('invalid_docker_socket');
    expect(() => setup({ bunCacheVolume: 'bad,src=/host' })).toThrow('invalid_cache_volume');
  });

  it('rejects every forged binding field without a runner call', async () => {
    for (const field of ['taskId', 'sessionId', 'ownerEpoch', 'admissionId'] as const) {
      const f = setup();
      await expect(f.session.operation({ operation: 'execute', arguments: { binding: { ...binding, [field]: 'foreign' }, operationId: 'op', command: 'true', timeoutMs: 10 } })).rejects.toThrow('binding_mismatch');
      expect(f.runner.calls).toHaveLength(0);
    }
  });

  it('rejects foreign handles and duplicate operations rather than replaying', async () => {
    const f = setup(); const request = { operation: 'execute' as const, arguments: { binding, operationId: 'one-use', command: 'true', timeoutMs: 1000 } };
    await f.session.operation(request);
    await expect(f.session.operation(request)).rejects.toThrow('already_consumed');
    await expect(f.poll('foreign-process')).rejects.toThrow('unknown_process');
    expect(f.runner.processes).toHaveLength(1); await f.close();
  });

  it('snapshots queued request arguments before caller mutation', async () => {
    const f = setup();
    const args = { binding: { ...binding }, operationId: 'immutable', command: 'approved', timeoutMs: 1000 };
    const result = f.session.operation({ operation: 'execute', arguments: args }); args.command = 'changed'; args.binding.ownerEpoch = 'changed';
    await result; expect(f.runner.calls.at(-1)!.argv.at(-1)).toBe('approved'); await f.close();
  });

  it('enforces aggregate process and command limits without a new container', async () => {
    const f = setup({ maxProcesses: 1, maxCommands: 2 }); await f.execute();
    await expect(f.execute()).rejects.toThrow('process_limit');
    f.runner.processes[0]!.running = false; f.runner.processes[0]!.exitCode = 0;
    await f.execute(); await expect(f.execute()).rejects.toThrow('command_limit');
    expect(f.runner.processes).toHaveLength(2); await f.close();
  });

  it('cancelling any scoped process physically closes all session work', async () => {
    const f = setup(); const first = await f.execute(); await f.execute();
    const cancelled = await f.session.operation({ operation: 'cancel', arguments: { binding, operationId: f.next(), processId: first.processId! } });
    expect(cancelled).toMatchObject({ status: 'cancelled', cleanupConfirmed: true });
    expect(f.runner.processes.every(process => process.stopped)).toBe(true);
    await expect(f.execute()).rejects.toThrow('session_closed');
    expect(await f.close()).toMatchObject({ cleanupConfirmed: true });
    expect(f.runner.calls.filter(call => call.argv[1] === 'rm')).toHaveLength(1);
  });

  it('cleans exact owned container when owner changes during command start', async () => {
    const f = setup(); f.runner.onStart = () => f.setOwner('epoch-2');
    await expect(f.execute()).rejects.toThrow('owner_lost');
    expect(f.runner.calls.some(call => call.argv[1] === 'rm')).toBe(true);
    expect(f.state().cleanupUncertain).toBe(false); expect(f.state().activeSessionId).toBeNull();
  });

  it('close proves physical cleanup after expiry and owner revocation', async () => {
    const f = setup(); await f.execute(); f.setClock(61_000); f.setOwner('epoch-2');
    expect(await f.close()).toMatchObject({ status: 'closed', cleanupConfirmed: true });
    expect(f.runner.processes[0]!.stopped).toBe(true);
    expect(f.state().activeSessionId).toBeNull();
    expect(await f.close()).toMatchObject({ status: 'closed', cleanupConfirmed: true });
    expect(f.runner.calls.filter(call => call.argv[1] === 'rm')).toHaveLength(1);
  });

  it('close observes cleanup performed by a revoked execution guard', async () => {
    const f = setup(); await f.execute(); f.setOwner('epoch-2');
    await expect(f.execute()).rejects.toThrow('owner_lost');
    expect(await f.close()).toMatchObject({ status: 'closed', cleanupConfirmed: true });
    expect(f.runner.calls.filter(call => call.argv[1] === 'rm')).toHaveLength(1);
  });

  it('repeated close checks current absence rather than replaying its earlier receipt', async () => {
    const f = setup(); await f.execute(); await f.close(); f.runner.remains = true;
    await expect(f.close()).rejects.toThrow('cleanup_uncertain');
    expect(f.state().cleanupUncertain).toBe(true);
    expect(f.runner.calls.filter(call => call.argv[1] === 'rm')).toHaveLength(1);
  });

  for (const failure of ['removal', 'still_present', 'foreign_identity'] as const) {
    it(`latches ${failure} cleanup across owner and session replacement`, async () => {
      const f = setup(); await f.execute();
      f.runner.failRemove = failure === 'removal'; f.runner.remains = failure === 'still_present'; f.runner.foreign = failure === 'foreign_identity';
      await expect(f.close()).rejects.toThrow('cleanup_uncertain');
      expect(f.state().cleanupUncertain).toBe(true);
      const replacement = setup({ journal: f.journal, binding: { ...binding, sessionId: 'new-session', ownerEpoch: 'epoch-2' } }); replacement.setOwner('epoch-2');
      await expect(replacement.execute()).rejects.toThrow('cleanup_uncertain');
      expect(replacement.runner.calls).toHaveLength(0);
      if (failure === 'foreign_identity') expect(f.runner.calls.some(call => call.argv[1] === 'rm')).toBe(false);
    });
  }

  it('unknown create outcome fences the task without deleting a name or replaying', async () => {
    const f = setup(); f.runner.failCreate = true;
    await expect(f.execute()).rejects.toThrow('cleanup_uncertain');
    await expect(f.execute()).rejects.toThrow('cleanup_uncertain');
    expect(f.runner.calls).toHaveLength(1); expect(f.state().cleanupUncertain).toBe(true);
  });

  it('unreconciled persisted sessions reject fresh owner acquisition', async () => {
    const journal = createMemoryEngineeringSessionJournal();
    journal.transaction(binding.taskId, state => { state.activeSessionId = 'old-session'; });
    const f = setup({ journal }); await expect(f.execute()).rejects.toThrow('reconciliation_required');
    expect(f.runner.calls).toHaveLength(0);
  });

  it('task deadline and command timeout remove the container before success can continue', async () => {
    const f = setup(); const handle = await f.execute('slow', 1000); f.setClock(2001);
    expect(await f.poll(handle.processId!)).toMatchObject({ status: 'cancelled', cleanupConfirmed: true });
    const g = setup(); await g.execute(); g.setClock(61_000);
    await expect(g.execute()).rejects.toThrow('engineering_deadline');
    expect(g.runner.processes[0]!.stopped).toBe(true);
  });

  it('automatically cleans an active command at timeout without requiring another poll', async () => {
    const f = setup(); await f.execute('slow', 5);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(f.runner.processes[0]!.stopped).toBe(true);
    expect(f.state().receipts.some(receipt => receipt.event === 'session_cleanup_confirmed')).toBe(true);
  });

  it('does not close for an already completed command timeout', async () => {
    const f = setup(); await f.execute('quick', 5); f.runner.processes[0]!.running = false; f.runner.processes[0]!.exitCode = 0;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.runner.calls.some(call => call.argv[1] === 'rm')).toBe(false); await f.close();
  });

  it('removes the container even when the timed-out Docker CLI already exited', async () => {
    const f = setup(); await f.execute('slow', 5);
    f.runner.processes[0]!.running = false; f.runner.processes[0]!.timedOut = true; f.runner.processes[0]!.exitCode = 137;
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(f.runner.calls.some(call => call.argv[1] === 'rm')).toBe(true);
    expect(f.runner.processes[0]!.stopped).toBe(true);
  });

  it('bounds reported output and preserves an explicit truncation flag', async () => {
    const f = setup(); const handle = await f.execute(); f.runner.processes[0]!.output = 'output'; f.runner.processes[0]!.truncated = true;
    expect(await f.poll(handle.processId!, 3)).toMatchObject({ output: 'out', outputTruncated: true });
    await expect(f.poll(handle.processId!, 1_000_000)).rejects.toThrow('invalid_limit'); await f.close();
  });

  it('journal failure after physical cleanup remains fenced for another owner', async () => {
    const base = createMemoryEngineeringSessionJournal(); let failTerminal = false;
    const journal: EngineeringSessionJournal = { transaction<T>(taskId: string, change: (state: EngineeringTaskJournal) => T): T {
      return base.transaction(taskId, state => {
        const result = change(state);
        if (failTerminal && state.receipts.at(-1)?.event === 'session_cleanup_confirmed') throw new Error('disk_failed');
        return result;
      });
    } };
    const f = setup({ journal }); await f.execute(); failTerminal = true;
    await expect(f.close()).rejects.toThrow('cleanup_uncertain');
    const g = setup({ journal, binding: { ...binding, sessionId: 'new' } });
    await expect(g.execute()).rejects.toThrow('cleanup_uncertain'); expect(g.runner.calls).toHaveLength(0);
  });

  it('a failed cleanup-intent journal write still removes the exact container and fences replacement', async () => {
    const base = createMemoryEngineeringSessionJournal(); let diskFailed = false;
    const journal: EngineeringSessionJournal = { transaction<T>(taskId: string, change: (state: EngineeringTaskJournal) => T): T {
      return base.transaction(taskId, state => {
        const result = change(state);
        if (diskFailed && state.receipts.at(-1)?.event === 'session_cleanup_intent') throw new Error('disk_failed');
        return result;
      });
    } };
    const f = setup({ journal }); await f.execute(); diskFailed = true;
    await expect(f.close()).rejects.toThrow('cleanup_uncertain');
    expect(f.runner.calls.some(call => call.argv[1] === 'rm')).toBe(true);
    expect(f.runner.processes[0]!.stopped).toBe(true);
    const g = setup({ journal, binding: { ...binding, sessionId: 'replacement' } });
    await expect(g.execute()).rejects.toThrow('cleanup_uncertain');
  });

  it('total journal outage at operation entry still attempts physical cleanup', async () => {
    const base = createMemoryEngineeringSessionJournal(); let diskFailed = false;
    const journal: EngineeringSessionJournal = { transaction<T>(taskId: string, change: (state: EngineeringTaskJournal) => T): T {
      if (diskFailed) throw new Error('disk_unavailable'); return base.transaction(taskId, change);
    } };
    const f = setup({ journal }); await f.execute(); diskFailed = true;
    await expect(f.close()).rejects.toThrow('cleanup_uncertain');
    expect(f.runner.calls.some(call => call.argv[1] === 'rm')).toBe(true);
    expect(f.runner.processes[0]!.stopped).toBe(true);
    expect(base.transaction(binding.taskId, state => state.activeSessionId)).toBe(binding.sessionId);
    // A fresh wrapper loses the in-memory fence but the unclosed durable session
    // still forbids starting replacement work; there is no blind replay.
    const replacement = setup({ journal: { transaction: base.transaction.bind(base) }, binding: { ...binding, sessionId: 'new-session' } });
    await expect(replacement.execute()).rejects.toThrow('reconciliation_required');
  });

  for (const failure of ['consume', 'intent'] as const) {
    it(`a ${failure} journal failure stops existing commands before reporting failure`, async () => {
      const base = createMemoryEngineeringSessionJournal(); let failNext = false;
      const journal: EngineeringSessionJournal = { transaction<T>(taskId: string, change: (state: EngineeringTaskJournal) => T): T {
        return base.transaction(taskId, state => {
          const alreadyConsumed = state.operations[`${binding.sessionId}/op-2`];
          const result = change(state);
          const last = state.receipts.at(-1);
          if (failNext && (failure === 'consume' ? !alreadyConsumed && state.operations[`${binding.sessionId}/op-2`]
            : last?.event === 'command_start_intent' && last.operationId === 'op-2')) throw new Error('journal_failed');
          return result;
        });
      } };
      const f = setup({ journal }); await f.execute(); failNext = true;
      await expect(f.execute()).rejects.toThrow('journal_failed');
      expect(f.runner.processes).toHaveLength(1); expect(f.runner.processes[0]!.stopped).toBe(true);
      expect(f.state().activeSessionId).toBeNull();
    });
  }
});

describe('real command runner with isolated Python fixtures, never Docker', () => {
  it('bounds output, transmits stdin and supplies only explicit environment', async () => {
    const runner = createBunEngineeringCommandRunner();
    const result = await runner.run({ argv: ['/usr/bin/python3', '-I', '-B', '-c',
      'import os,sys; assert os.environ.get("ENGINEERING_ONLY")=="fixture"; assert "GITHUB_TOKEN" not in os.environ; assert sys.stdin.read()=="input-fixture"; print("x"*1000,flush=True)'],
      env: { ENGINEERING_ONLY: 'fixture' }, stdin: 'input-fixture', timeoutMs: 5000, maxOutputBytes: 64 });
    expect(result.exitCode).toBe(0); expect(result.timedOut).toBe(false);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(64); expect(result.outputTruncated).toBe(true);
  });

  it('polls a live process and terminates the host process on its timeout', async () => {
    const runner = createBunEngineeringCommandRunner();
    const process = await runner.start({ argv: ['/usr/bin/python3', '-I', '-B', '-c', 'import time; time.sleep(10)'],
      env: {}, timeoutMs: 150, maxOutputBytes: 64 });
    expect((await process.poll()).running).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 250));
    expect((await process.poll()).timedOut).toBe(true); await process.stop();
    expect((await process.poll()).running).toBe(false);
  });
});

describe('independent workspace validation', () => {
  it('accepts an in-root Git directory and rejects linked worktrees, alternates and symlinks', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gary-engineering-fixture-')));
    try {
      mkdirSync(join(root, '.git')); validateEngineeringWorkspace(root);
      writeFileSync(join(root, '.git', 'commondir'), '/outside'); expect(() => validateEngineeringWorkspace(root)).toThrow('independent_git');
      rmSync(join(root, '.git'), { recursive: true }); writeFileSync(join(root, '.git'), 'gitdir: /outside');
      expect(() => validateEngineeringWorkspace(root)).toThrow('independent_git');
      rmSync(join(root, '.git')); mkdirSync(join(root, 'actual')); symlinkSync(join(root, 'actual'), join(root, '.git'));
      expect(() => validateEngineeringWorkspace(root)).toThrow('independent_git');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
