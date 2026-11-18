import { afterEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineeringSession, createBunEngineeringCommandRunner, createMemoryEngineeringSessionJournal } from '../../src/executors/engineering-session.ts';
import { createEngineeringSessionGuardianFactory } from '../../src/executors/engineering-session-guardian.ts';

// Real detached guardian and CLI runner, but an isolated Python state-machine
// executable replaces Docker entirely. No Docker daemon/socket is contacted.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const binding = { taskId: 'guardian-task', sessionId: 'guardian-session', ownerEpoch: 'owner-1', admissionId: 'admission-1' };
const image = `sha256:${'b'.repeat(64)}`;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gary-engineering-guardian-'))); roots.push(root);
  const workspace = join(root, 'workspace'); mkdirSync(workspace); mkdirSync(join(workspace, '.git'));
  const binary = join(root, 'docker-synthetic'), state = join(root, 'container.json'), mode = join(root, 'mode.json'), calls = join(root, 'calls.jsonl');
  writeFileSync(mode, '{}'); writeFileSync(calls, '');
  writeFileSync(binary, `#!/usr/bin/python3 -I
import json,os,sys,time
state=${JSON.stringify(state)}
mode=json.load(open(${JSON.stringify(mode)}))
args=sys.argv[1:]
if args[:1]==['--host']: args=args[4:]
with open(${JSON.stringify(calls)},'a') as f: f.write(json.dumps({'args':args,'secret':os.environ.get('ENGINEERING_POISON')})+'\\n')
if args[:1]==['container']: args=args[1:]
op=args[0]
item=json.load(open(state)) if os.path.exists(state) else None
if op=='info': print(mode.get('daemon','fixture-daemon-12345678'))
elif op=='create':
  labels={}
  for i,a in enumerate(args):
    if a=='--label':
      k,v=args[i+1].split('=',1); labels[k]=v
  item={'Id':'a'*64,'Name':'/'+args[args.index('--name')+1],'Config':{'Labels':labels},'count':0}
  json.dump(item,open(state,'w')); print(item['Id'])
elif op=='start':
  assert item is not None; print(item['Id'])
elif op=='exec':
  assert item is not None
  if args[-1]=='fixture-slow': time.sleep(20)
  else:
    item['count']+=1; json.dump(item,open(state,'w')); print('fixture-output-'+str(item['count']))
elif op in ['ps','ls']:
  if item:
    filt=args[args.index('--filter')+1]
    if filt in ['id='+item['Id'],'name=^'+item['Name']+'$']: print(item['Id'])
elif op=='inspect':
  if not item: sys.exit(1)
  if mode.get('foreign'): item['Config']['Labels']['gary.task']='foreign'; item['Config']['Labels']['dev.gary.executor-job']='foreign'
  print(json.dumps(item))
elif op=='rm':
  if mode.get('rmFail'): sys.exit(1)
  if item: os.remove(state)
else: sys.exit(99)
`, { mode: 0o755 });
  const journal = createMemoryEngineeringSessionJournal();
  const options = { binding, workspaceRoot: workspace, image, deadlineMs: Date.now() + 10_000,
    runner: createBunEngineeringCommandRunner(), journal, dockerBinary: binary, dockerSocketPath: '/synthetic/docker.sock',
    guardian: createEngineeringSessionGuardianFactory({ directory: join(root, 'guardian') }), assertOwner: () => {} };
  return { root, workspace, binary, state, mode, calls, journal, options };
}
async function until(condition: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!condition()) { if (Date.now() >= end) throw new Error('fixture_wait_timeout'); await Bun.sleep(10); }
}

describe('independent persistent session guardian with a synthetic Docker executable', () => {
  it('arms before create, binds before start, proves cleanup and preserves state across commands', async () => {
    const f = fixture(), session = new EngineeringSession(f.options);
    let seq = 0;
    for (let command = 1; command <= 2; command++) {
      const started = await session.operation({ operation: 'execute', arguments: { binding, operationId: `execute-${++seq}`, command: 'fixture', timeoutMs: 5000 } });
      let output = '';
      for (;;) {
        const result = await session.operation({ operation: 'poll', arguments: { binding, operationId: `poll-${++seq}`, processId: started.processId!, maxOutputBytes: 1024 } });
        output += result.output ?? '';
        if (result.status === 'exited') break;
        await Bun.sleep(5);
      }
      expect(output).toContain(`fixture-output-${command}\n`);
    }
    const record = f.journal.transaction(binding.taskId, state => structuredClone(state.sessions[binding.sessionId]!));
    expect(record.daemonId).toBe('fixture-daemon-12345678'); expect(record.guardian?.pid).toBeGreaterThan(0);
    expect(record.containerId).toBe('a'.repeat(64));
    expect(await session.operation({ operation: 'close', arguments: { binding, operationId: 'close' } })).toMatchObject({ cleanupConfirmed: true });
    expect(existsSync(f.state)).toBe(false);
    const calls = readFileSync(f.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const createIndex = calls.findIndex(call => call.args[0] === 'create');
    const startIndex = calls.findIndex(call => call.args[0] === 'start');
    expect(calls.slice(0, createIndex).filter(call => call.args[0] === 'info').length).toBeGreaterThanOrEqual(2);
    expect(calls.slice(createIndex, startIndex).some(call => call.args[0] === 'container' && call.args[1] === 'inspect')).toBe(true);
    expect(calls.every(call => call.secret === null)).toBe(true);
    const receipt = JSON.parse(readFileSync(join(record.guardian!.directory, `guardian-${record.guardian!.invocationId}.json`), 'utf8'));
    expect(receipt.absenceVerified).toBe(true);
  });

  it('refuses a real runner without independent protection and refuses a >30-minute guardian', async () => {
    const f = fixture();
    const { guardian, ...unprotected } = f.options;
    expect(() => new EngineeringSession(unprotected)).toThrow('guardian_required');
    const session = new EngineeringSession({ ...f.options, deadlineMs: Date.now() + 31 * 60_000 });
    await expect(session.operation({ operation: 'execute', arguments: { binding, operationId: 'too-long', command: 'fixture', timeoutMs: 1000 } })).rejects.toThrow();
    expect(readFileSync(f.calls, 'utf8')).toBe('');
  });

  it('foreign container identity leaves the resource untouched and fences the task', async () => {
    const f = fixture(), session = new EngineeringSession(f.options);
    await session.operation({ operation: 'execute', arguments: { binding, operationId: 'execute', command: 'fixture', timeoutMs: 5000 } });
    writeFileSync(f.mode, JSON.stringify({ foreign: true }));
    await expect(session.operation({ operation: 'close', arguments: { binding, operationId: 'close' } })).rejects.toThrow('cleanup_uncertain');
    expect(existsSync(f.state)).toBe(true);
    expect(f.journal.transaction(binding.taskId, state => state.cleanupUncertain)).toBe(true);
    const calls = readFileSync(f.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.some(call => call.args.includes('rm'))).toBe(false);
  });

  it('survives parent SIGKILL and removes the exact fake container without parent timers', async () => {
    const f = fixture(), ready = join(f.root, 'ready.json');
    const module = new URL('../../src/executors/engineering-session.ts', import.meta.url).pathname;
    const guardianModule = new URL('../../src/executors/engineering-session-guardian.ts', import.meta.url).pathname;
    const helper = join(f.root, 'parent.ts');
    writeFileSync(helper, `import {writeFileSync} from 'node:fs';
import {EngineeringSession,createBunEngineeringCommandRunner,createMemoryEngineeringSessionJournal} from ${JSON.stringify(module)};
import {createEngineeringSessionGuardianFactory} from ${JSON.stringify(guardianModule)};
const binding=${JSON.stringify(binding)},journal=createMemoryEngineeringSessionJournal();
const session=new EngineeringSession({binding,workspaceRoot:${JSON.stringify(f.workspace)},image:${JSON.stringify(image)},deadlineMs:Date.now()+10000,
runner:createBunEngineeringCommandRunner(),journal,dockerBinary:${JSON.stringify(f.binary)},dockerSocketPath:'/synthetic/docker.sock',
guardian:createEngineeringSessionGuardianFactory({directory:${JSON.stringify(join(f.root, 'guardian'))}}),assertOwner:()=>{}});
await session.operation({operation:'execute',arguments:{binding,operationId:'execute',command:'fixture',timeoutMs:5000}});
const record=journal.transaction(binding.taskId,state=>state.sessions[binding.sessionId]);
writeFileSync(${JSON.stringify(ready)},JSON.stringify(record.guardian)); setInterval(()=>{},1000);
`);
    const parent = spawn(process.execPath, ['--no-env-file', helper], { detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: f.root } });
    try {
      await until(() => existsSync(ready));
      const reference = JSON.parse(readFileSync(ready, 'utf8'));
      expect(existsSync(f.state)).toBe(true); parent.kill('SIGKILL');
      const receiptPath = join(reference.directory, `guardian-${reference.invocationId}.json`);
      await until(() => existsSync(receiptPath));
      expect(existsSync(f.state)).toBe(false);
      expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toMatchObject({ absenceVerified: true, containerId: 'a'.repeat(64) });
    } finally { try { if (parent.pid) process.kill(-parent.pid, 'SIGKILL'); } catch { /* fixture already exited */ } }
  });

  it('enforces its absolute deadline while the live parent event loop is blocked', async () => {
    const f = fixture(), ready = join(f.root, 'blocked-ready.json');
    const module = new URL('../../src/executors/engineering-session.ts', import.meta.url).pathname;
    const guardianModule = new URL('../../src/executors/engineering-session-guardian.ts', import.meta.url).pathname;
    const helper = join(f.root, 'blocked-parent.ts');
    writeFileSync(helper, `import {writeFileSync} from 'node:fs';
import {EngineeringSession,createBunEngineeringCommandRunner,createMemoryEngineeringSessionJournal} from ${JSON.stringify(module)};
import {createEngineeringSessionGuardianFactory} from ${JSON.stringify(guardianModule)};
const binding=${JSON.stringify(binding)},journal=createMemoryEngineeringSessionJournal();
const session=new EngineeringSession({binding,workspaceRoot:${JSON.stringify(f.workspace)},image:${JSON.stringify(image)},deadlineMs:Date.now()+3000,
runner:createBunEngineeringCommandRunner(),journal,dockerBinary:${JSON.stringify(f.binary)},dockerSocketPath:'/synthetic/docker.sock',
guardian:createEngineeringSessionGuardianFactory({directory:${JSON.stringify(join(f.root, 'guardian'))}}),assertOwner:()=>{}});
await session.operation({operation:'execute',arguments:{binding,operationId:'execute',command:'fixture',timeoutMs:2500}});
writeFileSync(${JSON.stringify(ready)},JSON.stringify(journal.transaction(binding.taskId,state=>state.sessions[binding.sessionId].guardian)));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);
`);
    const parent = spawn(process.execPath, ['--no-env-file', helper], { detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: f.root } });
    try {
      await until(() => existsSync(ready));
      const reference = JSON.parse(readFileSync(ready, 'utf8'));
      const receiptPath = join(reference.directory, `guardian-${reference.invocationId}.json`);
      await until(() => existsSync(receiptPath));
      process.kill(parent.pid!, 0); // still blocked, so no parent timer ran cleanup
      expect(existsSync(f.state)).toBe(false);
      expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toMatchObject({ absenceVerified: true, reason: 'deadline' });
    } finally { try { if (parent.pid) process.kill(-parent.pid, 'SIGKILL'); } catch { /* fixture already exited */ } }
  }, 8000);
});
