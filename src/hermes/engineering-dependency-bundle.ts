/** Host materializes verified bytes; all unpacking/package-manager execution
 * belongs to the admitted sandbox. No host install/extraction/network occurs. */
import { createHash } from 'node:crypto';
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { assertEngineeringDownloadedResource, type EngineeringDownloadedResource } from './engineering-network-broker.ts';
import { assertEngineeringDependencyPlan, engineeringDependencyPlanFiles, type EngineeringDependencyPlan } from './engineering-dependency-plan.ts';
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
function fail(code: string): never { throw Error('engineering_dependency_bundle:' + code); }
export interface EngineeringDependencyBundle {
    readonly planHash: string;
    readonly manifestSha256: string;
    readonly bytes: number;
    readonly files: readonly {
        path: string;
        sha256: string;
        bytes: number;
    }[];
}
const bundles = new WeakMap<object, Map<string, Uint8Array>>();
export interface EngineeringDependencyPreparation {
    readonly root: string;
    readonly manifestSha256: string;
    readonly command: string;
    assertCurrent(): void;
}
const prepared = new WeakSet<object>();
export function assertEngineeringDependencyPreparation(value: EngineeringDependencyPreparation): void { if (!value || !prepared.has(value))
    fail('preparation_provenance'); value.assertCurrent(); }
/** Fixed audited program is only an artifact until mounted and invoked inside
 * a network-none executor. It never evaluates package metadata as host code. */
export const ENGINEERING_DEPENDENCY_SANDBOX_SCRIPT = String.raw `'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http'),cp=require('node:child_process');
const ROOT='/task/dependency-bundle',WORK='/workspace',sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function check(v,c){if(!v)throw Error('dependency_sandbox:'+c);}
const expected=process.argv[2];check(/^[a-f0-9]{64}$/.test(expected),'manifest_pin');
function regular(p,max){const s=fs.lstatSync(p);check(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=max,'file');return fs.readFileSync(p);}
const raw=regular(ROOT+'/manifest.json',2*1024*1024);check(sha(raw)===expected,'manifest_changed');const m=JSON.parse(raw);
check(m.version===1&&['bun','npm'].includes(m.kind)&&/^[a-f0-9]{64}$/.test(m.planHash)&&typeof m.allowLifecycleScripts==='boolean','manifest');
check(fs.realpathSync(WORK)===WORK&&fs.lstatSync(WORK).isDirectory(),'workspace');
const files=new Map();for(const f of m.files){check(/^(?:package.json|bun.lock|package-lock.json|[a-f0-9]{64}\.tgz)$/.test(f.path),'path');const b=regular(ROOT+'/'+f.path,64*1024*1024);check(b.length===f.bytes&&sha(b)===f.sha256,'payload_changed');files.set(f.path,b);}
for(const name of ['package.json',m.lockfileName])check(sha(regular(WORK+'/'+name,16*1024*1024))===sha(files.get(name)),'workspace_changed');
const cache='/tmp/gary-dependency-cache-'+m.planHash;fs.mkdirSync(cache,{mode:0o700});
const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:cache,TMPDIR:'/tmp',CI:'1',BUN_INSTALL_CACHE_DIR:cache+'/bun',npm_config_cache:cache+'/npm',npm_config_update_notifier:'false',npm_config_audit:'false',npm_config_fund:'false'};
function run(bin,args){return new Promise((yes,no)=>{const child=cp.spawn(bin,args,{cwd:WORK,env,stdio:['ignore','inherit','inherit'],shell:false});child.once('error',no);child.once('exit',(code,signal)=>code===0&&!signal?yes():no(Error('dependency_sandbox:install_failed')));});}
(async()=>{let mirror;let rejected=0;try{
 if(m.kind==='npm'){
  for(const p of m.packages)await run('npm',['cache','add',ROOT+'/'+p.fileName,'--ignore-scripts','--offline']);
  await run('npm',['ci','--offline','--ignore-scripts','--no-audit','--no-fund']);
 }else{
  const routes=new Map(m.packages.map(p=>[new URL(p.url).pathname,files.get(p.fileName)]));
  mirror=http.createServer((req,res)=>{const body=routes.get(req.url);const ok=['GET','HEAD'].includes(req.method)&&body&&(!req.headers['content-length']||req.headers['content-length']==='0')&&!req.headers['transfer-encoding'];if(!ok)rejected++;res.writeHead(ok?200:403,{'Content-Type':'application/octet-stream','Content-Length':ok?body.length:0,'Connection':'close'});res.end(ok&&req.method==='GET'?body:undefined);});
  mirror.requestTimeout=5000;mirror.headersTimeout=5000;await new Promise((yes,no)=>{mirror.once('error',no);mirror.listen(0,'127.0.0.1',yes);});
  await run('bun',['install','--frozen-lockfile','--ignore-scripts','--registry=http://127.0.0.1:'+mirror.address().port]);
  await new Promise((yes,no)=>mirror.close(e=>e?no(e):yes()));mirror=null;check(rejected===0,'mirror_rejected');
  // Repeat frozen/offline after the mirror has closed. This proves that the
  // selected Bun version can use these downloaded packages without networking.
  fs.rmSync(WORK+'/node_modules',{recursive:true,force:true});
  await run('bun',['install','--frozen-lockfile','--offline','--ignore-scripts']);
 }
 for(const name of ['package.json',m.lockfileName])check(sha(regular(WORK+'/'+name,16*1024*1024))===sha(files.get(name)),'workspace_changed');
 if(m.allowLifecycleScripts){if(m.kind==='npm')await run('npm',['ci','--offline','--no-audit','--no-fund']);else{fs.rmSync(WORK+'/node_modules',{recursive:true,force:true});await run('bun',['install','--frozen-lockfile','--offline']);}}
 for(const name of ['package.json',m.lockfileName])check(sha(regular(WORK+'/'+name,16*1024*1024))===sha(files.get(name)),'workspace_changed');
 console.log(JSON.stringify({kind:'engineering_dependency_install',version:1,planHash:m.planHash,manifestSha256:expected,offlineInstall:true,lifecycleScripts:m.allowLifecycleScripts}));
 }finally{if(mirror)await new Promise(resolve=>mirror.close(resolve));}})().catch(()=>{console.error('dependency_sandbox:failed');process.exitCode=1;});
`;
export function createEngineeringDependencyBundle(plan: EngineeringDependencyPlan, resources: readonly EngineeringDownloadedResource[], options: {
    allowLifecycleScripts: boolean;
}): EngineeringDependencyBundle {
    assertEngineeringDependencyPlan(plan);
    if (typeof options.allowLifecycleScripts !== 'boolean' || resources.length !== plan.packages.length)
        fail('resources');
    const byUrl = new Map<string, EngineeringDownloadedResource>();
    for (const resource of resources) {
        assertEngineeringDownloadedResource(resource);
        if (byUrl.has(resource.receipt.url))
            fail('duplicate');
        byUrl.set(resource.receipt.url, resource);
    }
    const files = new Map<string, Uint8Array>(), source = engineeringDependencyPlanFiles(plan);
    files.set('package.json', source.packageJson);
    files.set(plan.lockfileName, source.lockfile);
    let bytes = source.packageJson.length + source.lockfile.length;
    for (const pkg of plan.packages) {
        const r = byUrl.get(pkg.url);
        if (!r || r.receipt.purpose !== 'dependency' || r.receipt.provenanceSha256 !== plan.hash || r.receipt.integrity !== pkg.integrity)
            fail('resource_binding');
        const raw = r.bytes();
        bytes += raw.length;
        if (bytes > 512 * 1024 * 1024)
            fail('byte_limit');
        files.set(pkg.fileName, raw);
    }
    const inventory = [...files].map(([path, raw]) => Object.freeze({ path, sha256: sha(raw), bytes: raw.length }));
    const manifest = { version: 1, kind: plan.kind, planHash: plan.hash, lockfileName: plan.lockfileName, packages: plan.packages,
        provenanceSha256: plan.provenanceSha256, packageJsonSha256: plan.packageJsonSha256, lockfileSha256: plan.lockfileSha256,
        downloadReceipts: plan.packages.map(pkg => byUrl.get(pkg.url)!.receipt),
        allowLifecycleScripts: options.allowLifecycleScripts, files: inventory };
    const raw = Buffer.from(JSON.stringify(manifest));
    if (raw.length > 2 * 1024 * 1024) fail('manifest_size');
    files.set('manifest.json', raw);
    files.set('install.cjs', Buffer.from(ENGINEERING_DEPENDENCY_SANDBOX_SCRIPT));
    const bundle = Object.freeze({ planHash: plan.hash, manifestSha256: sha(raw), bytes,
        files: Object.freeze([...files].map(([path, b]) => Object.freeze({ path, sha256: sha(b), bytes: b.length }))) });
    bundles.set(bundle, files);
    return bundle;
}
/** Exclusive, private fresh destination only. Mount the returned root read-only;
 * do not mount its parent, host journals or broker state into the executor. */
export function materializeEngineeringDependencyBundle(bundle: EngineeringDependencyBundle, destination: string): EngineeringDependencyPreparation {
    const files = bundles.get(bundle);
    if (!files)
        fail('bundle_provenance');
    if (!isAbsolute(destination) || resolve(destination) !== destination)
        fail('destination');
    const parent = dirname(destination), s = lstatSync(parent);
    if (realpathSync(parent) !== parent || !s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0)
        fail('parent');
    mkdirSync(destination, { mode: 0o700 });
    const root = lstatSync(destination);
    for (const [name, raw] of files) {
        if (realpathSync(destination) !== destination || lstatSync(destination).ino !== root.ino || lstatSync(parent).ino !== s.ino)
            fail('destination_changed');
        const fd = openSync(join(destination, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
        try {
            writeFileSync(fd, raw);
            fsyncSync(fd);
            fchmodSync(fd, 0o444);
            if (fstatSync(fd).nlink !== 1)
                fail('file_changed');
        }
        finally {
            closeSync(fd);
        }
    }
    const directory = openSync(destination, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
        fsyncSync(directory);
        fchmodSync(directory, 0o500);
    }
    finally {
        closeSync(directory);
    }
    const identities = new Map(bundle.files.map(f => [f.path, lstatSync(join(destination, f.path))]));
    const assertCurrent = () => {
        const current = lstatSync(destination);
        if (realpathSync(destination) !== destination || !current.isDirectory() || current.dev !== root.dev || current.ino !== root.ino || current.uid !== root.uid || (current.mode & 0o777) !== 0o500)
            fail('materialization_changed');
        if (JSON.stringify(readdirSync(destination).sort()) !== JSON.stringify(bundle.files.map(f => f.path).sort()))
            fail('materialization_changed');
        for (const f of bundle.files) {
            const old = identities.get(f.path)!, fd = openSync(join(destination, f.path), constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const opened = fstatSync(fd);
                if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== old.dev || opened.ino !== old.ino || opened.uid !== old.uid || (opened.mode & 0o777) !== 0o444 || opened.size !== f.bytes || sha(readFileSync(fd)) !== f.sha256)
                    fail('materialization_changed');
                const after = fstatSync(fd), pathNow = lstatSync(join(destination, f.path));
                if (after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || pathNow.ino !== opened.ino || pathNow.dev !== opened.dev)
                    fail('materialization_changed');
            }
            finally {
                closeSync(fd);
            }
        }
    };
    assertCurrent();
    const result = Object.freeze({ root: destination, manifestSha256: bundle.manifestSha256, command: `node /task/dependency-bundle/install.cjs ${bundle.manifestSha256}`, assertCurrent });
    prepared.add(result);
    return result;
}
