"""Native Hermes environment backed only by an injected authenticated host RPC.

This module is imported after the engineering bootstrap selects the pinned
Hermes source and clean scoped home. It never starts Docker or a local shell.
The host, not this adapter, owns sandbox creation, credentials and process IDs.
"""
from __future__ import annotations

import contextvars
import os
import shlex
import subprocess
import threading
import time
import uuid
from typing import Callable

from tools.environments.base import BaseEnvironment


class EnvironmentFault(RuntimeError):
    """A protocol/authority failure; callers must not replay the operation."""


def _identifier(value, label):
    if not isinstance(value, str) or not value or len(value) > 256:
        raise EnvironmentFault("invalid_" + label)
    return value


class GaryProcessHandle:
    """Hermes ProcessHandle with a real pipe and host-owned opaque process ID.

    Poll output is incremental. Neither poll nor a transport failure is retried.
    A copy of the admitting context is carried into the output pump thread.
    """

    def __init__(self, environment, process_id, timeout):
        self.environment = environment
        self.process_id = _identifier(process_id, "process_id")
        self._returncode = None
        self._fault = None
        self._done = threading.Event()
        self._cancel_lock = threading.Lock()
        self._cancelled = False
        self._stop = threading.Event()
        read_fd, self._write_fd = os.pipe()
        self._stdout = os.fdopen(read_fd, "r", encoding="utf-8", errors="replace")
        self._deadline = time.monotonic() + timeout
        context = contextvars.copy_context()
        self._thread = threading.Thread(target=lambda: context.run(self._pump), daemon=True)
        with environment._operation_lock:
            environment._handles.add(self)
            if environment._closing or environment._closed:
                self._stop.set()
            self._thread.start()

    @property
    def stdout(self):
        return self._stdout

    @property
    def returncode(self):
        return self._returncode

    def _pump(self):
        total = 0
        poll_delay = 0.25
        try:
            while not self._stop.is_set():
                if time.monotonic() >= self._deadline:
                    # Record the initiating deadline before cancellation changes state.
                    raise EnvironmentFault("process_deadline_exceeded")
                result = self.environment._operation("poll", {
                    "processId": self.process_id, "maxOutputBytes": 16384,
                })
                if result.get("processId") != self.process_id:
                    raise EnvironmentFault("process_identity_mismatch")
                output = result.get("output")
                if not isinstance(output, str) or result.get("outputTruncated") is not False:
                    raise EnvironmentFault("incomplete_process_output")
                data = output.encode("utf-8")
                total += len(data)
                if total > self.environment.max_output_bytes:
                    raise EnvironmentFault("process_output_limit")
                while data:
                    written = os.write(self._write_fd, data)
                    data = data[written:]
                status = result.get("status")
                if status == "running":
                    # Empty observations back off instead of spending the
                    # task's fixed RPC budget in a 100 Hz polling loop. Output
                    # remains responsive, and every wait fits the original
                    # command deadline; no poll/transport fault is replayed.
                    if output:
                        poll_delay = 0.25
                    self._stop.wait(min(poll_delay, max(0, self._deadline - time.monotonic())))
                    poll_delay = min(poll_delay * 2, 2.0)
                    continue
                if status not in ("exited", "cancelled"):
                    raise EnvironmentFault("invalid_process_status")
                code = result.get("exitCode")
                if isinstance(code, bool) or not isinstance(code, int):
                    raise EnvironmentFault("missing_process_exit_code")
                self._returncode = code
                break
        except BaseException as exc:
            if self._stop.is_set() and type(exc) is EnvironmentFault and str(exc) in ("environment_closing", "environment_closed"):
                self._returncode = -15
                return
            self._fault = exc
            self.environment._fence(exc, "pump")
            # The backend's cancel drains the entire owned session. No PID from
            # sandbox output is ever used for cleanup.
            try:
                self.kill()
            except BaseException as cleanup_error:
                self.environment._fence(cleanup_error, "cancel")
        finally:
            if self._stop.is_set() and self._returncode is None and self._fault is None:
                self._returncode = -15
            os.close(self._write_fd)
            self._done.set()
            with self.environment._operation_lock:
                self.environment._handles.discard(self)

    def poll(self):
        if self._fault is not None:
            raise EnvironmentFault("process_observation_failed") from self._fault
        return self._returncode if self._done.is_set() else None

    def wait(self, timeout=None):
        if not self._done.wait(timeout):
            raise subprocess.TimeoutExpired(self.process_id, timeout)
        self.poll()
        return self._returncode

    def kill(self):
        with self._cancel_lock:
            if self._cancelled or self._done.is_set():
                return
            self._cancelled = True
            self._stop.set()
            self.environment._transition("fenced", "process_cancel", "cancel")
            result = self.environment._operation("cancel", {"processId": self.process_id})
            if result.get("cleanupConfirmed") is not True:
                error = EnvironmentFault("cleanup_unconfirmed")
                self.environment._fence(error, "cancel")
                raise error


class GaryEnvironment(BaseEnvironment):
    """Preserve native execute/snapshot/file algorithms; replace only spawning.

    ``rpc`` must enforce an active one-use native-tool admission on every call.
    It returns host receipts, including for poll/cancel/close. No authentication
    material is put into shell env or arguments. The production cwd is fixed by
    host admission; alternate cwd/temp_dir are solely injected fixture paths.
    """

    def __init__(self, rpc: Callable, *, cwd="/workspace", timeout=120,
                 temp_dir="/tmp", max_operations=10000, max_output_bytes=8 * 1024 * 1024):
        self._rpc = rpc
        self._session_scoped = True
        self._temp_dir = temp_dir
        self._closed = False
        self._closing = False
        self._fenced = False
        self._first_transition = None
        self._first_error = None
        self._handles = set()
        self._operation_count = 0
        self._operation_lock = threading.RLock()
        self._execution_lock = threading.Lock()
        self.max_operations = max_operations
        self.max_output_bytes = max_output_bytes
        self.receipts = []
        self._process_ids = set()
        super().__init__(cwd=cwd, timeout=timeout, env={})
        # The build sandbox uses a fixed environment, never a login profile.
        self._prefer_nonlogin = True

    def get_temp_dir(self):
        return self._temp_dir

    def _transition(self, state, reason, initiator):
        with self._operation_lock:
            if self._first_transition is None:
                self._first_transition = dict(state=state, reason=reason, initiator=initiator,
                    atMs=int(time.time() * 1000), operationCount=self._operation_count)
            if state == "fenced":
                self._fenced = True

    def _fence(self, error, initiator):
        # No exception text is retained; worker_fault applies the fixed code allowlist.
        with self._operation_lock:
            first = self._first_error is None
            if first:
                self._first_error = error
            self._transition("fenced", "backend_fault", initiator)
        observer = getattr(self, "_fault_observer", None)
        if first and observer is not None:
            observer(error)

    def _operation(self, operation, arguments):
        with self._operation_lock:
            if self._closed:
                raise EnvironmentFault("environment_closed")
            if self._closing and operation not in ("cancel", "close"):
                raise EnvironmentFault("environment_closing")
            if self._fenced and operation not in ("cancel", "close"):
                raise EnvironmentFault("environment_fenced")
            self._operation_count += 1
            if self._operation_count > self.max_operations and operation not in ("cancel", "close"):
                error = EnvironmentFault("environment_operation_limit")
                self._fence(error, "operation")
                raise error
            arguments = dict(arguments, operationId=uuid.uuid4().hex)
        try:
            result = self._rpc(operation, arguments)
            if not isinstance(result, dict) or result.get("ok") is not True:
                raise EnvironmentFault("environment_operation_rejected")
            receipt = _identifier(result.get("receiptId"), "operation_receipt")
            with self._operation_lock:
                self.receipts.append(receipt)
            return result
        except BaseException as error:
            self._fence(error, "operation")
            raise

    def _start_bash(self, cmd_string, *, timeout=120, stdin_data=None):
        if not isinstance(cmd_string, str) or not cmd_string:
            raise EnvironmentFault("invalid_command")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
            raise EnvironmentFault("invalid_command_timeout")
        if stdin_data is not None and not isinstance(stdin_data, str):
            raise EnvironmentFault("invalid_stdin")
        # Preserve the native wrapped command without trying to identify tests
        # from its shell text. Original tool arguments are admitted separately.
        arguments = {"command": "exec bash -c " + shlex.quote(cmd_string),
                     "timeoutMs": max(1, int(timeout * 1000))}
        if stdin_data is not None:
            arguments["stdin"] = stdin_data
        result = self._operation("execute", arguments)
        process_id = _identifier(result.get("processId"), "process_id")
        if result.get("status") != "running" or process_id in self._process_ids:
            error = EnvironmentFault("invalid_process_start")
            self._fence(error, "operation")
            raise error
        self._process_ids.add(process_id)
        return process_id

    def _run_bash(self, cmd_string, *, login=False, timeout=120, stdin_data=None):
        process_id = self._start_bash(cmd_string, timeout=timeout, stdin_data=stdin_data)
        return GaryProcessHandle(self, process_id, timeout)

    def start_background(self, command, *, cwd=None, timeout=None):
        """Native process-registry backend seam; host owns the long-lived job.

        There is no unauthenticated poll thread after the spawning tool ends.
        Subsequent native process calls obtain fresh host tool admissions.
        """
        if not self._snapshot_ready:
            self.init_session()
        return self._start_bash(self._wrap_command(command, cwd or self.cwd),
                                timeout=timeout or self.timeout)

    def execute(self, command, cwd="", **kwargs):
        # Do not let native foreground retry behavior repeat an uncertain
        # command. A protocol failure permanently fences this environment.
        if not self._execution_lock.acquire(blocking=False):
            raise EnvironmentFault("concurrent_environment_execution")
        try:
            if not self._snapshot_ready:
                self.init_session()
            return super().execute(command, cwd, **kwargs)
        finally:
            self._execution_lock.release()

    def _prepare_command(self, command):
        # Native default consults SUDO_PASSWORD. This backend never consults or
        # injects a credential, including one registered by an untrusted skill.
        return command, None

    def cleanup(self):
        with self._operation_lock:
            if self._closed:
                return
            self._transition("closing", "environment_close", "close")
            self._closing = True
            handles = list(self._handles)
            for handle in handles:
                handle._stop.set()
        # Physical cancellation remains host-owned, with the same close receipt.
        failed = False
        try:
            result = self._operation("close", {})
            if result.get("cleanupConfirmed") is not True:
                raise EnvironmentFault("cleanup_unconfirmed")
            with self._operation_lock:
                self._closed = True
        except BaseException as error:
            failed = True
            self._fence(error, "close")
            raise
        finally:
            # Only threads created by this adapter are joined; never native/global threads.
            deadline = time.monotonic() + 2.0
            for handle in handles:
                if handle._thread is not threading.current_thread():
                    handle._thread.join(max(0, deadline - time.monotonic()))
            if any(handle._thread.is_alive() for handle in handles):
                error = EnvironmentFault("polling_cleanup_unconfirmed")
                self._fence(error, "close")
                if not failed:
                    raise error

    def __del__(self):
        # Lifecycle is explicit and host-owned. Interpreter teardown must not
        # invent an admission or make transport calls with a stale context.
        pass


def native_process_registry(environment, *, task_id, session_id, current_admission):
    """Adapt native ProcessRegistry's backend hooks, retaining its tool handler.

    Native formatting, poll/wait/log pagination and task filtering remain in
    ProcessRegistry. Only spawn, observation and cancellation use host handles;
    there are no sandbox PID/log/exit files or unsolicited RPC poll threads.
    """
    from tools.process_registry import ProcessRegistry, ProcessSession

    class GaryProcessRegistry(ProcessRegistry):
        def _write_checkpoint(self, *args, **kwargs):
            # The host journal is authoritative. Sandbox-local checkpoints must
            # never be interpreted as renewed authority after a restart.
            return None

        def spawn_via_env(self, env, command, cwd=None, task_id="", session_key="", timeout=10):
            current = current_admission()
            if env is not environment or task_id != owner_task or not current or current.get("toolName") != "terminal":
                raise EnvironmentFault("unbound_background_start")
            timeout = current["args"].get("timeout") or environment.timeout
            process_id = environment.start_background(command, cwd=cwd, timeout=timeout)
            process = ProcessSession(id=process_id, command=command, task_id=owner_task,
                session_key=owner_session, cwd=cwd, started_at=time.time(), env_ref=environment,
                pid_scope="sandbox")
            with self._lock:
                self._running[process.id] = process
            return process

        def spawn_local(self, *args, **kwargs):
            raise EnvironmentFault("local_process_denied")

        def get(self, process_id):
            # Exact host handles only; no native prefix/PID lookup.
            with self._lock:
                process = self._running.get(process_id) or self._finished.get(process_id)
            return self._refresh_detached_session(process)

        def _refresh_detached_session(self, process):
            current = current_admission()
            if process is None or process.exited or not current or current.get("toolName") != "process":
                return process
            result = environment._operation("poll", {"processId": process.id, "maxOutputBytes": 16384})
            if result.get("processId") != process.id:
                raise EnvironmentFault("process_identity_mismatch")
            if result.get("status") == "cancelled" and result.get("cleanupConfirmed") is True:
                self._cancel_all_observed()
                return process
            if not isinstance(result.get("output"), str) or result.get("outputTruncated") is not False:
                environment._fence(EnvironmentFault("incomplete_process_output"), "registry")
                raise EnvironmentFault("incomplete_process_output")
            with process._lock:
                process.output_buffer = (process.output_buffer + result["output"])[-process.max_output_chars:]
                if result.get("status") == "exited":
                    code = result.get("exitCode")
                    if type(code) is not int:
                        raise EnvironmentFault("missing_process_exit_code")
                    process.exited, process.exit_code = True, code
                    process._completion_event.set()
                elif result.get("status") != "running":
                    raise EnvironmentFault("invalid_process_status")
            if process.exited:
                with self._lock:
                    self._running.pop(process.id, None)
                    self._finished[process.id] = process
            return process

        def _cancel_all_observed(self):
            environment._transition("fenced", "process_cancel", "registry")
            with self._lock:
                for process in self._running.values():
                    process.exited, process.exit_code = True, -15
                    process.completion_reason = "killed"
                    process.termination_source = "host_session_cancel"
                    process._completion_event.set()
                    self._finished[process.id] = process
                self._running.clear()

        def kill_process(self, process_id, *args, **kwargs):
            with self._lock:
                process = self._running.get(process_id) or self._finished.get(process_id)
            if process is None:
                return {"status": "not_found", "error": "Unknown task process"}
            result = environment._operation("cancel", {"processId": process.id})
            if result.get("cleanupConfirmed") is not True:
                environment._fence(EnvironmentFault("cleanup_unconfirmed"), "registry")
                raise EnvironmentFault("cleanup_unconfirmed")
            self._cancel_all_observed()
            return {"session_id": process.id, "status": "killed", "cleanup_confirmed": True,
                    "note": "Host cancelled the owned sandbox and all of its processes."}

        def kill_all(self, *args, **kwargs):
            # Native housekeeping cannot invent a fresh tool admission. The
            # explicit environment/session close owns unconditional cleanup.
            if current_admission() is None:
                return 0
            with self._lock:
                ids = list(self._running)
            if ids:
                self.kill_process(ids[0])
            return len(ids)

        def write_stdin(self, *args, **kwargs):
            return {"error": "Live stdin is not implemented by this environment"}

        submit_stdin = close_stdin = write_stdin

    owner_task, owner_session = task_id, session_id
    return GaryProcessRegistry()
