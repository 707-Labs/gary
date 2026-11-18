/** Pure clock/config fixtures: no child processes, filesystem or Docker calls. */
import { expect, test } from 'bun:test';
import { armExecutorGuardianDeadline, executorGuardianDeadlineDelay, LEGACY_GUARDIAN_MAX_MS,
  snapshotStandingEngineeringSessionWindow, STANDING_ENGINEERING_MAX_MS,
  type ExecutorGuardianDeadlineBinding, type StandingEngineeringSessionWindow } from '../../src/executors/guardian-deadline.ts';
import { createEngineeringSessionGuardianFactory, type EngineeringGuardianContext } from '../../src/executors/engineering-session-guardian.ts';
import { armExecutorJobGuardian, type ExecutorJobGuardianBinding } from '../../src/executors/job-guardian.ts';

const start = 1_000_000;
function standing(duration = STANDING_ENGINEERING_MAX_MS): ExecutorGuardianDeadlineBinding {
  const standingSession = { startedAtMs: start, deadlineMs: start + duration };
  return { deadlineMs: standingSession.deadlineMs, standingSession,
    expectedBinding: JSON.stringify({ taskId: 'task', sessionId: 'session', ownerEpoch: 'owner', standingSession }) };
}

test('only an explicit durable standing window extends the legacy 30-minute limit to 150 minutes', () => {
  const legacy = { deadlineMs: start + LEGACY_GUARDIAN_MAX_MS, expectedBinding: '{}' };
  expect(executorGuardianDeadlineDelay(legacy, start)).toBe(30 * 60_000);
  expect(() => executorGuardianDeadlineDelay({ ...legacy, deadlineMs: legacy.deadlineMs + 1 }, start)).toThrow('deadline_invalid');
  expect(executorGuardianDeadlineDelay(standing(), start)).toBe(150 * 60_000);
  expect(executorGuardianDeadlineDelay(standing(), start + 90 * 60_000)).toBe(60 * 60_000);
  expect(() => executorGuardianDeadlineDelay(standing(150 * 60_000 + 1), start)).toThrow('deadline_invalid');
  expect(() => executorGuardianDeadlineDelay(standing(), start + 150 * 60_000)).toThrow('deadline_invalid');
});

test('wrong, future, malformed or renewed standing windows cannot arm a guardian', () => {
  const valid = standing();
  const invalid: ExecutorGuardianDeadlineBinding[] = [
    { ...valid, deadlineMs: valid.deadlineMs + 1 }, { ...valid, expectedBinding: '{}' },
    { ...valid, expectedBinding: '{' }, { ...valid, expectedBinding: '[]' },
    { ...valid, expectedBinding: JSON.stringify({ standingSession: { startedAtMs: start + 1, deadlineMs: valid.deadlineMs } }) },
    { ...valid, standingSession: { startedAtMs: start + 1, deadlineMs: valid.deadlineMs } },
  ];
  for (const value of invalid) expect(() => executorGuardianDeadlineDelay(value, start)).toThrow('deadline_invalid');
  for (const value of [null, {}, { startedAtMs: start, deadlineMs: start },
    { startedAtMs: -1, deadlineMs: start }, { startedAtMs: NaN, deadlineMs: start },
    { startedAtMs: start, deadlineMs: Infinity }, { startedAtMs: start, deadlineMs: start + 1, renewable: true },
    { startedAtMs: start, get deadlineMs() { throw Error('accessor must not run'); } }]) {
    expect(() => snapshotStandingEngineeringSessionWindow(value as StandingEngineeringSessionWindow)).toThrow('deadline_invalid');
  }
});

test('the real guardian scheduler arms once for remaining time despite mutable inputs and wall-clock rollback', () => {
  const binding = standing(), window = binding.standingSession!;
  let clock = start + 20 * 60_000, delay = 0, schedules = 0, cancelled = 0, fired = 0;
  let callback!: () => void;
  const cancel = armExecutorGuardianDeadline(binding, () => { fired++; }, {
    now: () => clock, schedule(fn, ms) { callback = fn; delay = ms; schedules++; return () => { cancelled++; }; },
  });
  expect(delay).toBe(130 * 60_000); expect(schedules).toBe(1); expect(fired).toBe(0);
  Object.assign(window, { startedAtMs: start + 150 * 60_000, deadlineMs: start + 300 * 60_000 });
  clock = start - 100_000; callback(); callback(); cancel();
  expect(fired).toBe(1); expect(schedules).toBe(1); expect(cancelled).toBe(0); expect(delay).toBe(130 * 60_000);
});

test('completed cleanup cancels the timer without providing a renewal method', () => {
  let callback!: () => void, fired = 0, cancelled = 0;
  const cancel = armExecutorGuardianDeadline(standing(), () => { fired++; }, {
    now: () => start, schedule(fn) { callback = fn; return () => { cancelled++; }; },
  });
  cancel(); cancel(); callback(); expect(cancelled).toBe(1); expect(fired).toBe(0);
});

test('the session factory snapshots its original deadline and rejects replacement before filesystem or runner access', async () => {
  const now = Date.now(), window = { startedAtMs: now, deadlineMs: now + 150 * 60_000 };
  const originalDeadline = window.deadlineMs;
  const factory = createEngineeringSessionGuardianFactory({ directory: '/never-access-fixture', standingSession: window });
  window.deadlineMs += 60_000;
  const context: EngineeringGuardianContext = {
    binding: { taskId: 'task', sessionId: 'session', ownerEpoch: 'owner', admissionId: 'admission' },
    containerName: 'gary-longjob-00000000-0000-0000-0000-000000000000', deadlineMs: window.deadlineMs,
    workspaceRoot: '/never-access-workspace', image: 'sha256:' + 'a'.repeat(64),
    dockerBinary: '/never-execute-docker', dockerHost: 'unix:///never-access.sock',
    runner: { async run() { throw Error('runner forbidden'); }, async start() { throw Error('runner forbidden'); } },
  };
  await expect(factory.arm(context)).rejects.toThrow('engineering_guardian_context_invalid');
  // A legacy factory cannot accept the same original 150-minute deadline.
  await expect(createEngineeringSessionGuardianFactory({ directory: '/never-access-fixture' })
    .arm({ ...context, deadlineMs: originalDeadline })).rejects.toThrow('engineering_guardian_context_invalid');
});

test('the guardian launcher rejects invalid deadlines before attempting a child spawn', async () => {
  const binding: ExecutorJobGuardianBinding = { directory: '/never-access', dockerConfig: '/never-access/docker-config',
    databasePath: '/never-access/jobs.sqlite', dockerHost: 'unix:///never-access.sock', dockerBinary: '/never-execute',
    journalId: 'journal', invocationId: 'invocation', containerName: 'unused', ownerPid: process.pid,
    ownerToken: 'synthetic', expectedBinding: '{}', deadlineMs: Date.now() + 150 * 60_000 };
  await expect(armExecutorJobGuardian(binding)).rejects.toThrow('executor_guardian_deadline_invalid');
  expect(Object.isFrozen(snapshotStandingEngineeringSessionWindow(standing().standingSession!))).toBe(true);
});
