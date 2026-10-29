/** Explicit host-only resource admission; import performs no I/O. The detached
 * holder never launches workloads and never rewrites, steals or replaces a lock.
 * An orphan keeps its fd lock until an operator verifies physical cleanup. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export interface EngineeringResourceBinding { readonly taskId: string; readonly sessionId: string; readonly ownerEpoch: string }
export interface EngineeringResourceLockPin {
  readonly path: string; readonly dev: number; readonly ino: number; readonly uid: number; readonly mode: number; readonly nlink: number;
}
export interface EngineeringResourceRequirements { readonly cpus: number; readonly memoryBytes: number }
export interface EngineeringResourceLockInspection {
  lstat(path: string): Pick<Stats, 'dev' | 'ino' | 'uid' | 'mode' | 'nlink' | 'isFile' | 'isSymbolicLink'>;
  realpath(path: string): string;
}
/** Native worker 2 CPUs/4 GiB plus executor 4 CPUs/12 GiB. */
export const ENGINEERING_RESOURCE_REQUIREMENTS: Readonly<EngineeringResourceRequirements> = Object.freeze({ cpus: 6, memoryBytes: 16 * 1024 ** 3 });
export interface EngineeringResourceLeaseReference {
  readonly binding: Readonly<EngineeringResourceBinding>;
  readonly pid: number;
  /** Unique process-birth token is also in the holder argv, for exact recovery. */
  readonly birthToken: string;
  /** Holder handshake wall time, not an operating-system process birth proof. */
  readonly startedAtUnixNs: string;
  readonly lock: Readonly<EngineeringResourceLockPin>;
  readonly requirements: Readonly<EngineeringResourceRequirements>;
}
export interface EngineeringResourceLease {
  readonly reference: Readonly<EngineeringResourceLeaseReference>;
  /** Route abort to BOTH native and executor shutdown; abort never releases the lock. */
  readonly signal: AbortSignal;
  assertHeld(): void;
  /** Host must prove all task workloads physically absent, including native and
   * executor containers, before releasing. A failed proof leaves the fd held. */
  release(proof: EngineeringResourceBinding & { readonly cleanupConfirmed: true }): Promise<void>;
}
export interface EngineeringResourceLeaseOptions {
  binding: EngineeringResourceBinding;
  /** Read-only host observation AFTER exclusive acquisition and BEFORE launch. */
  preflight(requirements: Readonly<EngineeringResourceRequirements>): Promise<{ availableCpus: number; availableMemoryBytes: number }>;
  /** Reviewed host policy only: aggregate simultaneous native + executor budget.
   * Narrowing this value must also narrow the actual workload resource limits. */
  requirements?: EngineeringResourceRequirements;
  /** Required reviewed host binding. There is no discovered or historical default. */
  lockPin: EngineeringResourceLockPin;
  pythonExecutable?: string;
  signal?: AbortSignal;
  /** Test seam; never supplied from worker/model arguments. */
  spawn?: typeof spawn;
  /** Trusted fixture observation only; production observes the host filesystem. */
  inspection?: EngineeringResourceLockInspection;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const CONTROL_MS = 2000;
function fail(reason: string): never { throw new Error(`engineering_resource_${reason}`); }
function bindingMatches(a: EngineeringResourceBinding, b: EngineeringResourceBinding): boolean {
  return a.taskId === b.taskId && a.sessionId === b.sessionId && a.ownerEpoch === b.ownerEpoch;
}
function validatePin(pin: EngineeringResourceLockPin): void {
  if (typeof pin.path !== 'string' || !isAbsolute(pin.path) || resolve(pin.path) !== pin.path || /[\x00-\x1f]/.test(pin.path)
    || ![pin.dev, pin.ino, pin.uid, pin.mode, pin.nlink].every(Number.isSafeInteger)
    || pin.dev < 0 || pin.ino < 1 || pin.uid < 0 || pin.mode < 0 || pin.mode > 0o777 || pin.nlink !== 1) fail('invalid_pin');
}
function validateRequirements(requirements: EngineeringResourceRequirements): void {
  if (Object.keys(requirements).sort().join(',') !== 'cpus,memoryBytes'
    || !Number.isSafeInteger(requirements.cpus) || requirements.cpus < 1 || requirements.cpus > ENGINEERING_RESOURCE_REQUIREMENTS.cpus
    || !Number.isSafeInteger(requirements.memoryBytes) || requirements.memoryBytes < 1
    || requirements.memoryBytes > ENGINEERING_RESOURCE_REQUIREMENTS.memoryBytes) fail('invalid_requirements');
}
function checkPath(pin: EngineeringResourceLockPin, inspection: EngineeringResourceLockInspection): void {
  try {
    const st = inspection.lstat(pin.path);
    if (!st.isFile() || st.isSymbolicLink() || inspection.realpath(pin.path) !== pin.path
      || st.dev !== pin.dev || st.ino !== pin.ino || st.uid !== pin.uid || (st.mode & 0o7777) !== pin.mode || st.nlink !== pin.nlink) fail('lock_identity_changed');
  } catch { fail('lock_identity_changed'); }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {}); return { promise, resolve, reject };
}
async function bounded<T>(promise: Promise<T>, ms = CONTROL_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('engineering_resource_holder_timeout')), ms);
  })]); } finally { clearTimeout(timer); }
}

// Fixed audited program: -I prevents Python environment/user-site injection.
// The fd is opened without creation or writes. EOF deliberately retains the fd.
const HOLDER = String.raw`
import fcntl,json,os,select,stat,sys,time
p=json.loads(sys.argv[1]); fd=None
def emit(kind, **values):
    try: os.write(1,(json.dumps(dict(kind=kind,birthToken=p['birthToken'],**values))+'\n').encode())
    except OSError: pass
def checked(s):
    return stat.S_ISREG(s.st_mode) and s.st_dev==p['dev'] and s.st_ino==p['ino'] and s.st_uid==p['uid'] and stat.S_IMODE(s.st_mode)==p['mode'] and s.st_nlink==p['nlink']
def identity():
    return os.path.realpath(p['path'])==p['path'] and checked(os.lstat(p['path'])) and checked(os.fstat(fd))
try:
    if os.path.realpath(p['path'])!=p['path'] or not checked(os.lstat(p['path'])): raise ValueError()
    fd=os.open(p['path'],os.O_RDONLY|os.O_NOFOLLOW)
    if not identity(): raise ValueError()
    try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        emit('error',reason='busy'); sys.exit(2)
    if not identity(): raise ValueError()
    emit('held',pid=os.getpid(),startedAtUnixNs=str(time.time_ns()))
    orphan=False; lost=False; buffer=b''
    while True:
        try: intact=identity()
        except OSError: intact=False
        if not intact and not lost:
            lost=True; emit('lost',reason='lock_identity_changed')
        if orphan:
            time.sleep(.1); continue
        readable,_,_=select.select([0],[],[],.1)
        if not readable: continue
        chunk=os.read(0,4096)
        if not chunk:
            orphan=True; emit('lost',reason='parent_disconnected'); continue
        buffer+=chunk
        if len(buffer)>4096:
            orphan=True; emit('lost',reason='control_invalid'); continue
        while b'\n' in buffer:
            line,buffer=buffer.split(b'\n',1)
            try: message=json.loads(line)
            except Exception: message=None
            if message==dict(kind='release',birthToken=p['birthToken']):
                os.close(fd); fd=None; emit('released'); sys.exit(0)
            orphan=True; emit('lost',reason='control_invalid'); break
except Exception:
    emit('error',reason='holder_failed'); sys.exit(1)
finally:
    if fd is not None: os.close(fd)
`;

/** Acquire explicitly, persist reference before launching workloads, and route
 * signal loss to cleanup. Recovery must independently verify OS process birth,
 * PID, birthToken and path pins; the handshake timestamp is diagnostic only.
 * Never remove the lock or kill a PID inferred from old state. */
export async function acquireEngineeringResourceLease(options: EngineeringResourceLeaseOptions): Promise<EngineeringResourceLease> {
  options = { ...options };
  const binding = Object.freeze({ ...options.binding }), pin = Object.freeze({ ...options.lockPin });
  const inspection = { lstat: options.inspection?.lstat ?? lstatSync, realpath: options.inspection?.realpath ?? realpathSync };
  const requirements = Object.freeze({ ...(options.requirements === undefined ? ENGINEERING_RESOURCE_REQUIREMENTS : options.requirements) });
  validateRequirements(requirements);
  if (!Object.values(binding).every(value => typeof value === 'string' && ID.test(value))
    || Object.keys(binding).sort().join(',') !== 'ownerEpoch,sessionId,taskId') fail('invalid_binding');
  validatePin(pin); checkPath(pin, inspection); options.signal?.throwIfAborted();
  const python = options.pythonExecutable ?? '/usr/bin/python3';
  if (!isAbsolute(python) || resolve(python) !== python || /[\x00-\x1f]/.test(python)) fail('invalid_python');
  const birthToken = randomUUID(), abort = new AbortController(), ready = deferred<string>(), closed = deferred<void>();
  const child = (options.spawn ?? spawn)(python, ['-I', '-B', '-u', '-c', HOLDER, JSON.stringify({ ...pin, birthToken, binding, requirements })], {
    detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, cwd: '/',
  }) as ChildProcessWithoutNullStreams;
  let held = false, exited = false, releasing = false, output = '', outputBytes = 0, stderrBytes = 0;
  let releasePromise: Promise<void> | undefined;
  const lost = (reason: string) => {
    const error = new Error(`engineering_resource_${reason}`);
    if (!abort.signal.aborted) abort.abort(error);
    ready.reject(error);
  };
  const cancelled = () => lost('cancelled');
  options.signal?.addEventListener('abort', cancelled, { once: true });
  if (options.signal?.aborted) cancelled();
  child.stdin.on('error', () => { if (!releasing) lost('control_lost'); });
  child.on('error', () => lost('holder_failed'));
  child.on('close', () => {
    exited = true; held = false; closed.resolve();
    if (!releasing) lost('holder_lost');
  });
  child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 8192) lost('holder_output_invalid'); });
  child.stdout.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 16_384) { lost('holder_output_invalid'); return; }
    output += chunk.toString('utf8');
    let end: number;
    while ((end = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, end); output = output.slice(end + 1);
      try {
        const message = JSON.parse(line);
        if (message.birthToken !== birthToken) fail('holder_binding');
        if (message.kind === 'held' && !held && !releasing && message.pid === child.pid
          && typeof message.startedAtUnixNs === 'string' && /^[1-9][0-9]{10,24}$/.test(message.startedAtUnixNs)) {
          held = true; ready.resolve(message.startedAtUnixNs);
        } else if (message.kind === 'released' && releasing) held = false;
        else if (message.kind === 'error' && message.reason === 'busy') lost('busy');
        else if (message.kind === 'lost' && ['lock_identity_changed', 'parent_disconnected', 'control_invalid'].includes(message.reason)) lost(message.reason);
        else if (message.kind === 'lost' || message.kind === 'error') lost('holder_lost');
        else lost('holder_protocol');
      } catch { lost('holder_protocol'); }
    }
  });
  const drainAfterCleanup = async (): Promise<void> => {
    releasing = true; options.signal?.removeEventListener('abort', cancelled);
    if (!exited && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end(JSON.stringify({ kind: 'release', birthToken }) + '\n');
    try { await bounded(closed.promise); }
    catch {
      // This exact child was spawned by this invocation; no PID lookup or group kill.
      if (!exited) child.kill('SIGKILL');
      await bounded(closed.promise);
    }
  };
  const assertHeld = () => {
    if (!held || exited || releasing || abort.signal.aborted || options.signal?.aborted) fail('not_held');
    try { checkPath(pin, inspection); } catch { lost('lock_identity_changed'); fail('not_held'); }
  };
  try {
    const startedAtUnixNs = await bounded(ready.promise);
    assertHeld();
    let cancelPreflight!: () => void;
    const preflightAborted = new Promise<never>((_, reject) => {
      cancelPreflight = () => reject(abort.signal.reason);
      abort.signal.addEventListener('abort', cancelPreflight, { once: true });
    });
    void preflightAborted.catch(() => {});
    let headroom: { availableCpus: number; availableMemoryBytes: number };
    try { headroom = await bounded(Promise.race([options.preflight(requirements), preflightAborted]), 5000); }
    finally { abort.signal.removeEventListener('abort', cancelPreflight); }
    if (!headroom || !Number.isFinite(headroom.availableCpus) || headroom.availableCpus < requirements.cpus
      || !Number.isSafeInteger(headroom.availableMemoryBytes) || headroom.availableMemoryBytes < requirements.memoryBytes) fail('headroom_unavailable');
    assertHeld();
    const reference = Object.freeze({ binding, pid: child.pid!, birthToken, startedAtUnixNs, lock: pin, requirements });
    return Object.freeze({ reference, signal: abort.signal, assertHeld,
      release(proof: EngineeringResourceBinding & { cleanupConfirmed: true }) {
        if (!proof || !bindingMatches(binding, proof) || proof.cleanupConfirmed !== true) return Promise.reject(new Error('engineering_resource_cleanup_unconfirmed'));
        releasePromise ??= drainAfterCleanup(); return releasePromise;
      },
    });
  } catch (error) {
    // Acquisition never returned, so its caller could not launch any workloads.
    await drainAfterCleanup(); throw error;
  }
}
