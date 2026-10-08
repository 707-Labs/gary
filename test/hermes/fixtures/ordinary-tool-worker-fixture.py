"""One real offline child; command text is data for a fake host executor only."""
import json
import os
import sys

start = json.loads(sys.stdin.readline())
p = start['payload']
assert p['transport'] == 'stdio'
print(json.dumps({'type': 'request', 'id': 1, 'method': 'POST', 'path': '/tools/execute',
    'headers': {'authorization': 'Bearer ' + p['capability'], 'content-type': 'application/json'},
    'body': {'taskId': p['taskId'], 'ownerEpoch': p['ownerEpoch'], 'token': p['capability'],
        'callId': 'ordinary-call', 'name': 'run_bash',
        'arguments': {'command': 'offline-held-' + str(os.getpid())}}}), flush=True)
line = sys.stdin.readline()
if not line:
    sys.exit(1)
reply = json.loads(line)
assert reply['id'] == 1
print(json.dumps({'type': 'result', 'result': {'taskId': p['taskId'], 'requestId': p['requestId'],
    'status': 'no_finish', 'publicationApproved': False}}), flush=True)
