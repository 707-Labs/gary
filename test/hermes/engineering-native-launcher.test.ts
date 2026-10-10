import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createEngineeringNativeLauncher, createEngineeringStdioLauncher, ENGINEERING_WORKER_IMAGE,
  type EngineeringNativeInput } from '../../src/hermes/engineering-native-launcher.ts';
import { modelFixture, provider, TOOL } from './engineering-model.test.ts';

const fixtureScript = `
import {createInterface} from 'node:readline'; import {createHash} from 'node:crypto';
const lines=createInterface({input:process.stdin})[Symbol.asyncIterator]();
const read=async()=>JSON.parse((await lines.next()).value);
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const start=await read(); const binding=start.binding; let id=0,sequence=0,turnId='';
const rpc=async(kind,payload)=>{const {deadlineMs,...identity}=binding;
send({type:'engineering.request',id:++id,kind:'rpc',body:{protocol:'gary.engineering.v1',...identity,turnId,sequence:++sequence,kind,payload}});return (await read()).body;};
const model=async(messages)=>{send({type:'engineering.request',id:++id,kind:'model',body:{model:start.model,
messages:[{role:'system',content:start.systemPrompt},...messages],tools:${JSON.stringify([TOOL])},max_tokens:8192,stream:false,temperature:0.3}});
const reply=await read();if(reply.body.status!==200)throw Error('model failed');return reply.body.body.choices[0].message;};
send({type:'engineering.ready',sessionId:binding.sessionId,tools:['terminal'],toolSchemas:${JSON.stringify([TOOL])}});
for(;;){const turn=await read();if(turn.type==='engineering.close'){await rpc('session.close',{});send({type:'engineering.closed',cleanupConfirmed:true});break;}
turnId=turn.turnId;const messages=[...turn.history,{role:'user',content:turn.prompt}];let message=await model(messages);messages.push(message);
if(message.tool_calls){for(const call of message.tool_calls){const args=JSON.parse(call.function.arguments);const admission=await rpc('tool.begin',{toolCallId:call.id,toolName:call.function.name,originalArgs:args,effectiveArgs:args});
const run=await rpc('environment.operation',{toolCallId:call.id,admissionId:admission.admissionId,operation:'execute',arguments:{operationId:'op1',command:args.command}});
const content='fixture tool output';await rpc('tool.end',{toolCallId:call.id,admissionId:admission.admissionId,status:'completed',resultHash:createHash('sha256').update(JSON.stringify(content)).digest('hex'),operationReceipts:[run.receiptId]});messages.push({role:'tool',tool_call_id:call.id,content});}
message=await model(messages);messages.push(message);}
send({type:'engineering.result',turnId,result:{messages,final_response:message.content,completed:true}});}
process.exit(0);
`;
function nativeInput(s: ReturnType<typeof modelFixture>): EngineeringNativeInput {
  return { binding: s.binding, systemPrompt: s.options.systemPrompt, tools: s.options.tools, model: s.model,
    protocol: s.protocol, transportCapability: s.token, assertOwner: s.options.assertOwner,
    append: () => {}, fence: s.options.fence };
}

test('real subprocess pipe exercises start/model/native admission/operation/result and close against real guarded ledger', async () => {
  let calls = 0, cleaned = 0;
  const s = modelFixture(async () => Response.json(++calls === 1 ? provider([
    { type: 'tool_use', id: 'call_1', name: 'terminal', input: { command: 'bun test' } }], 'tool_use') : provider()));
  const file = join(s.root, 'fixture.mjs'); writeFileSync(file, fixtureScript);
  const launch = createEngineeringStdioLauncher({ command: [process.execPath, file], cwd: s.root,
    env: { PATH: '/usr/bin:/bin' }, cleanup: async () => { cleaned++; } });
  const session = await launch(nativeInput(s), new AbortController().signal);
  const result = await session.turn({ turnId: 'turn', prompt: 'Inspect and test.' });
  expect(result.nativeCompleted).toBe(true); expect(result.finalResponse).toBe('Done.');
  expect(s.requests).toHaveLength(2);
  expect(s.protocolReceipts.map((r: any) => r.kind)).toEqual(['turn','tool_begin','operation_start','operation_result','tool_completed']);
  expect(await session.close()).toEqual({ cleanupConfirmed: true }); expect(cleaned).toBe(1);
  expect(s.fences).toEqual([]);
  expect(JSON.stringify(s.protocolReceipts)).not.toContain('fake-host-only-key');
});

test('schema mismatch cleans up before reporting failure', async () => {
  const s = modelFixture(); let cleaned = 0;
  const file = join(s.root, 'bad.mjs');
  writeFileSync(file, `process.stdin.once('data',()=>{process.stdout.write(JSON.stringify({type:'engineering.ready',sessionId:'session',tools:['terminal'],toolSchemas:[]})+'\\n');});`);
  const launch = createEngineeringStdioLauncher({ command: [process.execPath, file], cwd: s.root, env: {}, cleanup: async () => { cleaned++; } });
  await expect(launch(nativeInput(s), new AbortController().signal)).rejects.toThrow('startup_failed');
  expect(cleaned).toBe(1); expect(s.requests).toHaveLength(0); expect(s.fences).toContain('native_start_failed');
});

test('native startup copies versioned limits from the guarded model adapter without granting a model call', async () => {
  for (const policyVersion of [1, 2] as const) {
    const s = modelFixture(); let cleaned = 0;
    const limits = Object.freeze({ policyVersion, model: 'deepseek-v4-pro' as const,
      maxIterations: policyVersion === 1 ? 3 : 12, maxTokens: 8192 });
    const file = join(s.root, 'policy-limits.mjs');
    // This tests only the trusted serialization seam. The synthetic v2 adapter
    // cannot admit requests through its v1 host policy, and none are attempted.
    writeFileSync(file, fixtureScript.replace('const binding=start.binding;',
      `if(start.model!==${JSON.stringify(limits.model)}||start.maxIterations!==${limits.maxIterations}||start.maxTokens!==${limits.maxTokens})throw Error('limits mismatch'); const binding=start.binding;`));
    const input = nativeInput(s), receipts: any[] = [];
    input.model = { ...s.model, nativeLimits: limits };
    input.append = receipt => receipts.push(receipt);
    const session = await createEngineeringStdioLauncher({ command: [process.execPath, file], cwd: s.root,
      env: { PATH: '/usr/bin:/bin' }, cleanup: async () => { cleaned++; } })(input, new AbortController().signal);
    const started = receipts.find(receipt => receipt.kind === 'native_stdio_start');
    expect(started.modelLimits).toEqual(limits);
    expect(Number.isSafeInteger(started.processId)).toBe(true); expect(started.processId).toBeGreaterThan(1);
    if (process.platform !== 'win32') {
      expect(started.processGroupId).toBe(started.processId);
      expect(started.processBirth).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
    }
    expect(await session.close()).toEqual({ cleanupConfirmed: true });
    expect(cleaned).toBe(1); expect(s.requests).toHaveLength(0); expect(s.model.attempts()).toHaveLength(0);
  }
});

test('failed spawn with no owned child PID never fabricates process identity', async () => {
  const s = modelFixture(), input = nativeInput(s), receipts: any[] = []; let cleaned = 0;
  input.append = receipt => receipts.push(receipt);
  const launch = createEngineeringStdioLauncher({ command: [join(s.root, 'nonexistent-executable')], cwd: s.root,
    env: {}, cleanup: async () => { cleaned++; } });
  await expect(launch(input, new AbortController().signal)).rejects.toThrow('startup_failed');
  expect(receipts.some(receipt => receipt.kind === 'native_stdio_start')).toBe(false);
  expect(receipts.some(receipt => receipt.kind === 'native_diagnostic')).toBe(true);
  expect(cleaned).toBe(1); expect(s.requests).toHaveLength(0);
});

test('invalid or mismatched legacy native limits fail before subprocess creation', async () => {
  const s = modelFixture(), file = join(s.root, 'must-not-start.mjs'), marker = join(s.root, 'started');
  writeFileSync(file, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'unexpected');`);
  let cleaned = 0;
  const launch = createEngineeringStdioLauncher({ command: [process.execPath, file], cwd: s.root,
    env: {}, cleanup: async () => { cleaned++; } });
  const valid = { policyVersion: 1, model: 'deepseek-v4-pro', maxIterations: 3, maxTokens: 8192 };
  for (const delta of [{ policyVersion: 3 }, { model: 'other' }, { maxIterations: 8 }, { maxTokens: 4096 },
    { policyVersion: 2, maxIterations: 51 }, { policyVersion: 2, maxIterations: 0 },
    { policyVersion: 2, maxTokens: 8193 }, { policyVersion: 2, maxTokens: 1.5 }, { extra: true }]) {
    const input = nativeInput(s);
    input.model = { ...s.model, nativeLimits: { ...valid, ...delta } as any };
    await expect(launch(input, new AbortController().signal)).rejects.toThrow('model_limits');
  }
  expect(existsSync(marker)).toBe(false); expect(cleaned).toBe(0); expect(s.requests).toHaveLength(0);
});

test('replayed model frame is rejected and cleaned without a second physical call', async () => {
  const s = modelFixture(); let cleaned = 0;
  const file = join(s.root, 'replay.mjs');
  const script = fixtureScript.replace("message=await model(messages);messages.push(message);", "message=await model(messages);messages.push(message);")
    .replace("send({type:'engineering.result',turnId,result:{messages,final_response:message.content,completed:true}});",
      "send({type:'engineering.request',id,kind:'model',body:{}});await read();");
  writeFileSync(file, script);
  const session = await createEngineeringStdioLauncher({ command: [process.execPath, file], cwd: s.root, env: {},
    cleanup: async () => { cleaned++; } })(nativeInput(s), new AbortController().signal);
  await expect(session.turn({ turnId: 'turn', prompt: 'Work.' })).rejects.toThrow('turn_failed');
  expect(s.requests).toHaveLength(1); expect(cleaned).toBe(1);
  expect(await session.close()).toEqual({ cleanupConfirmed: true }); expect(cleaned).toBe(1);
});

test('uncertain physical worker removal never returns cleanupConfirmed', async () => {
  const s = modelFixture(); const file = join(s.root, 'fixture.mjs'); writeFileSync(file, fixtureScript);
  const launch = createEngineeringStdioLauncher({ command: [process.execPath, file], cwd: s.root, env: {},
    cleanup: async () => { throw new Error('daemon unavailable'); } });
  const session = await launch(nativeInput(s), new AbortController().signal);
  await session.turn({ turnId: 'turn', prompt: 'Work.' });
  await expect(session.close()).rejects.toThrow('cleanup_unknown');
  expect(s.fences).toContain('native_cleanup_unknown');
});

test('native close proves absence after abort or owner revocation without making a model call', async () => {
  for (const scenario of ['abort', 'revoke']) {
    const s = modelFixture(), abort = new AbortController(); let cleaned = 0;
    const receipts: unknown[] = [], file = join(s.root, 'fixture.mjs'); writeFileSync(file, fixtureScript);
    const input = nativeInput(s); input.append = receipt => receipts.push(receipt);
    const session = await createEngineeringStdioLauncher({ command: [process.execPath, file], cwd: s.root, env: {},
      cleanup: async () => { cleaned++; } })(input, abort.signal);
    if (scenario === 'abort') abort.abort(); else s.revoke();
    expect(await session.close()).toEqual({ cleanupConfirmed: true });
    expect(await session.close()).toEqual({ cleanupConfirmed: true });
    expect(cleaned).toBe(1); expect(s.requests).toHaveLength(0);
    expect(receipts.some((r: any) => r.kind === 'native_cleanup_confirmed')).toBe(true);
  }
});

const nativeSource = '/Users/tanner/Documents/Codex/2026-10-07/task-4/gary-hermes-runtime/vendor/hermes';
const cachedPython = '/opt/homebrew/bin/python3.13';
test.skipIf(!existsSync(nativeSource) || !existsSync(cachedPython))('actual pinned Hermes and cached SDK exchange native tool history with the guarded host model', async () => {
  const tools = JSON.parse(readFileSync(resolve('hermes/engineering-tools.json'), 'utf8'));
  let calls = 0, cleaned = 0, processCount = 0;
  const operations: string[] = [];
  const s = modelFixture(async () => Response.json(++calls === 1 ? provider([
    { type: 'tool_use', id: 'native_call_1', name: 'terminal', input: { command: 'printf native-fixture' } }], 'tool_use') : provider()), {
    tools, deadlineMs: Date.now() + 60_000,
    execute: async (operation, args) => {
      operations.push(operation);
      if (operation === 'execute') return { processId: 'native-process-' + ++processCount, status: 'running' };
      if (operation === 'poll') return { processId: args.processId, status: 'exited', output: 'native fixture output', outputTruncated: false, exitCode: 0 };
      throw new Error('Unexpected native operation: ' + operation);
    },
  });
  const home = join(s.root, 'scoped-home'); mkdirSync(home, { mode: 0o700 });
  const launcher = createEngineeringStdioLauncher({
    command: [cachedPython, resolve('hermes/python/test_gary_engineering_cached.py'), 'worker'], cwd: s.root,
    env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' }, fixturePaths: { nativeSource, scopedHome: home },
    cleanup: async () => { cleaned++; },
  });
  const session = await launcher(nativeInput(s), new AbortController().signal);
  const result = await session.turn({ turnId: 'native-turn', prompt: 'Run the fixture command and report completion.' });
  expect(result.finalResponse).toBe('Done.'); expect(result.nativeCompleted).toBe(true);
  expect(s.requests).toHaveLength(2); expect(operations).toContain('execute'); expect(operations).toContain('poll');
  expect(s.protocolReceipts.map((r: any) => r.kind)).toContain('tool_completed');
  expect(await session.close()).toEqual({ cleanupConfirmed: true }); expect(cleaned).toBe(1);
  // A fresh review remains available after the native worker is physically gone.
  await s.model.review({ prompt: 'Review the exact fixture artifact and host checks.', systemPrompt: 'Independent reviewer.', signal: new AbortController().signal });
  expect(s.requests).toHaveLength(3); expect(s.model.attempts().map(r => r.state)).toEqual(['settled','settled','settled']);
  expect(s.fences).toEqual([]);
}, 65_000);

function dockerFixture({ replacement = false, daemonChanged = false, uncertainCreate = false } = {}) {
  const s = modelFixture(), snapshots = join(s.root, 'snapshots'); mkdirSync(snapshots, { mode: 0o700 });
  const paths = ['gary_engineering_runtime.py', 'gary_engineering_environment.py'].map(name => {
    const path = join(s.root, name); writeFileSync(path, '# reviewed fixture\n', { mode: 0o600 });
    return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  });
  const commands: string[][] = [], events: string[] = [], receipts: any[] = [];
  let spec: any, created = false, labels: Record<string, string> = {}, daemon = 'daemon-fixture';
  const id = 'a'.repeat(64), foreign = 'b'.repeat(64), guardianAbort = new AbortController();
  const input = nativeInput(s); input.append = receipt => { receipts.push(receipt); events.push(String(receipt.kind)); };
  const launch = createEngineeringNativeLauncher({ runtimeFiles: paths, snapshotDirectory: snapshots,
    guardianDirectory: join(s.root, 'guardians'), resources: { cpus: 1, memoryMiB: 2048 }, dockerExecutable: '/usr/local/bin/docker',
    dockerHost: 'unix:///Users/tanner/.colima/default/docker.sock' }, {
    run: async command => {
      commands.push([...command]);
      if (command[1] === 'image') return { exitCode: 0, stdout: JSON.stringify([{ Id: ENGINEERING_WORKER_IMAGE,
        Os: 'linux', Architecture: 'arm64', Config: { User: '65532:65532', WorkingDir: '/opt/gary-hermes-runtime' } }]) };
      if (command[1] === 'info') return { exitCode: 0, stdout: daemon };
      if (command[2] === 'create') {
        events.push('create'); created = true;
        for (let i = 0; i < command.length; i++) if (command[i] === '--label') {
          const value = command[i + 1]!, at = value.indexOf('='); labels[value.slice(0, at)] = value.slice(at + 1);
        }
        return { exitCode: uncertainCreate ? 1 : 0, stdout: uncertainCreate ? '' : id };
      }
      if (command[2] === 'inspect') return { exitCode: 0, stdout: JSON.stringify({ Id: id, Config: { Labels: labels } }) };
      if (command[2] === 'rm') { events.push('remove'); expect(command.at(-1)).toBe(id); created = false; }
      if (command[2] === 'ls') return { exitCode: 0,
        stdout: command.at(-1)!.startsWith('id=') ? (created ? id : '') : replacement ? foreign : (created ? id : '') };
      return { exitCode: 0, stdout: '' };
    },
    guardian: { arm: async () => { events.push('arm'); return { daemonId: 'daemon-fixture', signal: guardianAbort.signal,
      reference: { directory: '/fixture', databasePath: '/fixture/db', journalId: 'journal', invocationId: 'invocation', pid: 123 },
      bind: async found => { expect(found).toBe(id); events.push('bind'); },
      complete: async () => { events.push('drained'); if (daemonChanged) daemon = 'foreign-daemon'; throw Error('guardian failed after drain'); },
    }; } },
    stdio: options => async (_, signal) => { events.push('start'); spec = options;
      return { turn: async () => { signal.throwIfAborted(); throw new Error('unused'); },
        close: async () => { await options.cleanup(); return { cleanupConfirmed: true }; } }; },
  });
  return { s, snapshots, launch, input, events, receipts, commands, id, guardianAbort, get spec() { return spec; } };
}

test('Docker creation is guarded before start, pins ID, and only mounts reviewed read-only overlays', async () => {
  const f = dockerFixture(), session = await f.launch(f.input, new AbortController().signal);
  const create = f.commands.find(c => c[2] === 'create')!;
  expect(create).toContain(ENGINEERING_WORKER_IMAGE); expect(create).toContain('--read-only');
  expect(create.slice(create.indexOf('--memory'), create.indexOf('--memory') + 2)).toEqual(['--memory','2048m']);
  expect(create.slice(create.indexOf('--cpus'), create.indexOf('--cpus') + 2)).toEqual(['--cpus','1']);
  expect(create.slice(create.indexOf('--network'), create.indexOf('--network') + 2)).toEqual(['--network','none']);
  const mounts = create.filter(s => s.startsWith('type=bind'));
  expect(mounts).toHaveLength(2); expect(mounts.every(s => s.endsWith(',readonly'))).toBe(true);
  expect(JSON.stringify(create)).not.toContain('docker.sock'); expect(JSON.stringify(f.spec)).not.toContain('fake-host-only-key');
  expect(Object.keys(f.spec.env).sort()).toEqual(['DOCKER_CONFIG','DOCKER_HOST','HOME','PATH']);
  expect(f.spec.command).toEqual(['/usr/local/bin/docker','container','start','--attach','--interactive', f.id]);
  expect(f.events.indexOf('arm')).toBeLessThan(f.events.indexOf('create'));
  expect(f.events.indexOf('native_guardian_armed')).toBeLessThan(f.events.indexOf('create'));
  expect(f.events.indexOf('native_container_created')).toBeLessThan(f.events.indexOf('bind'));
  expect(f.events.indexOf('bind')).toBeLessThan(f.events.indexOf('start'));
  await session.close(); expect(readdirSync(f.snapshots)).toEqual([]);
  expect(f.events.indexOf('drained')).toBeLessThan(f.events.indexOf('remove'));
  expect(f.receipts.at(-1)).toMatchObject({ kind: 'native_cleanup_confirmed', containerId: f.id });
});

test('cleanup deletes only owned ID after name replacement and never touches the replacement', async () => {
  const f = dockerFixture({ replacement: true }), session = await f.launch(f.input, new AbortController().signal);
  await session.close();
  expect(f.commands.filter(c => c[2] === 'rm').map(c => c.at(-1))).toEqual([f.id]);
  expect(f.receipts.find(r => r.kind === 'native_container_cleanup_confirmed').foreignNamePresent).toBe(true);
});

test('daemon change and unresolved create preserve cleanup uncertainty instead of deleting by name', async () => {
  const f = dockerFixture({ daemonChanged: true }), session = await f.launch(f.input, new AbortController().signal);
  await expect(session.close()).rejects.toThrow('daemon_changed');
  expect(f.commands.some(c => c[2] === 'rm')).toBe(false);
  expect(f.receipts.some(r => r.kind === 'native_cleanup_confirmed')).toBe(false);
  const unknown = dockerFixture({ uncertainCreate: true });
  await expect(unknown.launch(unknown.input, new AbortController().signal)).rejects.toThrow('cleanup_unknown');
  expect(unknown.commands.some(c => c[2] === 'rm')).toBe(false);
  expect(unknown.s.fences).toContain('native_cleanup_unknown');
});

test('source hash substitution is rejected before image inspection or worker creation', async () => {
  const s = modelFixture(), snapshots = join(s.root, 'snapshots'); mkdirSync(snapshots, { mode: 0o700 });
  const runtimeFiles = ['gary_engineering_runtime.py', 'gary_engineering_environment.py'].map(name => {
    const path = join(s.root, name); writeFileSync(path, '# changed\n', { mode: 0o600 }); return { path, sha256: 'a'.repeat(64) }; });
  let calls = 0;
  const launch = createEngineeringNativeLauncher({ runtimeFiles, snapshotDirectory: snapshots, guardianDirectory: join(s.root, 'guardians'), resources: { cpus: 1, memoryMiB: 2048 },
    dockerExecutable: '/usr/local/bin/docker', dockerHost: 'unix:///Users/tanner/.colima/default/docker.sock' }, {
    run: async () => { calls++; return { exitCode: 0, stdout: '' }; } });
  await expect(launch(nativeInput(s), new AbortController().signal)).rejects.toThrow('source_changed');
  expect(calls).toBe(0); expect(readdirSync(snapshots)).toEqual([]);
});

test('host resource configuration cannot enlarge the reviewed native worker ceiling', () => {
  const base = { runtimeFiles: ['gary_engineering_runtime.py','gary_engineering_environment.py'].map(name => ({ path: '/fixture/' + name, sha256: 'a'.repeat(64) })),
    snapshotDirectory: '/fixture/snapshots', guardianDirectory: '/fixture/guardians',
    dockerExecutable: '/usr/local/bin/docker' as const, dockerHost: 'unix:///Users/tanner/.colima/default/docker.sock' as const };
  for (const resources of [{ cpus: 3, memoryMiB: 2048 }, { cpus: 1, memoryMiB: 4097 },
    { cpus: NaN, memoryMiB: 2048 }, { cpus: 1, memoryMiB: 256.5 }]) {
    expect(() => createEngineeringNativeLauncher({ ...base, resources })).toThrow('docker_configuration');
  }
});

test('native result preserves separately attributed bounded counts without messages, prompts or commands', async () => {
  let calls = 0, cleaned = 0;
  const s = modelFixture(async () => Response.json(++calls === 1 ? provider([
    { type: 'tool_use', id: 'call_1', name: 'terminal', input: { command: 'PRIVATE COMMAND' } }], 'tool_use') : provider()));
  const reported = { outcome: 'iteration_limit' as const, modelRequests: 2, toolCalls: 1, toolFailures: 0, toolBlocks: 0, toolResultErrors: 1 };
  const file = join(s.root, 'diagnostics.mjs');
  writeFileSync(file, fixtureScript.replace('completed:true', 'completed:false,diagnostics:' + JSON.stringify(reported)));
  const receipts: any[] = [], input = nativeInput(s); input.append = r => receipts.push(r);
  const session = await createEngineeringStdioLauncher({ command: [process.execPath, file], cwd: s.root, env: {}, cleanup: async () => { cleaned++; } })(input, new AbortController().signal);
  const result = await session.turn({ turnId: 'turn', prompt: 'PRIVATE PROMPT' }); await session.close();
  expect(result.nativeCompleted).toBe(false); expect(result.workerReported).toEqual(reported);
  const diagnostic = receipts.find(r => r.kind === 'native_turn_result').diagnostic;
  expect(diagnostic).toEqual({ version: 1, event: 'native_result', phase: 'native_turn', code: 'none',
    hostObserved: { modelRequestsReceived: 2, toolBegins: 1, toolEnds: 1, toolFailures: 0, environmentOperations: 1 }, workerReported: reported });
  expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE'); expect(JSON.stringify(diagnostic)).not.toContain('fixture tool output');
  expect(cleaned).toBe(1); expect(s.requests).toHaveLength(2);
});
test('invalid worker diagnostics never persist arbitrary strings and still prove exact cleanup', async () => {
  const s = modelFixture(), file = join(s.root, 'bad-diagnostics.mjs');
  writeFileSync(file, fixtureScript.replace('completed:true', 'completed:true,diagnostics:{outcome:"secret-provider-body",modelRequests:999999}'));
  const receipts: any[] = [], input = nativeInput(s); input.append = r => receipts.push(r); let cleaned = 0;
  const session = await createEngineeringStdioLauncher({ command: [process.execPath, file], cwd: s.root, env: {}, cleanup: async () => { cleaned++; } })(input, new AbortController().signal);
  await expect(session.turn({ turnId: 'turn', prompt: 'Private task.' })).rejects.toThrow('turn_failed');
  expect(receipts.find(r => r.kind === 'native_diagnostic').diagnostic).toMatchObject({ phase: 'native_turn', code: 'engineering_worker:result_diagnostics', hostObserved: { modelRequestsReceived: 1 } });
  expect(JSON.stringify(receipts)).not.toContain('secret-provider-body'); expect(cleaned).toBe(1);
  expect(await session.close()).toEqual({ cleanupConfirmed: true }); expect(s.requests).toHaveLength(1);
});

test('diagnostic persistence failure cannot skip mandatory native cleanup', async () => {
  const s = modelFixture(), file = join(s.root, 'bad-persist.mjs'); let cleaned = 0;
  writeFileSync(file, `process.stdin.once('data',()=>process.stdout.write(JSON.stringify({type:'engineering.ready',sessionId:'session',tools:[],toolSchemas:[]})+'\\n'));`);
  const input = nativeInput(s); input.append = receipt => { if (receipt.kind === 'native_diagnostic') throw Error('private DB failure'); };
  await expect(createEngineeringStdioLauncher({ command: [process.execPath, file], cwd: s.root, env: {}, cleanup: async () => { cleaned++; } })(input, new AbortController().signal)).rejects.toThrow('private DB failure');
  expect(cleaned).toBe(1); expect(s.requests).toHaveLength(0);
});

test('rejected native RPC retains a safe protocol code while discarding unrecognized response text', async () => {
  for (const unsafe of [false, true]) {
    const s = modelFixture(async () => Response.json(provider([{ type: 'tool_use', id: 'call_1', name: 'terminal', input: { command: 'PRIVATE COMMAND' } }], 'tool_use')),
      { execute: async () => { throw Error('PRIVATE EXECUTOR BODY'); } });
    const input = nativeInput(s), receipts: any[] = []; input.append = r => receipts.push(r);
    if (unsafe) input.protocol.accept = async () => ({ ok: false, error: 'engineering_protocol:operation_uncertain PRIVATE SECRET' });
    let cleaned = 0; const file = join(s.root, 'rejected.mjs'); writeFileSync(file, fixtureScript);
    const session = await createEngineeringStdioLauncher({ command: [process.execPath, file], cwd: s.root, env: {}, cleanup: async () => { cleaned++; } })(input, new AbortController().signal);
    await expect(session.turn({ turnId: 'turn', prompt: 'PRIVATE PROMPT' })).rejects.toThrow('turn_failed');
    expect(receipts.find(r => r.kind === 'native_diagnostic').diagnostic).toMatchObject({ phase: 'native_turn', code: unsafe ? 'engineering_worker:rpc_rejected' : 'engineering_protocol:operation_uncertain' });
    expect(JSON.stringify(receipts)).not.toContain('PRIVATE'); expect(cleaned).toBe(1); expect(s.requests).toHaveLength(1);
    expect(await session.close()).toEqual({ cleanupConfirmed: true });
  }
});
