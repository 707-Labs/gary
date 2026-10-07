"""Actual pinned Hermes + local fake model/RPC server. No provider or tool execution."""
import hashlib,json,os,socket,subprocess,sys,threading,time,traceback
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
sys.path.insert(0,str(Path(__file__).parent))
import gary_runtime
state={'finishSummary':None,'blockedReason':None,'finishGateMet':False,'invalidated':False}
calls=[];model_requests=[];blocked_egress=[];diagnostics=[]
token='offline-fixture-capability-not-a-credential-000000000'
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  length=int(self.headers.get('content-length','0'))
  if length>1048576:self.send_error(413);return
  body=json.loads(self.rfile.read(length))
  if self.headers.get('authorization')!='Bearer '+token:self.send_error(401);return
  if self.path=='/v1/chat/completions':
   model_requests.append(body)
   number=len(model_requests)
   if number==1: name,args='run_bash',{'command':'bun run check'}
   elif number==2:name,args='finish',{'summary':'offline fixture verified'}
   else:name,args=None,None
   message={'role':'assistant','content':None if name else 'Offline fixture verified.'}
   if name:message['tool_calls']=[{'id':'fixture_call_'+str(number),'type':'function','function':{'name':name,'arguments':json.dumps(args)}}]
   response={'id':'fixture_completion_'+str(number),'object':'chat.completion','created':int(time.time()),'model':'deepseek-v4-pro','choices':[{'index':0,'message':message,'finish_reason':'tool_calls' if name else 'stop'}],'usage':{'prompt_tokens':10,'completion_tokens':5,'total_tokens':15}}
  elif self.path=='/tools/execute':
   calls.append({k:body.get(k) for k in ['callId','name','arguments']})
   if body['name']=='run_bash' and body['arguments']=={'command':'bun run check'}:state['finishGateMet']=True
   if body['name']=='finish' and state['finishGateMet']:state['finishSummary']=body['arguments']['summary']
   response={'ok':True,'tool_call_id':body['callId'],'name':body['name'],'content':'fixture operation acknowledged','state':dict(state),'truncated':False}
  elif self.path=='/tools/state':response={'ok':True,'state':dict(state),'runLog':[]}
  else:self.send_error(404);return
  data=json.dumps(response).encode();self.send_response(200);self.send_header('content-type','application/json');self.send_header('content-length',str(len(data)));self.end_headers();self.wfile.write(data)
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
port=server.server_address[1]
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
real_connect=socket.socket.connect
real_connect_ex=socket.socket.connect_ex
real_getaddrinfo=socket.getaddrinfo

def address_allowed(address):
 return isinstance(address,tuple) and address[0] in ('127.0.0.1','localhost','::1') and address[1]==port

def safe_connect(sock,address):
 if not address_allowed(address):blocked_egress.append('blocked-nonfixture-connection');raise OSError('offline fixture denies external connection')
 return real_connect(sock,address)
def safe_connect_ex(sock,address):
 if not address_allowed(address):blocked_egress.append('blocked-nonfixture-connection');return 13
 return real_connect_ex(sock,address)
def safe_getaddrinfo(host,requested_port,*args,**kwargs):
 if host not in ('127.0.0.1','localhost','::1') or int(requested_port)!=port:
  blocked_egress.append('blocked-nonfixture-resolution');raise OSError('offline fixture denies external resolution')
 return real_getaddrinfo(host,requested_port,*args,**kwargs)
socket.socket.connect=safe_connect;socket.socket.connect_ex=safe_connect_ex;socket.getaddrinfo=safe_getaddrinfo
# No agent tool may start a local process during this fixture.
def deny_process(*args,**kwargs):raise OSError('offline fixture denies subprocess')
subprocess.Popen=deny_process
original_factory=gary_runtime._native_factory
def diagnosed_factory(**kwargs):
 try:return original_factory(**kwargs)
 except Exception:
  diagnostics.append(traceback.format_exc())
  raise
gary_runtime._native_factory=diagnosed_factory
payload={'taskId':'fixture-task','requestId':'fixture-request','ownerEpoch':'fixture-owner','capability':token,'modelBaseUrl':f'http://127.0.0.1:{port}/v1','executorUrl':f'http://127.0.0.1:{port}/tools/execute','stateUrl':f'http://127.0.0.1:{port}/tools/state','model':'deepseek-v4-pro','prompt':'Use run_bash to verify the fixture, then finish with a concise summary.','systemPrompt':'You are Gary. This is an offline protocol fixture. Use only the supplied tools.','tools':json.loads((Path(__file__).parent/'native-smoke-tools.json').read_text()),'maxIterations':4,'maxTokens':128,'temperature':0.3,'deadlineMs':int(time.time()*1000)+45000}
result=gary_runtime.run_task(payload)
server.shutdown();server.server_close()
for request in model_requests:
 # Payload contains only generated fixture content and the clean runtime system prompt.
 request.pop('api_key',None)
print(json.dumps({'actual_native_hermes':True,'result':result,'tool_calls':calls,'model_requests':model_requests,'nonfixture_connection_attempts_blocked':len(blocked_egress),'diagnostics':diagnostics,'real_provider_calls':0,'real_executor_calls':0}))
