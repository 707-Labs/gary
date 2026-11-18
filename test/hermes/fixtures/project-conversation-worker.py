"""Offline stdio fixture; no Hermes, Docker, provider, files, or network access."""
import json
import sys

manifest = json.loads(sys.stdin.readline())["payload"]
history = manifest["history"] + [{"role": "user", "content": manifest["prompt"]}]
request_id = 0


def rpc(path, body):
    global request_id
    request_id += 1
    print(json.dumps({"type": "request", "id": request_id, "method": "POST", "path": path,
                      "headers": {"authorization": "Bearer " + manifest["capability"],
                                  "content-type": "application/json"}, "body": body}), flush=True)
    line = sys.stdin.readline()
    if not line:
        sys.exit(1)
    reply = json.loads(line)
    assert reply["type"] == "response" and reply["id"] == request_id and reply["status"] == 200
    return reply["body"]


for _ in range(manifest["maxIterations"]):
    reply = rpc("/v1/chat/completions", {
        "model": manifest["model"], "messages": history, "tools": manifest["tools"],
        "max_tokens": manifest["maxTokens"], "temperature": manifest["temperature"], "stream": False,
    })
    choice = reply["choices"][0]
    message = choice["message"]
    history.append(message)
    if "tool_calls" not in message:
        assert choice["finish_reason"] == "stop"
        rpc("/tools/state", {"taskId": manifest["taskId"], "ownerEpoch": manifest["ownerEpoch"]})
        print(json.dumps({"type": "result", "result": {
            "taskId": manifest["taskId"], "requestId": manifest["requestId"],
            "status": "no_finish", "publicationApproved": False, "history": history,
        }}), flush=True)
        sys.exit(0)
    for call in message["tool_calls"]:
        tool = call["function"]
        receipt = rpc("/tools/execute", {
            "taskId": manifest["taskId"], "ownerEpoch": manifest["ownerEpoch"],
            "token": manifest["capability"], "callId": call["id"], "name": tool["name"],
            "arguments": json.loads(tool["arguments"]),
        })
        history.append({"role": "tool", "tool_call_id": call["id"],
                        "name": tool["name"], "content": receipt["content"]})
sys.exit(1)
