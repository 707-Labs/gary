"""Pinned native worker + fake stdio broker, with child network/process denial.

Every tool result and model response is a fixture. No model provider, executor,
Slack, service configuration or persistent Hermes home is accessed.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).parent))
from gary_runtime import MAX_RESPONSE_BYTES, PINNED_REVISION, _FrameReader, _history, _message, _strict_json


TOKEN = "offline-stdio-fixture-capability-not-a-credential-000000000"
ROOT = Path(__file__).resolve().parents[1]
EXTERNAL_SPEC = json.loads(os.environ["GARY_STDIO_FIXTURE_SPEC_JSON"]) if os.environ.get("GARY_STDIO_FIXTURE_SPEC_JSON") else None
BOOTSTRAP = r'''
import atexit,json,os,runpy,socket,subprocess,sys
from pathlib import Path
runtime=Path(sys.argv[1]); report=Path(sys.argv[2])
blocked=[]
def deny(kind):
 def blocked_operation(*args,**kwargs):
  blocked.append(kind)
  raise OSError('offline stdio fixture denies '+kind)
 return blocked_operation
for method in ('connect','connect_ex','bind','listen','sendto','sendmsg'):
 if hasattr(socket.socket,method):setattr(socket.socket,method,deny('socket.'+method))
for method in ('getaddrinfo','gethostbyname','gethostbyname_ex','gethostbyaddr','getnameinfo','create_connection'):
 if hasattr(socket,method):setattr(socket,method,deny('socket.'+method))
subprocess.Popen=deny('subprocess.Popen')
for method in ('system','popen','fork','forkpty','posix_spawn','posix_spawnp'):
 if hasattr(os,method):setattr(os,method,deny('os.'+method))
def audit(event,args):
 if event.startswith('socket.') or event in ('subprocess.Popen','os.system','os.fork','os.forkpty','os.posix_spawn','os.exec'):
  # Creation is harmless and needed by some standard-library imports; all
  # connect, resolution, bind/listen and datagram operations remain blocked.
  if event=='socket.__new__':return
  blocked.append('audit:'+event)
  raise OSError('offline stdio fixture denies audited I/O')
sys.addaudithook(audit)
def write_report():
 report.write_text(json.dumps({'network_and_subprocess_denial_active':True,'blocked_operations':blocked}))
atexit.register(write_report)
sys.argv=[str(runtime),'--stdio']
runpy.run_path(str(runtime),run_name='__main__')
'''


def completion(number, *, force_cap=False, call_prefix="stdio_fixture_call_"):
    if force_cap:
        assert number <= 2, "physical model cap exceeded"
        name, arguments = "run_bash", {"command": "bun run check"}
    elif number == 1:
        name, arguments = "run_bash", {"command": "bun run check"}
    elif number == 2:
        name, arguments = "finish", {"summary": "offline stdio fixture verified"}
    elif number == 3:
        name, arguments = None, None
    else:
        raise AssertionError("unexpected model request")
    message = {"role": "assistant", "content": "  Fixture tool request.\n" if name else "Offline stdio fixture verified."}
    if name:
        message["tool_calls"] = [{"id": call_prefix + str(number), "type": "function",
                                  "function": {"name": name, "arguments": json.dumps(arguments)}}]
    return {"id": "stdio_fixture_completion_" + str(number), "object": "chat.completion",
            "created": int(time.time()), "model": "deepseek-v4-pro",
            "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if name else "stop"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}


def run_fixture(*, reject_model=False, force_cap=False, initial_history=None):
    label = "history_continuation" if initial_history is not None else "forced_iteration_cap" if force_cap else "authority_rejected" if reject_model else "successful_round_trip"
    call_prefix = "stdio_continuation_call_" if initial_history is not None else "stdio_fixture_call_"
    report = ROOT / ("child-isolation-" + label + ".json")
    deadline = int(time.time() * 1000) + 45_000
    manifest = {
        "transport": "stdio", "taskId": "stdio-fixture-task", "requestId": "stdio-fixture-" + label,
        "ownerEpoch": "stdio-fixture-owner", "capability": TOKEN,
        "modelBaseUrl": "http://127.0.0.1:1/v1", "executorUrl": "http://127.0.0.1:1/tools/execute",
        "stateUrl": "http://127.0.0.1:1/tools/state", "model": "deepseek-v4-pro",
        "prompt": "Use run_bash to verify the fixture, then finish with a concise summary.",
        "systemPrompt": "You are Gary. This is an offline protocol fixture. Use only the supplied tools.",
        "tools": json.loads((ROOT / "python/native-smoke-tools.json").read_text()),
        "maxIterations": 2 if force_cap else 4, "maxTokens": 128, "temperature": 0.3, "deadlineMs": deadline,
    }
    if initial_history is not None:
        manifest["history"] = initial_history
        manifest["prompt"] = "Continue implementation using the previous phase's verified tool observations."
    expected_history = _history(manifest.get("history", [])) + [{"role": "user", "content": manifest["prompt"]}]
    state = {"finishSummary": None, "blockedReason": None, "finishGateMet": False, "invalidated": False}
    env = {"PATH": "/usr/bin:/bin", "HOME": str(ROOT / "empty-home"), "LANG": "C.UTF-8",
           "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1"}
    command = [sys.executable, "-I", "-c", BOOTSTRAP, str(ROOT / "python/gary_runtime.py"), str(report)]
    cwd = ROOT
    if EXTERNAL_SPEC is not None:
        # Only the explicitly supplied reviewed container specification reaches
        # the Docker CLI. No host environment merge, source or credential mount.
        assert isinstance(EXTERNAL_SPEC, dict) and set(EXTERNAL_SPEC) == {"command", "cleanupCommand", "cwd", "env", "containerName"}
        command, cwd, env = EXTERNAL_SPEC["command"], EXTERNAL_SPEC["cwd"], EXTERNAL_SPEC["env"]
        assert isinstance(command, list) and all(isinstance(arg, str) for arg in command)
        assert ["--network", "none"] == command[command.index("--network"):command.index("--network") + 2]
        assert "--read-only" in command and "--stdio" in command and "--rm" in command
        assert not any(arg in {"--volume", "-v", "--mount", "--env", "-e", "--env-file", "--privileged"} for arg in command)
        assert set(env) == {"PATH", "DOCKER_CONFIG", "DOCKER_HOST"}
    process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE)
    ordered, model_shapes, tool_calls = [], [], []
    result = None
    try:
        process.stdin.write((json.dumps({"type": "start", "payload": manifest}) + "\n").encode())
        process.stdin.flush()
        reader = _FrameReader(process.stdout)
        for _ in range(12):
            frame = _strict_json(reader.line(MAX_RESPONSE_BYTES, deadline))
            if frame.get("type") == "result":
                assert set(frame) == {"type", "result"}, "invalid result envelope"
                result = frame["result"]
                assert TOKEN not in json.dumps(result), "capability leaked in result"
                break
            assert set(frame) == {"type", "id", "method", "path", "headers", "body"}, "invalid request shape"
            assert frame["id"] == len(ordered) + 1 and type(frame["id"]) is int, "nonsequential request ID"
            assert frame["method"] == "POST", "non-POST request"
            assert frame["headers"] == {"authorization": "Bearer " + TOKEN, "content-type": "application/json"}
            body, path = frame["body"], frame["path"]
            assert isinstance(body, dict), "non-object request body"
            shape = {"id": frame["id"], "path": path, "bodyKeys": sorted(body), "authorizationMatched": True}
            ordered.append(shape)
            status = 200
            if path == "/v1/chat/completions":
                assert TOKEN not in json.dumps(body), "capability in model content"
                assert body["model"] == "deepseek-v4-pro" and body["max_tokens"] == 128
                assert body["temperature"] == 0.3 and not body.get("stream", False)
                assert sorted(tool["function"]["name"] for tool in body["tools"]) == ["finish", "run_bash"]
                assert _history(body["messages"], native=True) == _history(expected_history), "native SDK request changed exact traced transcript"
                if initial_history is not None and not model_shapes:
                    replay = _history(body["messages"], native=True)
                    assert [message["role"] for message in replay[:len(initial_history)]] == [message["role"] for message in initial_history]
                    expected_tools = [message for message in initial_history if message["role"] == "tool"]
                    actual_tools = [message for message in replay[:len(initial_history)] if message["role"] == "tool"]
                    assert actual_tools == expected_tools, "prior tool receipts changed during phase handoff"
                    assert replay[-1] == {"role": "user", "content": manifest["prompt"]}
                model_shapes.append({
                    "model": body["model"], "max_tokens": body["max_tokens"], "temperature": body["temperature"],
                    "bodyKeys": sorted(body), "toolNames": sorted(tool["function"]["name"] for tool in body["tools"]),
                    "messageRoles": [message["role"] for message in body["messages"]],
                    "toolResultCallIds": [message["tool_call_id"] for message in body["messages"] if message["role"] == "tool"],
                    "bodySha256": hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest(),
                })
                if reject_model:
                    status, reply = 403, {"error": {"message": "offline authority fixture rejected", "type": "permission_error"}}
                else:
                    reply = completion(len(model_shapes), force_cap=force_cap, call_prefix=call_prefix)
                    expected_history.append(_message(reply["choices"][0]["message"]))
            elif path == "/tools/execute":
                assert body["taskId"] == manifest["taskId"] and body["ownerEpoch"] == manifest["ownerEpoch"]
                assert body["token"] == TOKEN
                assert set(body) == {"taskId", "token", "ownerEpoch", "callId", "name", "arguments"}
                call = {key: body[key] for key in ("callId", "name", "arguments")}
                tool_calls.append(call)
                if force_cap:
                    assert len(tool_calls) <= 2
                    assert call == {"callId": call_prefix + str(len(tool_calls)),
                                    "name": "run_bash", "arguments": {"command": "bun run check"}}
                    state["finishGateMet"] = True
                elif len(tool_calls) == 1:
                    assert call == {"callId": call_prefix + "1", "name": "run_bash", "arguments": {"command": "bun run check"}}
                    state["finishGateMet"] = True
                elif len(tool_calls) == 2:
                    assert call == {"callId": call_prefix + "2", "name": "finish", "arguments": {"summary": "offline stdio fixture verified"}}
                    assert state["finishGateMet"]
                    state["finishSummary"] = body["arguments"]["summary"]
                else:
                    raise AssertionError("unexpected tool request")
                shape.update(callId=body["callId"], name=body["name"])
                reply = {"ok": True, "tool_call_id": body["callId"], "name": body["name"],
                         "content": "  fixture operation acknowledged\n\n", "state": dict(state), "truncated": False}
                expected_history.append({"role": "tool", "tool_call_id": body["callId"], "name": body["name"], "content": reply["content"]})
            elif path == "/tools/state":
                assert body == {"taskId": manifest["taskId"], "ownerEpoch": manifest["ownerEpoch"]}
                reply = {"ok": True, "state": dict(state), "runLog": []}
            else:
                raise AssertionError("unapproved RPC path")
            process.stdin.write((json.dumps({"type": "response", "id": frame["id"], "status": status, "body": reply}) + "\n").encode())
            process.stdin.flush()
        assert result is not None, "worker result missing"
        process.stdin.close()
        process.stdin = None
        extra_stdout, stderr = process.communicate(timeout=5)
        assert not extra_stdout.strip(), "unexpected post-result stdout"
        assert not stderr.strip(), "unexpected native stderr"
        assert result["publicationApproved"] is False
        if not reject_model:
            assert _history(result["history"]) == result["history"], "exported history is not canonical/closed"
            assert result["history"] == _history(expected_history), "exported history changed exact traced transcript"
            assert all(message["content"] != "Iteration limit reached; no additional model request was made." for message in result["history"])
        if force_cap:
            assert process.returncode == 0 and result["status"] == "iteration_cap", result
            assert result["reason"] == "model_iteration_limit" and result["nativeCompleted"] is False
            assert result["modelAttempts"] == len(model_shapes) == manifest["maxIterations"] == 2
            assert len(tool_calls) == 2 and state["finishSummary"] is None
            assert [request["path"] for request in ordered] == [
                "/v1/chat/completions", "/tools/execute", "/v1/chat/completions", "/tools/execute", "/tools/state"]
        elif reject_model:
            assert process.returncode == 1 and result["status"] == "error"
            assert result["reason"] in {"rpc_authority_rejected", "model_authority_rejected"}
            assert len(ordered) == len(model_shapes) == 1 and not tool_calls
        else:
            assert process.returncode == 0 and result["status"] == "finished"
            assert result["modelAttempts"] == 3 and len(model_shapes) == 3 and len(tool_calls) == 2
            assert [request["path"] for request in ordered] == [
                "/v1/chat/completions", "/tools/execute", "/v1/chat/completions", "/tools/execute",
                "/v1/chat/completions", "/tools/state"]
        if EXTERNAL_SPEC is None:
            isolation = json.loads(report.read_text())
            assert isolation["network_and_subprocess_denial_active"] is True
        else:
            isolation = {"mode": "reviewed_container_spec", "network": "none", "rootFilesystem": "read-only",
                         "sourceMounts": False, "credentialMounts": False, "workerEnvironmentInherited": False,
                         "subprocessMonkeypatch": False, "containerName": EXTERNAL_SPEC["containerName"]}
        # Requests to get metadata via a forbidden subprocess can be safely
        # caught by Hermes; retain the count rather than pretending no attempt.
        return {"scenario": label, "passed": True, "result": result, "childExit": process.returncode,
                "exactTranscriptVerified": not reject_model,
                "orderedRequests": ordered, "modelRequestShapes": model_shapes, "toolCalls": tool_calls,
                "maxPhysicalModelRequests": manifest["maxIterations"],
                "observedPhysicalModelRequests": len(model_shapes), "isolation": isolation}
    finally:
        if EXTERNAL_SPEC is not None:
            # Exact immutable-spec container name only, including timeout/error.
            subprocess.run(EXTERNAL_SPEC["cleanupCommand"], cwd=EXTERNAL_SPEC["cwd"], env=EXTERNAL_SPEC["env"],
                           capture_output=True, timeout=15)
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)


if __name__ == "__main__":
    cap = run_fixture(force_cap=True)
    results = [run_fixture(), run_fixture(reject_model=True), cap, run_fixture(initial_history=cap["result"]["history"])]
    print(json.dumps({"actualNativeHermes": True, "pinnedRevision": PINNED_REVISION, "transport": "stdio",
                      "passed": all(result["passed"] for result in results), "scenarios": results,
                      "realProviderCalls": 0, "realExecutorCalls": 0,
                      "listenersOpened": 0 if EXTERNAL_SPEC is None else None}))
