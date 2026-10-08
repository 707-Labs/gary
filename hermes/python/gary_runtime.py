"""One-task Hermes adapter. Run with an isolated Python interpreter and JSON stdin.

This module imports only the standard library until run_task's production factory
is entered. Production uses one new process per task; it is not a reusable server.
The trusted host must additionally enforce OS egress/filesystem/process isolation,
kill this worker at its shared deadline, and retain all publication authority.

Test seam: native_factory(*, agent_kwargs, tools, tool_handlers) returns an agent
with tools, valid_tool_names and run_conversation. transport(url, body, headers,
timeout) returns a decoded JSON object; it must not follow redirects.
"""
from __future__ import annotations

import contextlib
import copy
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import select
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

PINNED_REVISION = "9664e386f67965ec8bec5cf3db9d411f2c2b6cc0"
TOOLSET = "gary_executor"
MAX_INPUT_BYTES = 1_048_576
MAX_RESPONSE_BYTES = 1_048_576
MAX_HISTORY_BYTES = 524_288
MAX_HISTORY_MESSAGES = 512
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")
_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]{0,63}$")
# These names have agent-local dispatch before registry dispatch in this pin.
_NATIVE_SPECIAL = frozenset({
    "todo", "session_search", "memory", "clarify", "read_terminal",
    "read_preview", "read_window_below", "setup_mcp", "delegate_task",
    "execute_code", "terminal", "tool_search", "tool_describe", "tool_call",
})
_RUN_LOCK = threading.Lock()
_NATIVE_STARTED = False
_STDIO_PATHS = frozenset({"/v1/chat/completions", "/tools/execute", "/tools/state", "/tools/jobs/poll"})


class RuntimeFault(Exception):
    """Only the fixed code is safe to return; never forward a raw exception."""
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)



_DIAGNOSTIC_CODES = frozenset(['concurrent_task_denied', 'deadline_exceeded', 'diagnostic_rejected', 'duplicate_live_tool_call_id', 'endpoint_origin_mismatch', 'executor_state_invalidated', 'history_contains_capability', 'history_duplicate_tool_id', 'history_pending_tool_calls', 'history_too_large', 'history_tool_receipt_mismatch', 'invalid_capability', 'invalid_deadline', 'invalid_endpoint', 'invalid_history', 'invalid_history_content', 'invalid_history_fields', 'invalid_history_message', 'invalid_history_reasoning', 'invalid_history_tool_arguments', 'invalid_history_tool_call', 'invalid_history_tool_calls', 'invalid_history_tool_id', 'invalid_history_tool_name', 'invalid_identity', 'invalid_input_json', 'invalid_long_test_policy', 'invalid_maxIterations', 'invalid_maxTokens', 'invalid_model', 'invalid_model_history_response', 'invalid_native_result', 'invalid_native_source', 'invalid_payload', 'invalid_prompt', 'invalid_rpc_response', 'invalid_state_receipt', 'invalid_stdio_frame', 'invalid_stdio_request', 'invalid_stdio_response', 'invalid_stdio_transport', 'invalid_system_prompt', 'invalid_temperature', 'invalid_test_job', 'invalid_tool_arguments', 'invalid_tool_name', 'invalid_tool_schema', 'invalid_tools', 'invalid_transport', 'missing_original_tool_call_id', 'model_attempt_limit', 'model_authority_rejected', 'model_output_cap_exceeded', 'native_dotenv_present', 'native_execution_failed', 'native_pin_mismatch', 'native_process_reuse_denied', 'native_runtime_error', 'native_toolset_mismatch', 'registry_binding_mismatch', 'registry_toolset_mismatch', 'rpc_authority_rejected', 'rpc_http_error', 'rpc_redirect_denied', 'rpc_transport_error', 'stdio_closed', 'stdio_endpoint_denied', 'stdio_frame_too_large', 'stdio_method_denied', 'test_job_binding_rejected', 'test_job_poll_limit', 'test_job_receipt_rejected', 'tool_receipt_mismatch', 'unapproved_native_tool', 'unexpected_native_iteration_cap', 'unexpected_test_job', 'unknown_native_failure', 'unknown_runtime_fault', 'unresolved_live_tool_calls', 'unsupported_model_request', 'untraced_live_tool_call'])
_DIAGNOSTIC_STAGES = frozenset(['unknown', 'input_validation', 'native_init', 'native_run', 'model_request', 'model_response', 'tool_call', 'state_read', 'native_result', 'stdio_write', 'stdio_read', 'stdio_response'])

def _diagnostic(code, stage, exc=None):
    category = {TypeError: "type_error", ValueError: "value_error", KeyError: "key_error",
                AttributeError: "attribute_error", OSError: "os_error"}.get(type(exc), "other_exception" if exc else "none")
    return {"origin": "worker", "code": code if code in _DIAGNOSTIC_CODES else "unknown_runtime_fault",
            "stage": stage if stage in _DIAGNOSTIC_STAGES else "unknown", "category": category}

_LONG_TEST_POLICY = {"version": 1, "commands": {
    "bun run ci:full": {"timeoutMs": 1800000, "maxStarts": 4},
    "bun run check": {"timeoutMs": 600000, "maxStarts": 8}},
    "pollWaitMs": 20000, "heartbeatMs": 1000, "maxPolls": 96}

def _deadline(payload: dict, *, model_stdio=False) -> float:
    remaining = (payload["deadlineMs"] - time.time() * 1000) / 1000
    if remaining <= 0:
        raise RuntimeFault("deadline_exceeded")
    return remaining if model_stdio else min(remaining, 60.0)


def _url(value, *, suffix=None):
    if not isinstance(value, str) or len(value) > 2048 or any(c.isspace() for c in value):
        raise RuntimeFault("invalid_endpoint")
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.query or parsed.fragment or "\\" in value):
            raise ValueError()
        if parsed.scheme == "http":
            if parsed.hostname != "localhost" and not ipaddress.ip_address(parsed.hostname).is_loopback:
                raise ValueError()
        if suffix and parsed.path.rstrip("/") != suffix:
            raise ValueError()
        if port is not None and not 1 <= port <= 65535:
            raise ValueError()
    except (ValueError, TypeError):
        raise RuntimeFault("invalid_endpoint") from None
    return value.rstrip("/")


def _validate(payload):
    if not isinstance(payload, dict):
        raise RuntimeFault("invalid_payload")
    # A JSON round trip rejects native objects and gives every task its own data.
    try:
        raw = json.dumps(payload, allow_nan=False).encode()
        if len(raw) > MAX_INPUT_BYTES:
            raise ValueError()
        p = json.loads(raw)
    except (ValueError, TypeError, OverflowError):
        raise RuntimeFault("invalid_payload") from None
    for key in ("taskId", "requestId", "ownerEpoch"):
        if not isinstance(p.get(key), str) or not _ID.fullmatch(p[key]):
            raise RuntimeFault("invalid_identity")
    capability = p.get("capability")
    if (not isinstance(capability, str) or not 32 <= len(capability) <= 512
            or any(ord(c) < 33 or ord(c) > 126 for c in capability)):
        raise RuntimeFault("invalid_capability")
    for key in ("prompt", "model"):
        if not isinstance(p.get(key), str) or not p[key].strip():
            raise RuntimeFault("invalid_" + key)
    if len(p["model"]) > 256 or any(ord(c) < 32 for c in p["model"]):
        raise RuntimeFault("invalid_model")
    if not isinstance(p.get("systemPrompt", ""), str):
        raise RuntimeFault("invalid_system_prompt")
    temperature = p.get("temperature", 0.3)
    if type(temperature) not in (int, float) or not math.isfinite(temperature) or not 0 <= temperature <= 1:
        raise RuntimeFault("invalid_temperature")
    p["temperature"] = temperature
    for key, default, high in (("maxIterations", 8, 50), ("maxTokens", 4096, 8192)):
        value = p.get(key, default)
        if type(value) is not int or not 1 <= value <= high:
            raise RuntimeFault("invalid_" + key)
        p[key] = value
    deadline = p.get("deadlineMs")
    if type(deadline) not in (int, float) or not math.isfinite(deadline):
        raise RuntimeFault("invalid_deadline")
    _deadline(p)
    if p.get("transport", "http") not in ("http", "stdio"):
        raise RuntimeFault("invalid_transport")
    if "longTestPolicy" in p:
        if (p.get("transport") != "stdio" or
                json.dumps(p["longTestPolicy"], sort_keys=True, allow_nan=False) !=
                json.dumps(_LONG_TEST_POLICY, sort_keys=True)):
            raise RuntimeFault("invalid_long_test_policy")
    p["modelBaseUrl"] = _url(p.get("modelBaseUrl"))
    if p.get("transport") == "stdio":
        _url(p["modelBaseUrl"], suffix="/v1")
    p["executorUrl"] = _url(p.get("executorUrl"), suffix="/tools/execute")
    inferred_state = p["executorUrl"].rsplit("/", 1)[0] + "/state"
    p["stateUrl"] = _url(p.get("stateUrl", inferred_state), suffix="/tools/state")
    origins = {(u.scheme, u.hostname, u.port) for u in map(
        urllib.parse.urlsplit, (p["modelBaseUrl"], p["executorUrl"], p["stateUrl"]))}
    if len(origins) != 1:
        raise RuntimeFault("endpoint_origin_mismatch")
    tools = p.get("tools")
    if not isinstance(tools, list) or len(tools) > 32:
        raise RuntimeFault("invalid_tools")
    names = set()
    for tool in tools:
        if not isinstance(tool, dict) or tool.get("type") != "function":
            raise RuntimeFault("invalid_tool_schema")
        fn = tool.get("function")
        if not isinstance(fn, dict):
            raise RuntimeFault("invalid_tool_schema")
        name = fn.get("name")
        if (not isinstance(name, str) or not _NAME.fullmatch(name)
                or name in names or name in _NATIVE_SPECIAL):
            raise RuntimeFault("invalid_tool_name")
        if not isinstance(fn.get("parameters"), dict) or fn["parameters"].get("type") != "object":
            raise RuntimeFault("invalid_tool_schema")
        names.add(name)
    p["history"] = _history(p.get("history", []))
    if _redact_result(p["history"], capability) != p["history"]:
        raise RuntimeFault("history_contains_capability")
    return p


def _strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError()
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValueError()

    def finite_float(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError()
        return number

    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant, parse_float=finite_float)


def _message(value, *, native=False):
    """Canonical OpenAI wire fields only; native metadata is not authority."""
    if not isinstance(value, dict) or value.get("role") not in {"user", "assistant", "tool"}:
        raise RuntimeFault("invalid_history_message")
    role = value["role"]
    allowed = {"role", "content"}
    if role == "assistant":
        allowed.update({"tool_calls", "reasoning_content"})
    elif role == "tool":
        allowed.update({"tool_call_id", "name"})
    if not native and not set(value).issubset(allowed):
        raise RuntimeFault("invalid_history_fields")
    content = value.get("content")
    if role == "assistant" and content is None:
        content = ""
    if not isinstance(content, str):
        raise RuntimeFault("invalid_history_content")
    result = {"role": role, "content": content}
    if role == "assistant":
        reasoning = value.get("reasoning_content")
        if reasoning is not None:
            if not isinstance(reasoning, str):
                raise RuntimeFault("invalid_history_reasoning")
            # A provider's whitespace pad has no semantic content. The pinned
            # runtime will reapply its required wire pad for the active model.
            if reasoning.strip():
                result["reasoning_content"] = reasoning
        calls = value.get("tool_calls")
        if calls is not None:
            if not isinstance(calls, list) or len(calls) > 32:
                raise RuntimeFault("invalid_history_tool_calls")
            copied = []
            for call in calls:
                if (not isinstance(call, dict) or set(call) != {"id", "type", "function"}
                        or call.get("type") != "function" or not isinstance(call.get("id"), str)
                        or not _ID.fullmatch(call["id"])):
                    raise RuntimeFault("invalid_history_tool_call")
                fn = call["function"]
                if (not isinstance(fn, dict) or set(fn) != {"name", "arguments"}
                        or not isinstance(fn.get("name"), str) or not _NAME.fullmatch(fn["name"])
                        or not isinstance(fn.get("arguments"), str)):
                    raise RuntimeFault("invalid_history_tool_call")
                try:
                    if len(fn["arguments"].encode("utf-8")) > 65536 or not isinstance(_strict_json(fn["arguments"]), dict):
                        raise ValueError()
                except (ValueError, TypeError, UnicodeError):
                    raise RuntimeFault("invalid_history_tool_arguments") from None
                copied.append({"id": call["id"], "type": "function", "function": dict(fn)})
            if copied:
                result["tool_calls"] = copied
    elif role == "tool":
        call_id = value.get("tool_call_id")
        if not isinstance(call_id, str) or not _ID.fullmatch(call_id):
            raise RuntimeFault("invalid_history_tool_id")
        result["tool_call_id"] = call_id
        if "name" in value:
            if not isinstance(value["name"], str) or not _NAME.fullmatch(value["name"]):
                raise RuntimeFault("invalid_history_tool_name")
            result["name"] = value["name"]
    return result


def _history(value, *, native=False):
    if not isinstance(value, list) or len(value) > MAX_HISTORY_MESSAGES + (1 if native else 0):
        raise RuntimeFault("invalid_history")
    result, seen, pending = [], set(), {}
    for item in value:
        if native and isinstance(item, dict) and item.get("role") == "system":
            continue
        message = _message(item, native=native)
        if message["role"] == "tool":
            name = pending.pop(message["tool_call_id"], None)
            if name is None or ("name" in message and message["name"] != name):
                raise RuntimeFault("history_tool_receipt_mismatch")
        else:
            if pending:
                raise RuntimeFault("history_pending_tool_calls")
            for call in message.get("tool_calls", []):
                if call["id"] in seen:
                    raise RuntimeFault("history_duplicate_tool_id")
                seen.add(call["id"])
                pending[call["id"]] = call["function"]["name"]
        result.append(message)
    if pending:
        raise RuntimeFault("history_pending_tool_calls")
    try:
        size = len(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8"))
    except (ValueError, TypeError, UnicodeError):
        raise RuntimeFault("invalid_history") from None
    if len(result) > MAX_HISTORY_MESSAGES or size > MAX_HISTORY_BYTES:
        raise RuntimeFault("history_too_large")
    return result


class _FrameReader:
    """Bounded pipe reads with a deadline, also usable with offline StringIO.

    Own the stream from the first frame: mixing buffered readline and os.read
    would lose a response already prefetched by the Python IO buffer.
    """
    def __init__(self, stream):
        self.stream = stream
        self.buffer = bytearray()
        try:
            self.fd = stream.fileno()
        except (AttributeError, OSError, ValueError):
            self.fd = None

    def _read(self, limit, deadline_ms=None):
        if deadline_ms is not None and deadline_ms <= time.time() * 1000:
            raise RuntimeFault("deadline_exceeded")
        if self.fd is None:
            chunk = self.stream.read(limit)
            if isinstance(chunk, str):
                chunk = chunk.encode("utf-8")
        else:
            if deadline_ms is not None:
                remaining = max(0, (deadline_ms - time.time() * 1000) / 1000)
                ready, _, _ = select.select([self.fd], [], [], remaining)
                if not ready:
                    raise RuntimeFault("deadline_exceeded")
            chunk = os.read(self.fd, limit)
        if deadline_ms is not None and deadline_ms <= time.time() * 1000:
            raise RuntimeFault("deadline_exceeded")
        if not isinstance(chunk, bytes):
            raise RuntimeFault("invalid_stdio_frame")
        return chunk

    def line(self, limit, deadline_ms=None, *, require_newline=True):
        while True:
            newline = self.buffer.find(b"\n")
            if newline >= 0:
                raw = bytes(self.buffer[:newline + 1])
                del self.buffer[:newline + 1]
                if len(raw) > limit:
                    raise RuntimeFault("stdio_frame_too_large")
                return raw
            if len(self.buffer) >= limit:
                raise RuntimeFault("stdio_frame_too_large")
            # StringIO is an offline seam; production always reads the pipe fd.
            chunk = self._read(min(65536, limit - len(self.buffer)), deadline_ms)
            if not chunk:
                if self.buffer and not require_newline:
                    raw = bytes(self.buffer)
                    self.buffer.clear()
                    return raw
                raise RuntimeFault("stdio_closed")
            self.buffer.extend(chunk)

    def rest(self, limit):
        data = bytes(self.buffer)
        self.buffer.clear()
        while len(data) <= limit:
            chunk = self._read(min(65536, limit + 1 - len(data)))
            if not chunk:
                return data
            data += chunk
        raise RuntimeFault("stdio_frame_too_large")


class _StdioChannel:
    """One task's synchronous framed transport; never opens a network socket."""
    def __init__(self, payload, reader, writer):
        self.payload = _validate(payload)
        if self.payload.get("transport") != "stdio":
            raise RuntimeFault("invalid_stdio_transport")
        self.reader = reader if isinstance(reader, _FrameReader) else _FrameReader(reader)
        self.writer = writer
        self.lock = threading.Lock()
        self.next_id = 1
        self.fault = None
        self.diagnostic = None
        self.exchange_stage = "stdio_write"
        self.on_fault = lambda code: None

    def fail(self, code):
        self.fault = self.fault or code
        self.diagnostic = self.diagnostic or _diagnostic(self.fault, self.exchange_stage)
        self.on_fault(self.fault)
        raise RuntimeFault(self.fault)

    def exchange(self, url, body, headers, timeout, *, allowed_paths=_STDIO_PATHS):
        if self.fault:
            raise RuntimeFault(self.fault)
        try:
            if type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0:
                raise RuntimeFault("deadline_exceeded")
            parsed = urllib.parse.urlsplit(_url(url))
            # The host owns model and tool execution lifetimes, including their
            # admitted caps and cancellation/cleanup. A shorter local pipe wait
            # must not abandon a request still pending at the host. State reads
            # and exact long-test polls retain their narrower bounded waits.
            deadline_ms = self.payload["deadlineMs"] if parsed.path in ("/v1/chat/completions", "/tools/execute") else min(
                self.payload["deadlineMs"], time.time() * 1000 + timeout * 1000)
            remaining = (deadline_ms - time.time() * 1000) / 1000
            if remaining <= 0 or not self.lock.acquire(timeout=remaining):
                raise RuntimeFault("deadline_exceeded")
            try:
                if self.fault:
                    raise RuntimeFault(self.fault)
                _deadline({"deadlineMs": deadline_ms})
                expected = urllib.parse.urlsplit(self.payload["modelBaseUrl"])
                if ((parsed.scheme, parsed.hostname, parsed.port) !=
                        (expected.scheme, expected.hostname, expected.port)
                        or parsed.path not in allowed_paths or parsed.path not in _STDIO_PATHS):
                    raise RuntimeFault("stdio_endpoint_denied")
                normalized = {key.lower(): value for key, value in headers.items()}
                if (normalized.get("authorization") != "Bearer " + self.payload["capability"]
                        or normalized.get("content-type") != "application/json"):
                    raise RuntimeFault("rpc_authority_rejected")
                if not isinstance(body, dict):
                    raise RuntimeFault("invalid_stdio_request")
                request_id = self.next_id
                frame = {"type": "request", "id": request_id, "method": "POST", "path": parsed.path,
                         "headers": {"authorization": normalized["authorization"],
                                     "content-type": "application/json"}, "body": body}
                raw = json.dumps(frame, allow_nan=False, separators=(",", ":")) + "\n"
                if len(raw.encode("utf-8")) > MAX_INPUT_BYTES:
                    raise RuntimeFault("stdio_frame_too_large")
                self.next_id += 1
                self.exchange_stage = "stdio_write"
                self.writer.write(raw)
                self.writer.flush()
                self.exchange_stage = "stdio_read"
                response = _strict_json(self.reader.line(MAX_RESPONSE_BYTES, deadline_ms))
                self.exchange_stage = "stdio_response"
                _deadline({"deadlineMs": deadline_ms})
                if self.fault:
                    raise RuntimeFault(self.fault)
                if (not isinstance(response, dict) or set(response) != {"type", "id", "status", "body"}
                        or response["type"] != "response" or type(response["id"]) is not int
                        or response["id"] != request_id or type(response["status"]) is not int
                        or not 100 <= response["status"] <= 599 or not isinstance(response["body"], dict)):
                    raise RuntimeFault("invalid_stdio_response")
                status = response["status"]
                if 300 <= status < 400:
                    raise RuntimeFault("rpc_redirect_denied")
                if status in (401, 403, 409):
                    raise RuntimeFault("rpc_authority_rejected")
                return status, response["body"]
            except RuntimeFault as exc:
                # Latch before releasing the lock: a waiting caller must never
                # emit another request after a fatal response or framing error.
                self.fault = self.fault or exc.code
                self.diagnostic = self.diagnostic or _diagnostic(self.fault, self.exchange_stage)
                self.on_fault(self.fault)
                raise
            except Exception:
                self.fault = self.fault or "invalid_stdio_response"
                self.diagnostic = self.diagnostic or _diagnostic(self.fault, self.exchange_stage)
                self.on_fault(self.fault)
                raise
            finally:
                self.lock.release()
        except RuntimeFault as exc:
            self.fail(exc.code)
        except Exception:
            self.fail("invalid_stdio_response")

    def __call__(self, url, body, headers, timeout):
        status, response = self.exchange(url, body, headers, timeout,
                                         allowed_paths={"/tools/execute", "/tools/state"})
        if status != 202:
            if status not in (200, 400):
                self.fail("rpc_http_error")
            return response
        policy = self.payload.get("longTestPolicy")
        arguments = body.get("arguments")
        if isinstance(arguments, str):
            try:
                arguments = _strict_json(arguments)
            except Exception:
                self.fail("invalid_test_job")
        if (policy != _LONG_TEST_POLICY or url != self.payload["executorUrl"]
                or body.get("name") != "run_bash" or not isinstance(arguments, dict)
                or arguments.get("command") not in _LONG_TEST_POLICY["commands"]):
            self.fail("unexpected_test_job")
        expected_keys = {"kind", "jobId", "callId", "taskId", "requestId", "ownerEpoch", "name", "deadlineMs"}
        if (set(response) != expected_keys or response.get("kind") != "test_job_pending"
                or not isinstance(response.get("jobId"), str)
                or not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", response["jobId"])
                or response.get("callId") != body.get("callId") or response.get("name") != "run_bash"
                or any(response.get(key) != self.payload[key] for key in ("taskId", "requestId", "ownerEpoch"))
                or type(response.get("deadlineMs")) not in (int, float)
                or not math.isfinite(response["deadlineMs"]) or response["deadlineMs"] > self.payload["deadlineMs"]
                or response["deadlineMs"] > time.time()*1000 + _LONG_TEST_POLICY["commands"][arguments["command"]]["timeoutMs"]):
            self.fail("test_job_binding_rejected")
        pending = dict(response)
        deadline_ms = pending["deadlineMs"]
        poll_url = self.payload["executorUrl"].rsplit("/", 1)[0] + "/jobs/poll"
        poll_body = {key: pending[key] for key in ("taskId", "requestId", "ownerEpoch", "callId", "jobId")}
        def job_time():
            try:
                return _deadline({"deadlineMs": deadline_ms})
            except RuntimeFault as exc:
                self.fail(exc.code)
        for _ in range(_LONG_TEST_POLICY["maxPolls"]):
            remaining = job_time()
            status, response = self.exchange(poll_url, poll_body, headers, remaining,
                                             allowed_paths={"/tools/jobs/poll"})
            job_time()
            if status == 202:
                if response != pending:
                    self.fail("test_job_binding_rejected")
                continue
            if status not in (200, 400):
                self.fail("rpc_http_error")
            if (set(response) != {"kind", "jobId", "callId", "receipt"}
                    or response.get("kind") != "test_job_complete" or response.get("jobId") != pending["jobId"]
                    or response.get("callId") != pending["callId"] or not isinstance(response.get("receipt"), dict)):
                self.fail("test_job_receipt_rejected")
            receipt = response["receipt"]
            if (receipt.get("tool_call_id") != pending["callId"] or receipt.get("name") != "run_bash"
                    or type(receipt.get("ok")) is not bool or not isinstance(receipt.get("content"), str)
                    or (status == 200) != receipt["ok"]):
                self.fail("test_job_receipt_rejected")
            return receipt
        self.fail("test_job_poll_limit")


def _stdio_http_client(channel, timeout):
    """Constructed only in stdio native mode; no default HTTP transport exists."""
    import httpx

    class StdioTransport(httpx.BaseTransport):
        def handle_request(self, request):
            try:
                if request.method != "POST":
                    channel.fail("stdio_method_denied")
                raw = request.read()
                if len(raw) > MAX_INPUT_BYTES:
                    channel.fail("stdio_frame_too_large")
                body = _strict_json(raw)
                status, response = channel.exchange(str(request.url), body, dict(request.headers), timeout,
                                                    allowed_paths={"/v1/chat/completions"})
                return httpx.Response(status, json=response, headers={"content-type": "application/json"},
                                      request=request)
            except RuntimeFault:
                raise
            except Exception:
                channel.fail("invalid_stdio_request")

    return httpx.Client(transport=StdioTransport(), timeout=timeout, trust_env=False, follow_redirects=False)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeFault("rpc_redirect_denied")


def _http_transport(url, body, headers, timeout):
    """One attempt; no ambient proxy, redirect, cookie or credential handling."""
    request = urllib.request.Request(url, data=json.dumps(body, allow_nan=False).encode(),
                                     headers=headers, method="POST")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    try:
        response = opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as exc:
        # Failed finish checks are recoverable tool results; auth/fencing is not.
        if exc.code in (401, 403, 409):
            exc.close()
            raise RuntimeFault("rpc_authority_rejected") from None
        if exc.code != 400:
            exc.close()
            raise RuntimeFault("rpc_http_error") from None
        response = exc
    except RuntimeFault:
        raise
    except Exception:
        raise RuntimeFault("rpc_transport_error") from None
    try:
        with response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError()
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except Exception:
        raise RuntimeFault("invalid_rpc_response") from None


def _config(payload):
    return {
        "model": {"provider": "custom", "default": payload["model"],
                  "base_url": payload["modelBaseUrl"], "context_length": 64000,
                  "max_tokens": payload["maxTokens"]},
        "fallback_providers": [], "plugins": {"enabled": [], "entries": {}},
        "mcp_servers": {}, "tools": {"tool_search": {"enabled": "off"}},
        "context": {"engine": "compressor"},
        "compression": {"enabled": False, "micro_compact": False, "proactive_prune_tokens": 0},
        "agent": {"api_max_retries": 1, "environment_probe": False,
                  "bot_mode_protocol": False, "intent_ack_continuation": False,
                  "tool_use_enforcement": False, "max_turns": payload["maxIterations"]},
        "memory": {"memory_enabled": False, "user_profile_enabled": False, "provider": ""},
        "skills": {"creation_nudge_interval": 0},
        "auxiliary": {"title_generation": {"enabled": False},
                      "background_review": {"enabled": False}},
        "curator": {"enabled": False}, "sessions": {"write_json_snapshots": False},
        "telemetry": {"shared_metrics": {"enabled": False}},
    }


@contextlib.contextmanager
def _clean_environment(payload, *, restore):
    previous_env, previous_cwd = dict(os.environ), os.getcwd()
    with tempfile.TemporaryDirectory(prefix="gary-hermes-task-") as directory:
        root = Path(directory)
        for name in ("home", "hermes", "plugins", "config", "cache", "data", "tmp", "work"):
            (root / name).mkdir(mode=0o700)
        config = root / "hermes" / "config.yaml"
        config.write_text(json.dumps(_config(payload)), encoding="utf-8")
        config.chmod(0o600)
        # Actual child-process homes, not references to the operator's home.
        clean = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "TZ": "UTC",
                 "HOME": str(root / "home"), "HERMES_HOME": str(root / "hermes"),
                 "XDG_CONFIG_HOME": str(root / "config"), "XDG_CACHE_HOME": str(root / "cache"),
                 "XDG_DATA_HOME": str(root / "data"), "TMPDIR": str(root / "tmp"),
                 "HERMES_BUNDLED_PLUGINS": str(root / "plugins"),
                 "HERMES_ENABLE_PROJECT_PLUGINS": "0", "PYTHONNOUSERSITE": "1",
                 "PYTHONDONTWRITEBYTECODE": "1"}
        os.environ.clear()
        os.environ.update(clean)
        os.chdir(root / "work")
        try:
            yield
        finally:
            os.chdir(previous_cwd)
            os.environ.clear()
            # Never reintroduce operator credentials into a real native worker.
            if restore:
                os.environ.update(previous_env)


def _native_factory(*, agent_kwargs, tools, tool_handlers):
    """Load only the operator's vendored pin, after the isolated bootstrap."""
    global _NATIVE_STARTED
    if _NATIVE_STARTED or any(name in sys.modules for name in ("run_agent", "model_tools", "hermes_constants")):
        raise RuntimeFault("native_process_reuse_denied")
    _NATIVE_STARTED = True
    runtime = Path(__file__).resolve().parent.parent
    source = runtime / "vendor" / "hermes"
    if source.is_symlink() or not (source / "run_agent.py").is_file():
        raise RuntimeFault("invalid_native_source")
    for name in (".env", ".op.env"):
        if os.path.lexists(source / name):
            raise RuntimeFault("native_dotenv_present")
    try:
        provenance = json.loads((runtime / "SOURCE.json").read_text())
        if provenance.get("hermes_revision") != PINNED_REVISION:
            raise ValueError()
    except Exception:
        raise RuntimeFault("native_pin_mismatch") from None
    sys.path.insert(0, str(source))
    # Pinned import seams: these modules define loaders but do not call them.
    # Disable .env/external-secret and machine-managed overlays before run_agent.
    import hermes_cli.env_loader as env_loader
    import hermes_cli.managed_scope as managed_scope
    env_loader.load_hermes_dotenv = lambda **kwargs: []
    managed_scope.get_managed_dir = lambda: None
    # Provider discovery separately scans pip entry points/bundled plugins.
    # Custom OpenAI transport needs no provider profile or discovery.
    import providers
    providers._REGISTRY.clear()
    providers._ALIASES.clear()
    providers._PROVIDER_LIST_CACHE = []
    providers._discovered = True
    from run_agent import AIAgent
    from tools.registry import registry

    for entry in list(registry.get_all_entries()):
        registry.deregister(entry.name)
    for schema in tools:
        fn = schema["function"]
        handler = tool_handlers[fn["name"]]
        registry.register(name=fn["name"], toolset=TOOLSET, schema=copy.deepcopy(fn), handler=handler)
        entry = registry.get_entry(fn["name"])
        if entry is None or entry.handler is not handler or entry.toolset != TOOLSET or entry.schema != fn:
            raise RuntimeFault("registry_binding_mismatch")

    class BoundAgent(AIAgent):
        def _handle_max_iterations(self, messages, api_call_count):
            # The pinned finalizer normally makes a tools-free N+1 summary
            # request here. Gary's physical request budget includes all calls,
            # so acknowledge this known terminal path locally, without the SDK.
            return tool_handlers.iteration_exhausted(api_call_count)

        def _create_openai_client(self, client_kwargs, *, reason, shared):
            opts = dict(client_kwargs)
            opts.update(api_key=agent_kwargs["api_key"], base_url=agent_kwargs["base_url"], max_retries=0)
            # The SDK is still only a caller of Gary's guarded local endpoint.
            opts["timeout"] = _deadline({"deadlineMs": self._gary_deadline},
                                        model_stdio=tool_handlers.stdio_channel is not None)
            if tool_handlers.stdio_channel is not None:
                opts["http_client"] = _stdio_http_client(tool_handlers.stdio_channel, opts["timeout"])
            native = super()._create_openai_client(opts, reason=reason, shared=shared)
            original = native.chat.completions.create
            def guarded_create(*args, **kwargs):
                self._gary_before_request(kwargs)
                try:
                    response = original(*args, **kwargs)
                    tool_handlers.record_model_response(response)
                    return response
                except Exception as exc:
                    if getattr(exc, "status_code", None) in (401, 403, 409):
                        self._gary_fault("model_authority_rejected")
                        raise RuntimeFault("model_authority_rejected") from None
                    raise
            native.chat.completions.create = guarded_create
            return native

        def _build_api_kwargs(self, api_messages, tools_for_api=None):
            kwargs = super()._build_api_kwargs(api_messages, tools_for_api=tools_for_api)
            # Clamp pinned automatic continuation boosts before sending.
            for key in ("max_tokens", "max_completion_tokens", "max_output_tokens"):
                if key in kwargs:
                    kwargs[key] = min(kwargs[key], agent_kwargs["max_tokens"])
            kwargs["temperature"] = agent_kwargs["request_overrides"]["temperature"]
            return kwargs

        def _execute_tool_calls(self, assistant_message, messages, effective_task_id, api_call_count=0):
            for call in assistant_message.tool_calls or []:
                if call.function.name not in tool_handlers or not call.id:
                    self._gary_fault("unapproved_native_tool")
                    raise RuntimeFault("unapproved_native_tool")
            # Gary's bridge owns one sequential executor and original call order.
            # Skip Hermes' native parallel planner and get_active_env lookup.
            self._executing_tools = True
            try:
                return self._execute_tool_calls_sequential(
                    assistant_message, messages, effective_task_id, api_call_count)
            finally:
                self._executing_tools = False

    # Bootstrap hooks are assigned before __init__, which creates an SDK client.
    agent = BoundAgent.__new__(BoundAgent)
    agent._gary_deadline = tool_handlers.deadline_ms
    agent._gary_before_request = tool_handlers.before_request
    agent._gary_fault = tool_handlers.fail
    BoundAgent.__init__(agent, **agent_kwargs)
    # Generic metadata discovery can lazily import a native tool. Remove it
    # again and prove there are no live executor handlers outside Gary's set.
    for entry in list(registry.get_all_entries()):
        if entry.name not in tool_handlers:
            registry.deregister(entry.name)
    if {entry.name for entry in registry.get_all_entries()} != set(tool_handlers):
        raise RuntimeFault("registry_toolset_mismatch")
    for name, handler in tool_handlers.items():
        if registry.get_entry(name).handler is not handler:
            raise RuntimeFault("registry_binding_mismatch")
    return agent


class _Handlers(dict):
    """Private control hooks also reach the guarded native client factory."""


def _assert_tools(agent, expected, expected_schemas):
    try:
        schemas = agent.tools
        names = [t["function"]["name"] for t in schemas]
        if len(names) != len(set(names)) or set(names) != set(expected):
            raise ValueError()
        if set(agent.valid_tool_names) != set(expected):
            raise ValueError()
        actual_by_name = {t["function"]["name"]: t for t in schemas}
        expected_by_name = {t["function"]["name"]: t for t in expected_schemas}
        if actual_by_name != expected_by_name:
            raise ValueError()
    except (AttributeError, KeyError, TypeError, ValueError):
        raise RuntimeFault("native_toolset_mismatch") from None


def run_task(payload, native_factory=None, transport=None):
    """Return a typed execution outcome, never publication authorization.

    The host-created manifest is trusted input; never pass model-generated URLs,
    schemas, capabilities or identity values into this entry point.
    """
    result = {"status": "error", "publicationApproved": False, "text": ""}
    try:
        p = _validate(payload)
        result.update(taskId=p["taskId"].replace(p["capability"], "[REDACTED]"),
                      requestId=p["requestId"].replace(p["capability"], "[REDACTED]"))
        if p.get("transport") == "stdio":
            if not isinstance(transport, _StdioChannel) or transport.payload != p:
                raise RuntimeFault("invalid_stdio_transport")
        elif isinstance(transport, _StdioChannel):
            raise RuntimeFault("invalid_stdio_transport")
    except RuntimeFault as exc:
        result.update(status="timeout" if exc.code == "deadline_exceeded" else "error", reason=_diagnostic(exc.code, "input_validation")["code"],
                      diagnostic=_diagnostic(exc.code, "input_validation"))
        return result
    if not _RUN_LOCK.acquire(blocking=False):
        return dict(result, reason="concurrent_task_denied", diagnostic=_diagnostic("concurrent_task_denied", "input_validation"))
    capability = p["capability"]
    fault = [None]
    stage = ["native_init"]
    fault_diagnostic = [None]

    def at_stage(name):
        def decorate(fn):
            def wrapped(*args, **kwargs):
                previous = stage[0]; stage[0] = name
                value = fn(*args, **kwargs)
                stage[0] = previous
                return value
            return wrapped
        return decorate
    count = [0]
    cap_exhausted = [False]
    history = [copy.deepcopy(p["history"]) + [{"role": "user", "content": p["prompt"]}]]
    pending_calls = {}
    seen_calls = {call["id"] for message in p["history"] for call in message.get("tool_calls", [])}
    trace_required = native_factory is None
    trace_active = [False]
    counter_lock = threading.Lock()
    transport = transport or _http_transport
    headers = {"Authorization": "Bearer " + capability, "Content-Type": "application/json",
               "X-Gary-Task-Id": p["taskId"], "X-Gary-Owner-Epoch": p["ownerEpoch"]}

    def fail(code):
        fault[0] = code
        fault_diagnostic[0] = (transport.diagnostic if isinstance(transport, _StdioChannel) else None) or _diagnostic(code, stage[0])

    def guard():
        if fault[0]:
            raise RuntimeFault(fault[0])
        return _deadline(p)

    def rpc(url, body):
        try:
            response = transport(url, body, dict(headers), guard())
            if not isinstance(response, dict):
                raise RuntimeFault("invalid_rpc_response")
            guard()
            return response
        except RuntimeFault as exc:
            fail(exc.code)
            raise
        except Exception:
            fail("rpc_transport_error")
            raise RuntimeFault("rpc_transport_error") from None

    handlers = _Handlers()
    handlers.deadline_ms = p["deadlineMs"]
    handlers.fail = fail
    handlers.stdio_channel = transport if isinstance(transport, _StdioChannel) else None
    if handlers.stdio_channel is not None:
        handlers.stdio_channel.on_fault = fail

    @at_stage("model_request")
    def before_request(kwargs):
        guard()
        if kwargs.get("stream") is True or kwargs.get("model") != p["model"]:
            fail("unsupported_model_request")
            raise RuntimeFault(fault[0])
        for key in ("max_tokens", "max_completion_tokens", "max_output_tokens"):
            if key in kwargs and (type(kwargs[key]) is not int or not 1 <= kwargs[key] <= p["maxTokens"]):
                fail("model_output_cap_exceeded")
                raise RuntimeFault(fault[0])
        if trace_required or "messages" in kwargs:
            try:
                if pending_calls:
                    raise RuntimeFault("unresolved_live_tool_calls")
                native_messages = kwargs.get("messages")
                if (not isinstance(native_messages, list) or not native_messages
                        or any(not isinstance(message, dict) for message in native_messages)):
                    raise RuntimeFault("invalid_history")
                systems = [copy.deepcopy(message) for message in native_messages if message.get("role") == "system"]
                if any(not isinstance(message.get("content"), str) for message in systems):
                    raise RuntimeFault("invalid_history_content")
                # Hermes' pinned conversation loop strips every string content
                # before the SDK call. Replay only our independently recorded
                # manifest, responses and authenticated receipts so those bytes
                # survive unchanged. Native non-system edits/additions have no
                # provenance and cannot enter the provider-visible transcript.
                history[0] = _history(history[0])
                kwargs["messages"] = systems + copy.deepcopy(history[0])
                trace_active[0] = True
            except RuntimeFault as exc:
                fail(exc.code)
                raise
        with counter_lock:
            if count[0] >= p["maxIterations"]:
                fail("model_attempt_limit")
                raise RuntimeFault(fault[0])
            count[0] += 1
    handlers.before_request = before_request

    @at_stage("model_response")
    def record_model_response(response):
        try:
            choices = response.get("choices") if isinstance(response, dict) else response.choices
            if not isinstance(choices, list) or len(choices) != 1:
                raise RuntimeFault("invalid_model_history_response")
            message = choices[0].get("message") if isinstance(choices[0], dict) else choices[0].message
            if hasattr(message, "model_dump"):
                message = message.model_dump(mode="json")
            assistant = _message(message, native=True)
            if assistant["role"] != "assistant" or pending_calls:
                raise RuntimeFault("invalid_model_history_response")
            for call in assistant.get("tool_calls", []):
                if call["id"] in seen_calls:
                    raise RuntimeFault("duplicate_live_tool_call_id")
                if call["function"]["name"] not in handlers:
                    raise RuntimeFault("unapproved_native_tool")
                seen_calls.add(call["id"])
                pending_calls[call["id"]] = {"name": call["function"]["name"],
                                            "arguments": _strict_json(call["function"]["arguments"])}
            history[0].append(assistant)
            trace_active[0] = True
        except RuntimeFault as exc:
            fail(exc.code)
            raise
        except Exception:
            fail("invalid_model_history_response")
            raise RuntimeFault(fault[0]) from None
    handlers.record_model_response = record_model_response

    def iteration_exhausted(native_count):
        guard()
        with counter_lock:
            if (type(native_count) is not int or native_count != p["maxIterations"]
                    or count[0] != p["maxIterations"]):
                fail("unexpected_native_iteration_cap")
                raise RuntimeFault(fault[0])
            cap_exhausted[0] = True
        return "Iteration limit reached; no additional model request was made."
    handlers.iteration_exhausted = iteration_exhausted

    def bind(name):
        @at_stage("tool_call")
        def call(arguments, *, tool_call_id=None, **kwargs):
            guard()
            if tool_call_id is None:
                try:
                    from tools.approval import _approval_tool_call_id
                    tool_call_id = _approval_tool_call_id.get()
                except (ImportError, AttributeError):
                    tool_call_id = None
            if not isinstance(tool_call_id, str) or not _ID.fullmatch(tool_call_id):
                fail("missing_original_tool_call_id")
                raise RuntimeFault(fault[0])
            if not isinstance(arguments, dict):
                fail("invalid_tool_arguments")
                raise RuntimeFault(fault[0])
            if trace_required or trace_active[0]:
                pending = pending_calls.get(tool_call_id)
                if (pending is None or pending["name"] != name
                        or json.dumps(arguments, sort_keys=True, allow_nan=False) !=
                        json.dumps(pending["arguments"], sort_keys=True, allow_nan=False)):
                    fail("untraced_live_tool_call")
                    raise RuntimeFault(fault[0])
            reply = rpc(p["executorUrl"], {"taskId": p["taskId"], "token": capability,
                        "ownerEpoch": p["ownerEpoch"], "callId": tool_call_id,
                        "name": name, "arguments": arguments})
            if (reply.get("tool_call_id") != tool_call_id or reply.get("name") != name
                    or type(reply.get("ok")) is not bool or not isinstance(reply.get("content"), str)):
                fail("tool_receipt_mismatch")
                raise RuntimeFault(fault[0])
            if isinstance(reply.get("state"), dict) and reply["state"].get("invalidated") is True:
                fail("executor_state_invalidated")
                raise RuntimeFault(fault[0])
            content = reply["content"].replace(capability, "[REDACTED]")
            if trace_required or trace_active[0]:
                history[0].append({"role": "tool", "tool_call_id": tool_call_id, "name": name, "content": content})
                pending_calls.pop(tool_call_id)
            return content
        return call

    for tool in p["tools"]:
        name = tool["function"]["name"]
        handlers[name] = bind(name)
    kwargs = {"base_url": p["modelBaseUrl"], "api_key": capability, "provider": "custom",
              "api_mode": "chat_completions", "model": p["model"],
              "max_iterations": p["maxIterations"], "max_tokens": p["maxTokens"],
              "enabled_toolsets": [TOOLSET], "disabled_toolsets": [],
              "quiet_mode": True, "verbose_logging": False, "save_trajectories": False,
              "skip_context_files": True, "load_soul_identity": False, "skip_memory": True,
              "skip_background_review": True, "session_db": None, "fallback_model": [],
              "credential_pool": None, "checkpoints_enabled": False,
              "request_overrides": {"temperature": p["temperature"]},
              "session_id": p["requestId"], "platform": "gary"}
    try:
        with _clean_environment(p, restore=native_factory is not None):
            # Native diagnostic output must never corrupt JSON stdout or expose a
            # capability in SDK diagnostics. Discard it; return fixed error codes.
            with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                agent = (native_factory or _native_factory)(agent_kwargs=kwargs,
                            tools=copy.deepcopy(p["tools"]), tool_handlers=handlers)
                _assert_tools(agent, handlers, p["tools"])
                agent._disable_streaming = True
                agent._skip_mcp_refresh = True
                agent._persist_disabled = True
                agent.compression_enabled = False
                agent._api_max_retries = 1
                agent._fallback_chain = []
                agent._fallback_model = None
                guard()
                stage[0] = "native_run"
                native = agent.run_conversation(p["prompt"], system_message=p.get("systemPrompt", ""),
                                                conversation_history=copy.deepcopy(p["history"]), task_id=p["taskId"])
                guard()
                stage[0] = "native_result"
                _assert_tools(agent, handlers, p["tools"])
                if not isinstance(native, dict):
                    raise RuntimeFault("invalid_native_result")
                text = native.get("final_response")
                result["text"] = text.replace(capability, "[REDACTED]")[:65536] if isinstance(text, str) else ""
                result["nativeCompleted"] = native.get("completed") is True
                stage[0] = "state_read"
                state_reply = rpc(p["stateUrl"], {"taskId": p["taskId"], "ownerEpoch": p["ownerEpoch"]})
                state = state_reply.get("state")
                if state_reply.get("ok") is not True or not isinstance(state, dict):
                    raise RuntimeFault("invalid_state_receipt")
                if state.get("invalidated") is True:
                    raise RuntimeFault("executor_state_invalidated")
                stage[0] = "native_result"
                blocked = state.get("blockedReason")
                summary = state.get("finishSummary")
                native_failed = any(native.get(k) for k in ("interrupted", "failed", "partial", "error"))
                verified_finish = state.get("finishGateMet") is True and isinstance(summary, str) and bool(summary.strip())
                known_cap_exit = (cap_exhausted[0] or (
                    native.get("turn_exit_reason") == f"max_iterations_reached({p['maxIterations']}/{p['maxIterations']})"
                    and type(native.get("api_calls")) is int and native["api_calls"] == p["maxIterations"]))
                if native_failed:
                    result.update(status="error", reason="native_execution_failed",
                                  diagnostic=_diagnostic("native_execution_failed", stage[0]))
                elif isinstance(blocked, str) and blocked.strip():
                    result.update(status="blocked", reason="executor_reported_blocked",
                                  blockedReason=blocked.replace(capability, "[REDACTED]")[:65536])
                elif verified_finish and native.get("completed") is True:
                    result.update(status="finished", finishSummary=summary.replace(capability, "[REDACTED]")[:65536])
                elif (known_cap_exit and count[0] == p["maxIterations"]
                      and native.get("completed") is False and not verified_finish):
                    result.update(status="iteration_cap", reason="model_iteration_limit")
                else:
                    result.update(status="no_finish", reason="no_verified_finish")
                result["modelAttempts"] = count[0]
                if result["status"] != "error":
                    # Only SDK-observed responses and authenticated tool
                    # receipts are exported. Native-local cap summaries and
                    # claimed native.messages never acquire trace authority.
                    result["history"] = _history(_redact_result(history[0], capability))
                return result
    except RuntimeFault as exc:
        return dict(result, status="timeout" if exc.code == "deadline_exceeded" else "error", reason=_diagnostic(exc.code, stage[0])["code"],
                    diagnostic=fault_diagnostic[0] or _diagnostic(exc.code, stage[0]))
    except Exception as exc:
        return dict(result, status="error", reason="native_runtime_error",
                    diagnostic=_diagnostic("native_runtime_error", stage[0], exc))
    finally:
        _RUN_LOCK.release()


def _redact_result(result, capability):
    if not isinstance(capability, str) or not capability:
        return result
    if isinstance(result, str):
        return result.replace(capability, "[REDACTED]")
    if isinstance(result, list):
        return [_redact_result(value, capability) for value in result]
    if isinstance(result, dict):
        return {key: _redact_result(value, capability) for key, value in result.items()}
    return result


def main(*, input_stream=None, output_stream=None, native_factory=None, require_stdio=False):
    # Capture the protocol streams before run_task redirects native diagnostics.
    # Tests may supply StringIO; CLI always uses its original pipe/file streams.
    reader = _FrameReader(input_stream if input_stream is not None else sys.stdin)
    writer = output_stream if output_stream is not None else sys.stdout
    framed = require_stdio
    payload = None
    try:
        raw = reader.line(MAX_INPUT_BYTES, require_newline=False)
        try:
            first = _strict_json(raw)
        except (ValueError, TypeError):
            first = None
        if isinstance(first, dict) and first.get("type") == "start":
            framed = True
            if (set(first) != {"type", "payload"} or not raw.endswith(b"\n")
                    or not isinstance(first["payload"], dict)
                    or first["payload"].get("transport") != "stdio"):
                raise ValueError()
            payload = first["payload"]
            channel = _StdioChannel(payload, reader, writer)
        else:
            if require_stdio:
                raise ValueError()
            # Preserve the original whole-document CLI for HTTP mode, including
            # pretty-printed JSON. Stdio mode must use its explicit start frame.
            raw += reader.rest(MAX_INPUT_BYTES - len(raw))
            payload = _strict_json(raw)
            if isinstance(payload, dict) and payload.get("transport") == "stdio":
                raise ValueError()
            channel = None
    except Exception:
        output = {"status": "error", "publicationApproved": False, "text": "", "reason": "invalid_input_json"}
    else:
        output = run_task(payload, native_factory=native_factory, transport=channel)
    capability = payload.get("capability") if isinstance(payload, dict) else None
    output = _redact_result(output, capability)
    envelope = {"type": "result", "result": output} if framed else output
    writer.write(json.dumps(envelope, allow_nan=False) + "\n")
    writer.flush()
    return 0 if output["status"] in {"finished", "blocked", "no_finish", "iteration_cap"} else 1


if __name__ == "__main__":
    if sys.argv[1:] not in ([], ["--stdio"]):
        raise SystemExit(2)
    raise SystemExit(main(require_stdio=sys.argv[1:] == ["--stdio"]))
