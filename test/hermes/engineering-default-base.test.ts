import { expect, test } from 'bun:test';
import { resolveCurrentEngineeringRepository, resolveEngineeringDefaultBase, type EngineeringAppCredential } from '../../src/hermes/engineering-repository.ts';
const repo='707-Labs/new-ordinary-repo',now=1_000_000;
async function fixture() {
  const binding={appId:1,installationId:2};
  const resolution=await resolveCurrentEngineeringRepository(repo,{authenticated:true,requesterId:'U0A9M5W16F8',teamId:'T0AA24R7VUZ',
    surface:'private_dm',channelId:'D0C7EJELQJX',threadTs:'1234.1234'},{binding,now:()=>now,audienceGrants:()=>[],observer:{
    async installation(){return {...binding,accountLogin:'707-Labs',contents:'write',pullRequests:'write',observedAtMs:now};},
    async repositories(){return {installationId:2,totalCount:1,observedAtMs:now,repositories:[{repositoryId:3,fullName:repo,archived:false,disabled:false}]};},
  }});
  const auth:EngineeringAppCredential={...binding,kind:'app',accountLogin:'707-Labs',token:'host_only_fake_token_'.repeat(3),issuedAtMs:now,
    expiresAtMs:now+60_000,permissions:{contents:'write',pullRequests:'write'}};
  return {resolution,getCredential:async(name:string)=>{expect(name).toBe(repo);return auth;},now:()=>now};
}
test('default base comes from exact current App repository and escaped default branch, never a local checkout',async()=>{
  const f=await fixture(),urls:string[]=[];
  const base=await resolveEngineeringDefaultBase({...f,fetch:(async(url: string | URL | Request,init?: RequestInit)=>{
    urls.push(String(url));expect(init?.redirect).toBe('error');expect(init?.credentials).toBe('omit');
    return Response.json(urls.length===1?{id:3,full_name:repo,archived:false,disabled:false,default_branch:'release/next'}
      :{name:'release/next',commit:{sha:'a'.repeat(40)}});
  }) as unknown as typeof fetch});
  expect(base).toEqual({branch:'release/next',commit:'a'.repeat(40)});
  expect(urls).toEqual(['https://api.github.com/repos/'+repo,'https://api.github.com/repos/'+repo+'/branches/release%2Fnext']);
});
test('renamed, replaced, disabled or malformed repositories cannot mint an admitted base',async()=>{
  const f=await fixture();
  for(const change of [{id:4},{full_name:'707-Labs/different'},{disabled:true},{archived:true},{default_branch:'bad\nbranch'}]){
    let calls=0;
    await expect(resolveEngineeringDefaultBase({...f,fetch:(async()=>{calls++;return Response.json({id:3,full_name:repo,archived:false,
      disabled:false,default_branch:'main',...change});}) as unknown as typeof fetch})).rejects.toThrow('base_unavailable');
    expect(calls).toBe(1);
  }
});
test('serialized resolution loses authority and oversized or changed branch responses fail closed',async()=>{
  const f=await fixture();let calls=0;
  await expect(resolveEngineeringDefaultBase({...f,resolution:JSON.parse(JSON.stringify(f.resolution)),fetch:(async()=>{calls++;return Response.json({});}) as unknown as typeof fetch}))
    .rejects.toThrow('untrusted_resolution');expect(calls).toBe(0);
  for(const response of [new Response('x'.repeat(256*1024+1)),Response.json({name:'different',commit:{sha:'a'.repeat(40)}})]){
    calls=0;
    await expect(resolveEngineeringDefaultBase({...f,fetch:(async()=>++calls===1?Response.json({id:3,full_name:repo,archived:false,
      disabled:false,default_branch:'main'}):response) as unknown as typeof fetch})).rejects.toThrow('base_unavailable');
  }
});
