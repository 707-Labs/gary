import { afterEach, describe, expect, test } from 'bun:test';
import { createExecutorBridge, type ExecutorBridge, type ExecutorBridgeOptions } from '../../src/hermes/executor-bridge.ts';
import { assertScopedReadOnlySql, type ScopedIntegrationBindings } from '../../src/hermes/scoped-integrations.ts';
import { throwIfExpired } from '../../src/deadline.ts';
import { fetchPublicUrl } from '../../src/safe-fetch.ts';
import type { Executor } from '../../src/executors/index.ts';
import type { AssignedIssue } from '../../src/adapters/linear.ts';

const token = 'offline-capability-not-a-provider-credential';
const currentIssue = { id: 'issue-current', identifier: 'ERT-123', teamId: 'team-one' };
const issue = (identifier = 'ERT-123', id = 'issue-current'): AssignedIssue => ({
  id, identifier, teamId:'team-one', title:'Scoped fixture', description:'description',
  stateName:'In Progress', stateType:'started', creatorName:'fixture', creatorId:'creator', teamKey:'ERT', url:'https://linear.app/fixture',
  createdAt:'2026-10-07T00:00:00Z', updatedAt:'2026-10-07T00:00:00Z', blockedBy:[],
});
const executor: Executor = {
  workspaceRoot:'/offline/task', async readFile() { return 'fixture'; }, async writeFile() {},
  async listFiles() { return []; }, async grep() { return []; },
  async run() { return {stdout:'',stderr:'',exitCode:0,timedOut:false}; },
};
const bridges: ExecutorBridge[] = [];
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.dispose(); });
function fixture(integrations: ScopedIntegrationBindings, allowedTools: string[], extra: Partial<ExecutorBridgeOptions> = {}) {
  let epoch = 'owner-one', calls = 0;
  const bridge = createExecutorBridge({ executor, integrations, allowedTools,
    capability:{taskId:'task-one',token,ownerEpoch:epoch,deadlineMs:Date.now()+60_000},
    currentOwnerEpoch:()=>epoch, finishGateCommand:'bun run check', ...extra });
  bridges.push(bridge);
  const request = (name:string,args:Record<string,unknown>={}) => ({taskId:'task-one', token, ownerEpoch:'owner-one',
    callId:`call-${++calls}`,name,arguments:args});
  return {bridge,request,revoke:()=>{epoch='owner-two';},invoke:(name:string,args:Record<string,unknown>={})=>bridge.invoke(request(name,args))};
}
function linearFixture() {
  const calls: unknown[][] = [];
  const client: NonNullable<ScopedIntegrationBindings['linear']>['client'] = {
    async fetchByIdentifier(name) { calls.push(['read',name]); return issue(name, name==='ERT-123'?'issue-current':'issue-reference'); },
    async fetchComments(id,limit) { calls.push(['comments',id,limit]); return []; },
    async unassign(id) { calls.push(['unassign',id]); },
    async updateDescription(id,body) { calls.push(['description',id,body]); },
    async setStateByType(id,team,type) { calls.push(['state',id,team,type]); return {stateName:'Backlog'}; },
  };
  return {client,calls};
}
function githubFixture() {
  const calls: unknown[][] = [];
  const client: NonNullable<ScopedIntegrationBindings['github']>['client'] = {
    async getPullRequestDetail(owner,repo,number) { calls.push([owner,repo,number]); return {
      number,title:'Scoped PR',body:'body',url:'https://github.com/707-Labs/gary/pull/10',state:'open',
      merged:false,isDraft:true,baseRef:'main',headRef:'fixture',headSha:'a'.repeat(40),diff:'fixture diff',
    } as Awaited<ReturnType<typeof client.getPullRequestDetail>>; },
  };
  return {client,calls};
}
function cloudflareFixture() {
  const calls: unknown[][] = [];
  const client: NonNullable<ScopedIntegrationBindings['cloudflare']>['client'] = {
    async queryLogs(args={}) { calls.push(['logs',args]); return [{timestamp:1,service:args.service!,message:'fixture log',level:'info',error:null,invocationId:null,raw:{}}]; },
    async listInvocations(args={}) { calls.push(['invocations',args]); return [{timestamp:1,service:args.service!,invocationId:'fixture',status:200,durationMs:1,hasError:false,events:1,raw:{}}]; },
    async queryD1(args) { calls.push(['d1',args]); return {rows:[{n:1}],rowsRead:1,rowsWritten:0,durationMs:1}; },
  };
  return {client,calls};
}
const publicDns = async () => [{address:'93.184.216.34'}];

describe('task-scoped existing Gary integrations (no external requests)', () => {
  test('every requested integration requires an explicit usable binding', () => {
    for (const name of ['get_linear_issue','get_pr','fetch_url','d1_query','dispatch_subagent','unassign_self']) {
      expect(()=>fixture({},[name])).toThrow('allowlist');
    }
    const l=linearFixture(), c=cloudflareFixture();
    expect(()=>fixture({linear:{client:l.client,readIdentifiers:[]}},['unassign_self'])).toThrow('allowlist');
    expect(()=>fixture({cloudflare:{client:c.client,allowedServices:[],allowedDatabases:[]}},['d1_query'])).toThrow('allowlist');
    expect(()=>fixture({linear:{client:l.client,readIdentifiers:['ERT-123'],currentIssue}},['unassign_self'],{readOnly:true})).toThrow('allowlist');
  });
  test('read-only investigation can omit a coding finish gate only when finish is ungranted', async () => {
    const h=fixture({},['read_file','run_bash','report_blocked'],{readOnly:true,finishGateCommand:''});
    expect((await h.invoke('read_file',{path:'src/file.ts'})).ok).toBe(true);
    expect((await h.invoke('finish',{summary:'not a coding completion'})).error).toBe('tool_denied');
    expect(()=>fixture({},['finish'],{readOnly:true,finishGateCommand:''})).toThrow('verification');
    expect(()=>fixture({},['read_file'],{finishGateCommand:''})).toThrow('verification');
  });
  test('Linear reads are limited to admitted current/referenced identifiers and comments follow resolved IDs', async () => {
    const l=linearFixture(); const h=fixture({linear:{client:l.client,readIdentifiers:['ERT-123','ERT-456'],currentIssue}},['get_linear_issue']);
    expect((await h.invoke('get_linear_issue',{identifier:'ERT-123'})).content).toContain('ERT-123: Scoped fixture');
    expect((await h.invoke('get_linear_issue',{identifier:'ERT-456',include_comments:false})).ok).toBe(true);
    expect((await h.invoke('get_linear_issue',{identifier:'OTHER-999'})).ok).toBe(false);
    expect(l.calls).toEqual([['read','ERT-123'],['comments','issue-current',10],['read','ERT-456']]);
  });
  test('Linear mutations use the host current issue and cannot accept model supplied ticket/team IDs', async () => {
    const l=linearFixture(); const h=fixture({linear:{client:l.client,readIdentifiers:['ERT-123'],currentIssue}},['unassign_self','set_ticket_state','update_ticket_description']);
    expect((await h.invoke('unassign_self')).ok).toBe(true);
    expect((await h.invoke('set_ticket_state',{type:'backlog'})).ok).toBe(true);
    expect((await h.invoke('update_ticket_description',{description:'findings'})).ok).toBe(true);
    for (const [name,args] of [['unassign_self',{id:'other'}],['set_ticket_state',{type:'backlog',teamId:'other'}],['update_ticket_description',{description:'bad',identifier:'OTHER-1'}]] as const) {
      expect((await h.invoke(name,args)).error).toBe('invalid_arguments');
    }
    expect(l.calls).toEqual([['unassign','issue-current'],['state','issue-current','team-one','backlog'],['description','issue-current','findings']]);
  });
  test('native schemas omit only empty required lists and retain argument enforcement', async () => {
    const l=linearFixture();const h=fixture({linear:{client:l.client,readIdentifiers:['ERT-123'],currentIssue}},
      ['unassign_self','set_ticket_state','update_ticket_description','get_linear_issue','read_file']);
    const schemas=Object.fromEntries(h.bridge.definitions.map(tool=>[tool.function.name,tool.function.parameters]));
    expect(schemas.unassign_self).toEqual({type:'object',properties:{},additionalProperties:false});
    expect(schemas.set_ticket_state!.required).toEqual(['type']);
    expect(schemas.update_ticket_description!.required).toEqual(['description']);
    expect(schemas.get_linear_issue!.required).toEqual(['identifier']);
    expect(schemas.read_file!.required).toEqual(['path']);
    expect((await h.invoke('unassign_self')).ok).toBe(true);
    expect((await h.invoke('unassign_self',{id:'another-ticket'})).error).toBe('invalid_arguments');
    expect((await h.invoke('set_ticket_state')).ok).toBe(false);
    expect((await h.invoke('get_linear_issue')).ok).toBe(false);
    expect(l.calls).toEqual([['unassign','issue-current']]);
  });
  test('scope inputs are copied, and mismatched adapter issue identities are rejected before comments', async () => {
    const l=linearFixture(); const reads=['ERT-123']; const current={...currentIssue};
    const h=fixture({linear:{client:l.client,readIdentifiers:reads,currentIssue:current}},['get_linear_issue','unassign_self']);
    reads.push('OTHER-1'); current.id='other';
    expect((await h.invoke('get_linear_issue',{identifier:'OTHER-1'})).ok).toBe(false);
    await h.invoke('unassign_self'); expect(l.calls).toEqual([['unassign','issue-current']]);
    l.client.fetchByIdentifier=async()=>issue('ERT-123','wrong-id');
    expect((await h.invoke('get_linear_issue',{identifier:'ERT-123'})).ok).toBe(false);
    expect(l.calls).toHaveLength(1);
  });
  test('revocation during a Linear read prevents comments and suppresses returned data', async () => {
    const l=linearFixture(); const h=fixture({linear:{client:l.client,readIdentifiers:['ERT-123']}},['get_linear_issue']);
    l.client.fetchByIdentifier=async()=>{ h.revoke(); return issue(); };
    const result=await h.invoke('get_linear_issue',{identifier:'ERT-123'});
    expect(result.ok).toBe(false); expect(result.content).not.toContain('Scoped fixture'); expect(l.calls).toEqual([]);
  });
  test('owner is checked between legacy setStateByType lookup and mutation', async () => {
    const l=linearFixture(); const h=fixture({linear:{client:l.client,readIdentifiers:[],currentIssue}},['set_ticket_state']);
    let mutations=0;
    l.client.setStateByType=async(_id,_team,_type,options={})=>{
      throwIfExpired(options); await Promise.resolve(); h.revoke(); throwIfExpired(options);
      mutations++; return {stateName:'Backlog'};
    };
    expect((await h.invoke('set_ticket_state',{type:'backlog'})).ok).toBe(false); expect(mutations).toBe(0);
  });
  test('GitHub uses only the configured repository, with existing detail/diff formatting', async () => {
    const g=githubFixture(); const h=fixture({github:{client:g.client,defaultRepo:'707-Labs/gary'}},['get_pr']);
    const result=await h.invoke('get_pr',{number:10}); expect(result.content).toContain('fixture diff');
    expect((await h.invoke('get_pr',{number:11,repo:'707-Labs/gary',include_diff:false})).content).not.toContain('fixture diff');
    expect((await h.invoke('get_pr',{number:10,repo:'other/private'})).ok).toBe(false);
    expect(g.calls).toEqual([['707-Labs','gary',10],['707-Labs','gary',11]]);
  });
  test('Cloudflare omitted service fans out only over admitted services and caps total results', async () => {
    const c=cloudflareFixture(); const h=fixture({cloudflare:{client:c.client,allowedServices:['worker-one','worker-two'],allowedDatabases:['db-one']}},['query_cloudflare_logs','list_cloudflare_invocations','d1_query']);
    expect((await h.invoke('query_cloudflare_logs',{limit:1})).content).toContain('worker-one');
    expect(c.calls).toHaveLength(1);
    expect((await h.invoke('list_cloudflare_invocations',{})).content).toContain('worker-two');
    expect((await h.invoke('query_cloudflare_logs',{service:'unrelated'})).ok).toBe(false);
    expect((await h.invoke('d1_query',{database:'unrelated',sql:'SELECT 1'})).ok).toBe(false);
    expect((await h.invoke('d1_query',{database:'db-one',sql:'SELECT ?1',params:[1]})).content).toContain('rows: 1');
    expect(c.calls.map(x=>x[0])).toEqual(['logs','invocations','invocations','d1']);
  });
  test('Cloudflare revocation stops fanout and filters unexpected service rows', async () => {
    const c=cloudflareFixture(); const h=fixture({cloudflare:{client:c.client,allowedServices:['one','two'],allowedDatabases:[]}},['query_cloudflare_logs']);
    c.client.queryLogs=async()=>{c.calls.push(['first']);h.revoke();return [];};
    expect((await h.invoke('query_cloudflare_logs')).ok).toBe(false); expect(c.calls).toEqual([['first']]);
    const c2=cloudflareFixture(); c2.client.queryLogs=async()=>[{timestamp:1,service:'unexpected',message:'private',level:null,error:null,invocationId:null,raw:{}}];
    const h2=fixture({cloudflare:{client:c2.client,allowedServices:['one'],allowedDatabases:[]}},['query_cloudflare_logs']);
    const result=await h2.invoke('query_cloudflare_logs'); expect(result.ok).toBe(false); expect(result.content).not.toContain('private');
  });
  test('D1 rejects mutation CTEs, write pragmas, and multiple statements before host call', async () => {
    const c=cloudflareFixture(); const h=fixture({cloudflare:{client:c.client,allowedServices:[],allowedDatabases:['db']}},['d1_query']);
    for (const sql of ['DELETE FROM users','WITH n AS (SELECT 1) DELETE FROM users','PRAGMA journal_mode=WAL','PRAGMA optimize','SELECT 1; DELETE FROM users','EXPLAIN DELETE FROM users','EXPLAIN PRAGMA journal_mode=WAL',"SELECT load_extension('unsafe')"]) {
      expect((await h.invoke('d1_query',{database:'db',sql})).ok).toBe(false);
    }
    expect(c.calls).toEqual([]);
    for (const sql of ['SELECT 1;','WITH n AS (SELECT 1) SELECT * FROM n','EXPLAIN SELECT 1','PRAGMA table_info(users)',"SELECT 'DELETE;UPDATE'",'SELECT "update" FROM t']) {
      expect(()=>assertScopedReadOnlySql(sql)).not.toThrow();
    }
  });
  test('D1 adapter reporting writes is a failed tool result', async () => {
    const c=cloudflareFixture();c.client.queryD1=async()=>({rows:[],rowsRead:0,rowsWritten:1,durationMs:0});
    const h=fixture({cloudflare:{client:c.client,allowedServices:[],allowedDatabases:['db']}},['d1_query']);
    expect((await h.invoke('d1_query',{database:'db',sql:'SELECT 1'})).ok).toBe(false);
  });
  test('public fetch follows allowed redirects through the existing SSRF checks', async () => {
    const calls:string[]=[];
    const h=fixture({publicFetch:{policy:{kind:'origins',origins:['https://docs.example.com']},transport:{resolve:publicDns,
      fetch:async(url,init)=>{calls.push(url.href);expect(init.redirect).toBe('manual');return calls.length===1?new Response('',{status:302,headers:{location:'/next'}}):new Response('documentation');}}}},['fetch_url']);
    expect((await h.invoke('fetch_url',{url:'https://docs.example.com/start'})).content).toContain('documentation');
    expect(calls).toEqual(['https://docs.example.com/start','https://docs.example.com/next']);
  });
  test('fetch rejects unadmitted URLs, credentials, private DNS and redirected scope escapes', async () => {
    for (const target of ['https://other.example/start','https://user:pass@docs.example.com/start','http://127.0.0.1/','http://localhost/']) {
      const calls:string[]=[];const h=fixture({publicFetch:{policy:{kind:'origins',origins:['https://docs.example.com']},transport:{resolve:publicDns,fetch:async u=>{calls.push(u.href);return new Response('no');}}}},['fetch_url']);
      expect((await h.invoke('fetch_url',{url:target})).ok).toBe(false);expect(calls).toEqual([]);
    }
    const calls:string[]=[];const h=fixture({publicFetch:{policy:{kind:'urls',urls:['https://docs.example.com/start']},transport:{resolve:publicDns,fetch:async u=>{calls.push(u.href);return new Response('',{status:302,headers:{location:'/outside'}});}}}},['fetch_url']);
    expect((await h.invoke('fetch_url',{url:'https://docs.example.com/start'})).ok).toBe(false);expect(calls).toHaveLength(1);
    let network=0; const privateDns=fixture({publicFetch:{policy:{kind:'public'},transport:{resolve:async()=>[{address:'10.0.0.1'}],fetch:async()=>{network++;return new Response('no');}}}},['fetch_url']);
    expect((await privateDns.invoke('fetch_url',{url:'https://public.example.com'})).ok).toBe(false);expect(network).toBe(0);
  });
  test('owner revocation after DNS prevents network request', async () => {
    let network=0;const h=fixture({publicFetch:{policy:{kind:'public'},transport:{resolve:async()=>{h.revoke();return publicDns();},fetch:async()=>{network++;return new Response('no');}}}},['fetch_url']);
    expect((await h.invoke('fetch_url',{url:'https://docs.example.com'})).ok).toBe(false);expect(network).toBe(0);
  });
  test('fetch buffers bounded bytes and bridge bounds the complete escaped result', async () => {
    let reads=0,cancelled=false;const h=fixture({publicFetch:{policy:{kind:'public'},transport:{resolve:publicDns,fetch:async()=>new Response(new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(100_000).fill(65));},cancel(){cancelled=true;}}))}}},['fetch_url'],{maxResultBytes:1024});
    const result=await h.invoke('fetch_url',{url:'https://docs.example.com'});
    expect(result.ok).toBe(true);expect(result.truncated).toBe(true);expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024);expect(reads).toBeLessThanOrEqual(3);expect(cancelled).toBe(true);
    expect(result.content).toContain('truncated');
  });
  test('aborted body read settles after stream cancellation without leaking content', async () => {
    const abort=new AbortController();let cancelled=false;
    const h=fixture({publicFetch:{policy:{kind:'public'},transport:{resolve:publicDns,fetch:async()=>new Response(new ReadableStream({start(){queueMicrotask(()=>abort.abort());},cancel(){cancelled=true;}}))}}},['fetch_url'],{signal:abort.signal});
    expect((await h.invoke('fetch_url',{url:'https://docs.example.com'})).ok).toBe(false); expect(cancelled).toBe(true);
  });
  test('integration errors are sanitized and call IDs remain one-use across tool types', async () => {
    const g=githubFixture();g.client.getPullRequestDetail=async()=>{throw new Error('provider-secret-fixture');};
    const h=fixture({github:{client:g.client,defaultRepo:'707-Labs/gary'}},['get_pr','read_file']);
    const request=h.request('get_pr',{number:1});const result=await h.bridge.invoke(request);
    expect(result.ok).toBe(false);expect(JSON.stringify(result)).not.toContain('provider-secret-fixture');
    expect((await h.bridge.invoke({...request,name:'read_file',arguments:{path:'a'}})).error).toBe('duplicate_call');
  });
  test('delegation requires only the supplied host runner and respects revocation after await', async () => {
    const tasks:string[]=[];const h=fixture({subagentRunner:async task=>{tasks.push(task);return {status:'finished',iterations:2,summary:'host child result'};}},['dispatch_subagent']);
    expect((await h.invoke('dispatch_subagent',{task:'Investigate callers'})).content).toContain('host child result');expect(tasks).toEqual(['Investigate callers']);
    const h2=fixture({subagentRunner:async()=>{h2.revoke();return {status:'finished',iterations:2,summary:'stale child result'};}},['dispatch_subagent']);
    const result=await h2.invoke('dispatch_subagent',{task:'Investigate'});expect(result.ok).toBe(false);expect(result.content).not.toContain('stale child result');
  });
  test('session-local cancellation reaches the host child callback and awaits child cleanup', async () => {
    let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
    let seenSignal:AbortSignal|undefined,cleaned=false;
    const h=fixture({subagentRunner:async(task,signal)=>{
      expect(task).toBe('Investigate');seenSignal=signal;expect(signal).toBeInstanceOf(AbortSignal);
      started();await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>resolve(),{once:true}));
      await Promise.resolve();cleaned=true;
      return {status:'finished',iterations:1,summary:'stale child output'};
    }},['dispatch_subagent']);
    const pending=h.invoke('dispatch_subagent',{task:'Investigate'});await ready;
    expect(seenSignal!.aborted).toBe(false);h.bridge.dispose();
    const result=await pending;expect(seenSignal!.aborted).toBe(true);expect(cleaned).toBe(true);
    expect(result.ok).toBe(false);expect(result.content).not.toContain('stale child output');
  });
  test('default safe-fetch seam still checks private addresses without real network', async () => {
    let network=0;
    await expect(fetchPublicUrl('https://docs.example.com',{}, {resolve:async()=>[{address:'127.0.0.1'}],fetch:async()=>{network++;return new Response('bad');}})).rejects.toThrow('private');
    expect(network).toBe(0);
  });
});
