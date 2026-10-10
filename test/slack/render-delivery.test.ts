import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { createSlackService, GARY_SLACK } from '../../src/slack/service.ts';
import { createSlackTransport, type SlackSocket } from '../../src/slack/transport.ts';
import { renderSlackReply } from '../../src/slack/render.ts';

test('actual chat.postMessage JSON contains the single rendered answer whose hash was durably claimed',async()=>{
  const db=new Database(':memory:',{strict:true}),posts:Record<string,unknown>[]=[],listeners=new Map<string,Set<(event:unknown)=>void>>();
  let socketCreated=false,delivered=false;
  const socket:SlackSocket={readyState:1,send(){},close(){},
    addEventListener(type,listener){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type)!.add(listener);},
    removeEventListener(type,listener){listeners.get(type)?.delete(listener);}};
  const markdown='## **Ticket summary**\n\n| Ticket | State |\n| --- | --- |\n| [ERT-1](https://example.invalid/ERT-1) | **failed** |\n\n`a_b` 🐌 <@U0A9M5W16F8>';
  const expected='*Ticket summary*\n\n• Ticket: <https://example.invalid/ERT-1|ERT-1> · State: *failed*\n\n`a_b` 🐌 <@U0A9M5W16F8>';
  const expectedHash=createHash('sha256').update(expected).digest('hex');
  const transport=createSlackTransport({credentials:{botToken:'xoxb-offline-fixture',appToken:'xapp-offline-fixture'},
    fetch:async(url,init)=>{
      if(url.endsWith('/auth.test'))return Response.json({ok:true,team_id:GARY_SLACK.teamId,user_id:GARY_SLACK.botUserId,bot_id:'B0FIXTURE1'});
      if(url.endsWith('/apps.connections.open'))return Response.json({ok:true,url:'wss://wss-primary.slack.com/link/?ticket=offline'});
      if(!url.endsWith('/chat.postMessage'))throw new Error('unexpected offline route');
      const payload=JSON.parse(String(init.body));posts.push(payload);
      expect(db.query('SELECT status,content_sha256 FROM gary_slack_shared_outbox').get()).toEqual({status:'unknown',content_sha256:expectedHash});
      return Response.json({ok:true,channel:payload.channel,ts:'1791621110.736429'});
    },createSocket(){socketCreated=true;return socket;},maxReconnectAttempts:0});
  const service=createSlackService({db,transport,checkHostHealth:()=>({ready:false,hermesCanarySucceeded:false,receiptId:'offline'}),
    checkConversationHealth:()=>true,sharedConversation:{joined:()=>true,ready:()=>true,close:()=>({drained:true}),async respond(_input,deliver){
      expect(await deliver(markdown,'answer',async()=>true)).toBe('sent');expect(await deliver(markdown,'answer',async()=>true)).toBe('sent');delivered=true;
    }}});
  async function until(check:()=>boolean){for(let i=0;i<100&&!check();i++)await new Promise(resolve=>setTimeout(resolve,1));expect(check()).toBe(true);}
  const frame=(value:unknown)=>{for(const listener of listeners.get('message')??[])listener({data:JSON.stringify(value)});};
  try {
    const start=service.start();await until(()=>socketCreated);frame({type:'hello',connection_info:{app_id:GARY_SLACK.appId}});await start;
    const event={type:'events_api',envelope_id:'offline-fixture',payload:{type:'event_callback',api_app_id:GARY_SLACK.appId,team_id:GARY_SLACK.teamId,event_id:'EvRenderFixture',
      event:{type:'app_mention',user:GARY_SLACK.tannerId,channel:'C0FIXTURE1',ts:'1791621087.960559',text:`<@${GARY_SLACK.botUserId}> give an exhaustive summary`}}};
    frame(event);await until(()=>delivered);frame(event);await service.stop();
    expect(renderSlackReply(markdown)).toBe(expected);
    expect(posts).toEqual([{channel:'C0FIXTURE1',text:expected,thread_ts:'1791621087.960559',unfurl_links:false,unfurl_media:false}]);
    expect(db.query('SELECT status,content_sha256 FROM gary_slack_shared_outbox').all()).toEqual([{status:'sent',content_sha256:expectedHash}]);
  } finally {await service.stop();db.close();}
});
