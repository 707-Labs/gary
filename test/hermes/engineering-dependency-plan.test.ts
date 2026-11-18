import {expect,test,afterEach} from 'bun:test';
import {createHash} from 'node:crypto';
import {chmodSync,existsSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';import{join}from'node:path';
import {createEngineeringDependencyPlan,engineeringDependencyNetworkReferences,engineeringDependencyPlanFiles,engineeringNpmMetadataReference,parseEngineeringNpmMetadata,parseEngineeringBunLock,engineeringNpmTarball} from '../../src/hermes/engineering-dependency-plan.ts';
import {createEngineeringNetworkBroker}from'../../src/hermes/engineering-network-broker.ts';
import {createEngineeringDependencyBundle,materializeEngineeringDependencyBundle,ENGINEERING_DEPENDENCY_SANDBOX_SCRIPT}from'../../src/hermes/engineering-dependency-bundle.ts';
const body=Buffer.from('synthetic tarball bytes only; never extracted'),sri='sha512-'+createHash('sha512').update(body).digest('base64');
const pkg={name:'fixture',scripts:{test:'node test.js'},dependencies:{'@scope/demo':'1.2.3'}},url='https://registry.npmjs.org/@scope/demo/-/demo-1.2.3.tgz';
const npm=()=>({lockfileVersion:3,packages:{'':{dependencies:pkg.dependencies},'node_modules/@scope/demo':{version:'1.2.3',resolved:url,integrity:sri}}});
const input=(lock=npm())=>({packageJson:Buffer.from(JSON.stringify(pkg)),lockfile:{name:'package-lock.json' as const,bytes:Buffer.from(JSON.stringify(lock))},provenanceSha256:'a'.repeat(64)});
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
test('npm lock v2/v3 yields host-provenanced canonical tarballs and immutable exact metadata',()=>{
 for(const version of [2,3]){const p=createEngineeringDependencyPlan(input({...npm(),lockfileVersion:version}));expect(p.packages).toHaveLength(1);expect(p.packages[0]).toMatchObject({name:'@scope/demo',version:'1.2.3',url,integrity:sri});expect(Object.isFrozen(p.packages)).toBe(true);expect(engineeringDependencyNetworkReferences(p)[0]).toEqual({purpose:'dependency',url,integrity:sri,provenanceSha256:p.hash});const copy=engineeringDependencyPlanFiles(p);copy.packageJson[0]=0;expect(engineeringDependencyPlanFiles(p).packageJson[0]).toBe(123);}
 expect(()=>engineeringDependencyNetworkReferences({...createEngineeringDependencyPlan(input())})).toThrow('plan_provenance');
});
test('Bun text lock parser accepts comments/trailing commas as data and rejects executable text',()=>{
 const lock=`{/*comment*/"lockfileVersion":1,"workspaces":{"":{"dependencies":{"@scope/demo":"1.2.3",},},},"packages":{"@scope/demo":["@scope/demo@1.2.3","",{},${JSON.stringify(sri)},],},}`;
 const p=createEngineeringDependencyPlan({...input(),lockfile:{name:'bun.lock',bytes:Buffer.from(lock)}});expect(p.kind).toBe('bun');expect(p.packages[0]!.url).toBe(url);
 expect(parseEngineeringBunLock(Buffer.from('{"text":"// not comment /* x */",}'))).toEqual({text:'// not comment /* x */'});
 for(const raw of ['({x:process.exit()})','{"x":undefined}','{/*unterminated','{"x":1,,}'])expect(()=>parseEngineeringBunLock(Buffer.from(raw))).toThrow('lock_json');
});
test('lock metadata cannot smuggle private URLs, credentials, extra query bytes, Git/local sources or omitted integrity',()=>{
 for(const resolved of ['https://127.0.0.1/a','https://registry.npmjs.org/@scope/demo/-/demo-1.2.3.tgz?secret=x','https://user:pass@registry.npmjs.org/a','https://evil.example/a','file:../secret','git+https://github.com/a/b']){const lock=npm();lock.packages['node_modules/@scope/demo'].resolved=resolved;expect(()=>createEngineeringDependencyPlan(input(lock))).toThrow('source_not_canonical');}
 const missing=npm();delete(missing.packages['node_modules/@scope/demo']as{integrity?:string}).integrity;expect(()=>createEngineeringDependencyPlan(input(missing))).toThrow('integrity_missing');
 const mismatch=npm();mismatch.packages[''].dependencies={'@scope/demo':'2.0.0'};expect(()=>createEngineeringDependencyPlan(input(mismatch))).toThrow('manifest_lock_mismatch');
 for(const name of ['../secret','foo?x','foo/secret','UPPER','@scope/../a'])expect(()=>engineeringNpmTarball(name,'1.0.0')).toThrow('package_identity');
 for(const version of ['latest','file:abc','1.0.0?x','01.0.0'])expect(()=>engineeringNpmTarball('demo',version)).toThrow('package_identity');
});
test('new exact-version package metadata binds canonical name/version/tarball/SRI without evaluating scripts',()=>{
 expect(engineeringNpmMetadataReference('@scope/demo','1.2.3','a'.repeat(64)).url).toBe('https://registry.npmjs.org/@scope/demo/1.2.3');
 const metadata={name:'@scope/demo',version:'1.2.3',dist:{tarball:url,integrity:sri},scripts:{install:'MUST NEVER RUN ON HOST'}};
 expect(parseEngineeringNpmMetadata('@scope/demo','1.2.3',Buffer.from(JSON.stringify(metadata))).url).toBe(url);
 metadata.dist.tarball='https://evil.example/tar';expect(()=>parseEngineeringNpmMetadata('@scope/demo','1.2.3',Buffer.from(JSON.stringify(metadata)))).toThrow('metadata_binding');
});
test('verified public resources materialize exclusive readonly payload, exact manifest and inert sandbox bootstrap',async()=>{
 const plan=createEngineeringDependencyPlan(input());
 const broker=createEngineeringNetworkBroker({binding:{taskId:'task',scopeKey:'private:project',deadlineMs:Date.now()+10000},assertCurrent(){},references:engineeringDependencyNetworkReferences(plan),allowedOrigins:['https://registry.npmjs.org'],resolve:async()=>['1.1.1.1'],transport:async()=>({status:200,headers:{},bytes:body})});
 const resource=await broker.download(broker.request(url));const bundle=createEngineeringDependencyBundle(plan,[resource],{allowLifecycleScripts:false});
 const root=realpathSync(mkdtempSync(join(tmpdir(),'dependency-bundle-')));roots.push(root);
 const target=join(root,'payload'),material=materializeEngineeringDependencyBundle(bundle,target);expect(material.command).toBe('node /task/dependency-bundle/install.cjs '+bundle.manifestSha256);
 const raw=readFileSync(join(target,'manifest.json'));expect(createHash('sha256').update(raw).digest('hex')).toBe(bundle.manifestSha256);
 expect(readFileSync(join(target,plan.packages[0]!.fileName))).toEqual(body);expect(readFileSync(join(target,'install.cjs'),'utf8')).toBe(ENGINEERING_DEPENDENCY_SANDBOX_SCRIPT);
 expect(existsSync(join(root,'node_modules'))).toBe(false);expect(()=>materializeEngineeringDependencyBundle(bundle,target)).toThrow();expect(()=>materializeEngineeringDependencyBundle({...bundle},join(root,'forged'))).toThrow('bundle_provenance');
 chmodSync(target,0o700);const alias=join(root,'alias');symlinkSync(target,alias);expect(()=>materializeEngineeringDependencyBundle(bundle,join(alias,'nested'))).toThrow('parent');
});
test('bundle rejects copied receipts, mismatched SRI/provenance and non-boolean lifecycle authority',async()=>{
 const plan=createEngineeringDependencyPlan(input());const broker=createEngineeringNetworkBroker({binding:{taskId:'task',scopeKey:'private:project',deadlineMs:Date.now()+10000},assertCurrent(){},references:[{purpose:'dependency',url,integrity:sri,provenanceSha256:'f'.repeat(64)}],allowedOrigins:['https://registry.npmjs.org'],resolve:async()=>['1.1.1.1'],transport:async()=>({status:200,headers:{},bytes:body})});
 const wrong=await broker.download(broker.request(url));expect(()=>createEngineeringDependencyBundle(plan,[wrong],{allowLifecycleScripts:false})).toThrow('resource_binding');expect(()=>createEngineeringDependencyBundle(plan,[{...wrong}],{allowLifecycleScripts:false})).toThrow('resource_provenance');
 expect(()=>createEngineeringDependencyBundle(plan,[],{allowLifecycleScripts:false})).toThrow('resources');
});
