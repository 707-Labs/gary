"""Real main/stdio transport, fake native factory; never imports Hermes or an SDK."""
import sys
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
from gary_runtime import main,RuntimeFault
from test_gary_runtime import FakeFactory
def action(agent):
    channel=agent.handlers.stdio_channel;p=channel.payload
    body={'model':p['model'],'messages':[{'role':'system','content':p['systemPrompt']},{'role':'user','content':p['prompt']}],
          'tools':p['tools'],'max_tokens':p['maxTokens'],'temperature':p['temperature'],'stream':False}
    agent.handlers.before_request(body)
    status,response=channel.exchange(p['modelBaseUrl']+'/chat/completions',body,
        {'Authorization':'Bearer '+p['capability'],'Content-Type':'application/json'},60)
    assert status==200
    response['choices'][0]['message']['content']={'private':p['capability']}
    try: agent.handlers.record_model_response(response)
    except RuntimeFault: pass
raise SystemExit(main(native_factory=FakeFactory(action=action),require_stdio=True))
