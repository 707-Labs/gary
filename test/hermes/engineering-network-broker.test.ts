import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {createEngineeringNetworkBroker,engineeringPublicHttpsUrl,isEngineeringPublicAddress,assertEngineeringDownloadedResource,
 createEngineeringNetworkQuota,validateEngineeringIntegrity,type EngineeringNetworkReference,type EngineeringNetworkHop} from '../../src/hermes/engineering-network-broker.ts';
const url='https://registry.npmjs.org/demo/-/demo-1.0.0.tgz',body=Buffer.from('synthetic public package'),sri='sha512-'+createHash('sha512').update(body).digest('base64');
const reference:EngineeringNetworkReference={url,purpose:'dependency',integrity:sri,provenanceSha256:'a'.repeat(64)};
const setup=(extra:Partial<Parameters<typeof createEngineeringNetworkBroker>[0]>={})=>createEngineeringNetworkBroker({binding:{taskId:'task',scopeKey:'private:project',deadlineMs:Date.now()+10_000},assertCurrent(){},references:[reference],allowedOrigins:['https://registry.npmjs.org'],resolve:async()=>['1.1.1.1'],transport:async()=>({status:200,headers:{'content-type':'application/octet-stream'},bytes:body}),...extra});
test('public address classifier rejects local, private, mapped, transition, documentation and reserved addresses',()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','0.0.0.0','100.64.0.1','169.254.169.254','172.31.0.1','192.168.0.1','192.0.2.1','192.88.99.1','198.19.1.1','198.51.100.1','203.0.113.1','224.1.1.1','255.255.255.255','::1','::','fe80::1','fc00::1','::ffff:127.0.0.1','2001:db8::1','2002:0808:0808::1','3fff::1'])expect(isEngineeringPublicAddress(ip)).toBe(false);
 for(const ip of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111','2001:4860:4860::8888'])expect(isEngineeringPublicAddress(ip)).toBe(true);
});
test('URL grammar rejects credentials, query, fragments, IP literals, unsafe ports and separators',()=>{
 for(const value of ['http://example.com/a','https://user:secret@example.com/a','https://example.com/a?token=x','https://example.com/a#secret','https://127.0.0.1/','https://[::1]/','https://example.com:444/','https://example.local/','https://example.com/a%2fb','https://example.com/a\\b','https://example.com/a\n'])expect(()=>engineeringPublicHttpsUrl(value)).toThrow('engineering_network:url');
 expect(engineeringPublicHttpsUrl('https://example.com/docs/page').href).toBe('https://example.com/docs/page');
});
test('one-use exact admitted reference gives immutable digest/SRI receipt and private copy of bytes',async()=>{
 const hops:EngineeringNetworkHop[]=[];const b=setup({transport:async hop=>{hops.push(hop);return{status:200,headers:{},bytes:body};}}),request=b.request(url);
 expect(()=>b.request('https://registry.npmjs.org/private-data')).toThrow('reference_not_admitted');
 await expect(b.download({...request})).rejects.toThrow('request_replay_or_busy');
 const result=await b.download(request);expect(hops).toHaveLength(1);expect(hops[0]!.address).toBe('1.1.1.1');expect(hops[0]!.hostname).toBe('registry.npmjs.org');
 expect(Object.keys(hops[0]!).sort()).toEqual(['address','family','hostname','maxBytes','signal','url']);
 expect(result.receipt).toMatchObject({taskId:'task',scopeKey:'private:project',integrity:sri,bytes:body.length,redirects:0});
 const copy=result.bytes();copy[0]=0;expect(result.bytes()).toEqual(Uint8Array.from(body));expect(Object.isFrozen(result.receipt)).toBe(true);assertEngineeringDownloadedResource(result);
 expect(()=>assertEngineeringDownloadedResource({...result})).toThrow('resource_provenance');await expect(b.download(request)).rejects.toThrow('request_replay_or_busy');
});
test('mixed DNS and redirected private/DNS-rebound destinations fail before dial',async()=>{
 let dials=0;const mixed=setup({resolve:async()=>['1.1.1.1','127.0.0.1'],transport:async()=>{dials++;throw Error();}});
 await expect(mixed.download(mixed.request(url))).rejects.toThrow('address');expect(dials).toBe(0);
 let resolutions=0;const rebind=setup({resolve:async()=>++resolutions===1?['1.1.1.1']:['10.0.0.2'],transport:async()=>{dials++;return{status:302,headers:{location:'/redirected.tgz'},bytes:new Uint8Array()};}});
 await expect(rebind.download(rebind.request(url))).rejects.toThrow('address');expect(dials).toBe(1);
});
test('redirects revalidate scheme, origin, path and DNS; checked public redirect retains original provenance',async()=>{
 const invalid=['http://registry.npmjs.org/a','https://evil.example/a','https://user:pass@registry.npmjs.org/a','https://registry.npmjs.org/a?secret=x'];
 for(const location of invalid){const b=setup({transport:async()=>({status:302,headers:{location},bytes:new Uint8Array()})});await expect(b.download(b.request(url))).rejects.toThrow('engineering_network:');}
 let calls=0;const b=setup({transport:async()=>++calls===1?{status:307,headers:{location:'/cdn/package.tgz'},bytes:new Uint8Array()}:{status:200,headers:{},bytes:body}});
 const r=await b.download(b.request(url));expect(r.receipt).toMatchObject({url,finalUrl:'https://registry.npmjs.org/cdn/package.tgz',redirects:1,provenanceSha256:'a'.repeat(64)});
 const loop=setup({transport:async()=>({status:302,headers:{location:url},bytes:new Uint8Array()})});await expect(loop.download(loop.request(url))).rejects.toThrow('redirect_limit');
});
test('SRI mismatch, encoded payload, oversized body and invalid document types are rejected',async()=>{
 for(const response of [{status:200,headers:{},bytes:Buffer.from('wrong')},{status:200,headers:{'content-encoding':'gzip'},bytes:body},{status:403,headers:{},bytes:body}]){const b=setup({transport:async()=>response});await expect(b.download(b.request(url))).rejects.toThrow('engineering_network:');}
 const doc:EngineeringNetworkReference={purpose:'documentation',url:'https://docs.example.com/page',provenanceSha256:'b'.repeat(64)};
 for(const response of [{status:200,headers:{'content-type':'text/html'},bytes:new Uint8Array(2*1024*1024+1)},{status:200,headers:{'content-type':'application/octet-stream'},bytes:body}]){const b=setup({references:[doc],allowedOrigins:['https://docs.example.com'],transport:async()=>response});await expect(b.download(b.request(doc.url))).rejects.toThrow('engineering_network:');}
 for(const integrity of ['sha1-AAAA','sha512-AA==','sha256-!!!!','sha256-'+Buffer.alloc(31).toString('base64')])expect(()=>validateEngineeringIntegrity(integrity)).toThrow('integrity');
});
test('whole operation deadline covers stalled DNS and stalled transport; failed attempt is consumed',async()=>{
 for(const where of ['dns','transport']){let signal:AbortSignal|undefined;const b=setup({binding:{taskId:'task',scopeKey:'private:project',deadlineMs:Date.now()+30},
  ...(where==='dns'?{resolve:async(_host:string,s:AbortSignal)=>{signal=s;return new Promise<readonly string[]>(()=>{});}}:{transport:async(h:EngineeringNetworkHop)=>{signal=h.signal;return new Promise<never>(()=>{});}})});
  const request=b.request(url);await expect(b.download(request)).rejects.toThrow('deadline');expect(signal!.aborted).toBe(true);}
});
test('failed transfers retain full byte reservation and cannot evade task total via retries',async()=>{
 let calls=0;const b=setup({transport:async()=>{calls++;throw Error('simulated reset');}});
 for(let n=0;n<8;n++)await expect(b.download(b.request(url))).rejects.toThrow('simulated reset');
 await expect(b.download(b.request(url))).rejects.toThrow('task_byte_limit');expect(calls).toBe(8);
});
test('authority revocation after DNS prevents transport and no arbitrary async guard is accepted',async()=>{
 let valid=true,calls=0;const b=setup({assertCurrent(){if(!valid)throw Error('revoked');},resolve:async()=>{valid=false;return['1.1.1.1'];},transport:async()=>{calls++;throw Error();}});
 await expect(b.download(b.request(url))).rejects.toThrow('revoked');expect(calls).toBe(0);
 expect(()=>setup({assertCurrent:async()=>{}}).request(url)).toThrow('asynchronous_guard');
});

test('one opaque task quota bounds combined baseline/candidate/document brokers and rejects forged/cross-task reuse',async()=>{
 const binding={taskId:'task',scopeKey:'private:project',deadlineMs:Date.now()+10000},quota=createEngineeringNetworkQuota(binding);
 const a=setup({binding,quota,transport:async()=>{throw Error('partial');}}),b=setup({binding,quota,transport:async()=>{throw Error('partial');}});
 for(let i=0;i<8;i++){const broker=i%2?a:b;await expect(broker.download(broker.request(url))).rejects.toThrow('partial');}
 await expect(a.download(a.request(url))).rejects.toThrow('task_byte_limit');
 expect(()=>setup({binding,quota:{...quota}})).toThrow('quota_binding');
 expect(()=>setup({binding:{...binding,taskId:'other'},quota})).toThrow('quota_binding');
});
