import { expect,test } from 'bun:test';
import { createSlackIngressEmitter,sanitizeSlackIngressDiagnostic,slackEnvelopeShape,type SlackIngressDiagnostic } from '../../src/slack/ingress-diagnostics.ts';
test('shape and runtime allowlist discard bodies, IDs, tokens, raw errors and arbitrary event names',()=>{
  const secret='xoxb-never-print-this-or-private-message';
  const expected={appId:'A0C7QFW3PEG',teamId:'T0AA24R7VUZ',botUserId:'U0C7NPEUG1F'};
  const shape=slackEnvelopeShape({type:'events_api',envelope_id:secret,payload:{type:'event_callback',event_id:secret,api_app_id:secret,team_id:secret,
    event:{type:secret,user:secret,channel:secret,text:secret,ts:secret,bot_id:null,subtype:null}}},expected);
  const safe=sanitizeSlackIngressDiagnostic({...shape,component:'service',stage:'service_envelope',text:secret,error:secret,token:secret});
  expect(safe).toMatchObject({eventKind:'other',hasBotId:true,hasSubtype:true,hasText:true,hasThreadTs:false,hasEventId:true});
  expect(JSON.stringify(safe)).not.toContain(secret);expect(safe).not.toHaveProperty('text');
  expect(sanitizeSlackIngressDiagnostic({component:'service',stage:secret})).toBeNull();
  expect(sanitizeSlackIngressDiagnostic({component:{toString:()=> 'service',secret},stage:'service_envelope'})).toBeNull();
  expect(sanitizeSlackIngressDiagnostic({component:'service',stage:'service_envelope',hasText:secret,eventKind:secret})).toEqual({component:'service',stage:'service_envelope'});
});
test('observer throws and rejected promises do not affect callers; emissions are bounded',async()=>{
  const records:SlackIngressDiagnostic[]=[],emit=createSlackIngressEmitter('transport',value=>{records.push(value);throw new Error('never expose');});
  for(let n=0;n<1000;n++)expect(()=>emit('transport_envelope')).not.toThrow();
  expect(records).toHaveLength(257);expect(records.at(-1)).toEqual({component:'transport',stage:'diagnostics_limited'});
  const rejects=createSlackIngressEmitter('service',async()=>{throw new Error('never expose async');});
  expect(()=>rejects('service_envelope')).not.toThrow();await new Promise(resolve=>setTimeout(resolve,0));
  expect(Object.isFrozen(records[0])).toBe(true);
});
test('mention representation and expected identity are booleans, including absent and conflicting fields',()=>{
  const expected={appId:'A0C7QFW3PEG',teamId:'T0AA24R7VUZ',botUserId:'U0C7NPEUG1F'};
  const make=(text:string)=>({type:'events_api',payload:{type:'event_callback',api_app_id:expected.appId,team_id:expected.teamId,
    context_team_id:expected.teamId,event:{type:'app_mention',text,team:expected.teamId,bot_id:null}}});
  const canonical=slackEnvelopeShape(make(`<@${expected.botUserId}>`),expected);
  expect(canonical).toMatchObject({canonicalMention:true,labeledMention:false,payloadAppMatches:true,payloadTeamMatches:true,eventTeamMatches:true,contextTeamMatches:true,hasBotId:true,hasSubtype:false});
  const labeled=slackEnvelopeShape(make(`<@${expected.botUserId}|Never log this display label>`),expected);
  expect(labeled).toMatchObject({canonicalMention:false,labeledMention:true});expect(JSON.stringify(labeled)).not.toContain('Never log');
  const mixed=make(`<@${expected.botUserId}> <@${expected.botUserId}|Gary>`);mixed.payload.team_id='TFOREIGN';mixed.payload.event.team='TFOREIGN';
  expect(slackEnvelopeShape(mixed,expected)).toMatchObject({canonicalMention:true,labeledMention:true,payloadTeamMatches:false,eventTeamMatches:false,payloadAppMatches:true});
  expect(slackEnvelopeShape({},expected)).toMatchObject({canonicalMention:false,labeledMention:false,payloadAppMatches:false,payloadTeamMatches:false,eventTeamMatches:false,contextTeamMatches:false,hasPayload:false,hasEvent:false,hasBotId:false});
});
