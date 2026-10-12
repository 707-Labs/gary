import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { standingBudgetFixture } from './fixtures/engineering-standing.ts';
import { createEngineeringModelAdapter, type EngineeringModelOptions } from '../../src/hermes/engineering-model.ts';
import { EngineeringProtocol } from '../../src/hermes/engineering-protocol.ts';
import { createStandingEngineeringTaskPolicy, createEngineeringTaskPolicy, resolveEngineeringRepository } from '../../src/hermes/engineering-policy.ts';

const clean:Array<()=>void>=[];afterEach(()=>{for(const f of clean.splice(0))f();});
const provider=()=>({id:'fixture',type:'message',role:'assistant',model:'deepseek-v4-pro',content:[{type:'text',text:'Done.'}],
  stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0}});
function fixture(fetch?:EngineeringModelOptions['fetch'],taskCap=4_000_000){
  const f=standingBudgetFixture(taskCap);f.allocator.enrollPool();const budget=f.allocator.allocate(f.input());
  const journalDb=new Database(join(f.root,'journal.sqlite')),spendDb=new Database(f.path,{readonly:true});
  clean.push(()=>{spendDb.close();journalDb.close();f.dispose();});
  const binding={taskId:budget.taskId,sessionId:'session',ownerEpoch:'epoch',deadlineMs:Date.now()+60_000};
  const repository=resolveEngineeringRepository('fixture',{authenticated:true,requesterId:'U0A9M5W16F8',teamId:'T0AA24R7VUZ',
    surface:'private_dm',channelId:'D123456789',threadTs:'1234567890.000001'},[{repositoryId:1,installationId:2,fullName:'707-Labs/fixture',
    appAccessible:true,contents:'write',pullRequests:'write',archived:false,disabled:false,sharedChannelIds:[]}]);
  const policy=createStandingEngineeringTaskPolicy({taskId:budget.taskId,repository,baseCommit:'a'.repeat(40),
    requiredCommands:['bun test'],verificationProfileSha256:'c'.repeat(64),publication:'patch_only',capMicros:taskCap});
  const fences:string[]=[],requests:Request[]=[];
  const protocol=new EngineeringProtocol({binding,transportCapability:'x'.repeat(48),allowedTools:['terminal'],assertOwner(){},append(){},
    fence(reason){fences.push(reason);},execute:async()=>{throw Error('no tools');},close:async()=>({cleanupConfirmed:true})});
  const options:EngineeringModelOptions={binding,policy,allocationId:budget.allocationId,standingBudget:budget,ledger:f.ledger,
    journalDb,spendDb,protocol,tools:[],systemPrompt:'Host task.',providerApiKey:'synthetic',assertOwner(){},fence(r){fences.push(r);},
    fetch:async request=>{requests.push(request);budget.assertCurrent();
      expect(f.ledger.unresolvedAttempts(budget.allocationId)).toHaveLength(1);
      expect(journalDb.query('SELECT ledger_attempt FROM engineering_model_requests ORDER BY rowid DESC LIMIT 1').get()).toMatchObject({ledger_attempt:expect.any(Number)});
      return fetch?fetch(request):Response.json(provider());}};
  const model=createEngineeringModelAdapter(options);
  const body=()=>({model:'deepseek-v4-pro',messages:[{role:'system',content:options.systemPrompt},...model.history()],
    tools:[],max_tokens:8192,stream:false,temperature:0.3});
  return {...f,budget,model,options,journalDb,spendDb,requests,fences,body};
}
async function work(f:ReturnType<typeof fixture>,n=0){f.model.beginTurn({turnId:'turn-'+n,prompt:'Approved work.'});
  const result=await f.model.handle(f.body(),new AbortController().signal);f.model.finishTurn(f.model.history());return result;}
test('fresh standing task uses zero history, larger shared pool, twelve full work reservations and one protected review',async()=>{
  const f=fixture();expect(f.model.nativeLimits.maxIterations).toBe(12);
  for(let i=0;i<12;i++)expect((await work(f,i)).status).toBe(200);
  await f.model.review({prompt:'Review exact artifact.',systemPrompt:'Independent.',signal:new AbortController().signal});
  expect(f.requests).toHaveLength(13);expect(f.ledger.status(f.budget.allocationId)).toMatchObject({capMicros:4_000_000,
    campaignCapMicros:8_000_000,attemptCount:13,chargedMicros:12*32454+16210,unknownAttempts:0});
  expect(f.spendDb.query('SELECT reserved_micros FROM spend_attempts ORDER BY id').all()).toEqual([
    ...Array.from({length:12},()=>({reserved_micros:1416561})),{reserved_micros:1400317}]);
  expect(f.journalDb.query("SELECT 1 FROM sqlite_master WHERE name='engineering_model_baselines'").get()).toBeNull();
  await expect(f.model.review({prompt:'Again',systemPrompt:'Independent.',signal:new AbortController().signal})).rejects.toThrow('review_already_completed');
  expect(f.requests).toHaveLength(13);
});
test('minimum cap funds one work plus review; settled headroom never bypasses the next full reservation',async()=>{
  const f=fixture(undefined,2_816_878);await work(f);
  f.model.beginTurn({turnId:'second',prompt:'More.'});
  await expect(f.model.handle(f.body(),new AbortController().signal)).rejects.toThrow('headroom');
  expect(f.requests).toHaveLength(1);expect(f.ledger.status(f.budget.allocationId)!.attemptCount).toBe(1);
});
test('standing funding cannot be copied, mixed into acceptance, rebound or constructed on historical spend',()=>{
  const f=fixture();
  const {standingBudget: _omitted,...withoutBudget}=f.options;
  expect(()=>createEngineeringModelAdapter(withoutBudget)).toThrow('standing_budget_binding');
  expect(()=>createEngineeringModelAdapter({...f.options,standingBudget:{...f.budget}})).toThrow('untrusted_task_budget');
  expect(()=>createEngineeringModelAdapter({...f.options,continuationBaseline:{} as any})).toThrow('standing_budget_binding');
  const acceptance=createEngineeringTaskPolicy({taskId:f.budget.taskId,repository:f.options.policy.repository,
    baseCommit:'a'.repeat(40),requiredCommands:['bun test'],allowedFiles:['file.ts'],publication:'patch_only'});
  expect(()=>createEngineeringModelAdapter({...f.options,policy:acceptance})).toThrow('standing_budget_binding');
  const other=f.allocator.allocate(f.input(2));
  expect(()=>createEngineeringModelAdapter({...f.options,standingBudget:other})).toThrow('untrusted_task_budget');
  // Same task in a fresh journal cannot disguise existing canonical attempts.
  f.db.query("INSERT INTO spend_attempts(ticket_id,provider,model,max_tokens,reserved_micros,charged_micros,state) VALUES(?,'deepseek','deepseek-v4-pro',8192,1416561,1,'settled')").run(f.budget.allocationId);
  expect(()=>createEngineeringModelAdapter(f.options)).toThrow('allocation_binding');
});
test('held own reservation is valid, a second task gets only its distinct committed cap, and unknown usage remains charged',async()=>{
  let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(r=>enter=r),released=new Promise<void>(r=>release=r);
  const f=fixture(async()=>{enter();await released;return Response.json({...provider(),usage:{input_tokens:10}});});
  const pending=work(f);await entered;
  expect(f.ledger.status(f.budget.allocationId)!.chargedMicros).toBe(1416561);f.budget.assertCurrent();
  const other=f.allocator.allocate(f.input(2));other.assertCurrent();expect(f.allocator.ready()).toBe(false);
  expect(f.allocator.status()).toMatchObject({committedCapMicros:8_000_000,chargedMicros:1416561});
  release();await expect(pending).rejects.toThrow('request_failed');
  expect(f.ledger.status(f.budget.allocationId)).toMatchObject({chargedMicros:1416561,unknownAttempts:1});
  await expect(f.model.handle(f.body(),new AbortController().signal)).rejects.toThrow('inactive');
  expect(f.requests).toHaveLength(1);expect(f.ledger.status(other.allocationId)!.attemptCount).toBe(0);
});
test('authority revocation and interleaved spending are fenced at the canonical reservation boundary',async()=>{
  const f=fixture();const before=f.ledger.withReservationGuard.bind(f.ledger);
  f.ledger.withReservationGuard=((guard,operation)=>before(reservation=>{
    f.revoke();guard(reservation);
  },operation)) as typeof f.ledger.withReservationGuard;
  await expect(work(f)).rejects.toThrow();expect(f.requests).toHaveLength(0);
  expect(f.ledger.status(f.budget.allocationId)!.attemptCount).toBe(0);
});
