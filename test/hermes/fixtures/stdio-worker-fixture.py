import json, os, subprocess, sys, time

mode = sys.argv[1]
start = json.loads(sys.stdin.readline())
p = start['payload']
assert start['type'] == 'start' and p['transport'] == 'stdio'

def emit(value):
    print(json.dumps(value), flush=True)

frame = {'type': 'request', 'id': 1, 'method': 'POST',
         'path': '/tools/state',
         'headers': {'authorization': 'Bearer ' + p['capability'], 'content-type': 'application/json'},
         'body': {'taskId': p['taskId'], 'ownerEpoch': p['ownerEpoch']}}
result = {'type': 'result', 'result': {'taskId': p['taskId'], 'requestId': p['requestId'],
          'status': 'no_finish', 'publicationApproved': False}}
if mode == 'sleep':
    time.sleep(30)
elif mode == 'huge':
    print('x' * 1048577, flush=True)
elif mode == 'partial':
    sys.stdout.write('{'); sys.stdout.flush()
elif mode == 'garbage':
    print('not json', flush=True)
elif mode == 'missing':
    pass
elif mode == 'env':
    frame['body']['secretInherited'] = 'GARY_TEST_OPERATOR_SECRET' in os.environ
    emit(frame); json.loads(sys.stdin.readline()); emit(result)
elif mode == 'bad_result':
    result['result']['requestId'] = 'wrong'; emit(result)
elif mode == 'publish':
    result['result']['publicationApproved'] = True; emit(result)
elif mode == 'text':
    result['result']['text'] = p['capability'] + ' notes' * 20000
    emit(result)
elif mode == 'secret_history':
    result['result']['history'] = [{'role':'user','content':p['capability']}]
    emit(result)
elif mode == 'overflow':
    frame['body']['nested'] = [{'marker': 'REPLACE'}]
    print(json.dumps(frame).replace('"REPLACE"', '1e309'), flush=True)
    sys.stdin.readline()
    emit(result)
elif mode == 'descendant_stdout':
    # Escaping the original process group models an isolated worker that outlives
    # its CLI. The callback must reap this exact fixture before waiting for EOF.
    descendant = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(1.2)'],
                                  stdin=subprocess.DEVNULL, start_new_session=True)
    frame['body']['descendantPid'] = descendant.pid
    emit(frame); json.loads(sys.stdin.readline()); emit(result)
else:
    if mode == 'auth': frame['headers']['authorization'] = 'Bearer wrong'
    if mode == 'path': frame['path'] = '/provider-key'
    if mode == 'header': frame['headers']['x-extra'] = 'bad'
    if mode == 'id': frame['id'] = 2
    emit(frame)
    response = json.loads(sys.stdin.readline())
    assert response['type'] == 'response' and response['id'] == 1
    assert response['status'] == 200
    if mode == 'duplicate':
        emit(frame); sys.stdin.readline()
    else:
        emit(result)
        if mode == 'after': emit(frame)
        if mode == 'sleep_after': time.sleep(30)
        if mode == 'exit1': sys.exit(1)
