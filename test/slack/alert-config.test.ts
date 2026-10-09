import {afterEach,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,chmodSync,rmSync,realpathSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadSlackAlertConfig,openSlackAlertDatabase} from '../../src/slack/alert-config.ts';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const policy={version:1,mode:'draft',teamId:'T0AA24R7VUZ',channelId:'C0AKGTZM8KB',botId:'B0AJNH6K4LF',appId:'A0AK0JCN5PF'};
function fixture(value:unknown=policy){const root=realpathSync(mkdtempSync(join(tmpdir(),'gary-alert-config-')));roots.push(root);chmodSync(root,0o700);
 const path=join(root,'config.json'),raw=JSON.stringify(value);writeFileSync(path,raw,{mode:0o600});
 return{root,path,sha:createHash('sha256').update(raw).digest('hex')};}
test('only exact producer and channel policy in a private hashed file opens a separate alert database',()=>{
 const f=fixture(),cfg=loadSlackAlertConfig(f.path,f.sha);expect(cfg.mode).toBe('draft');expect(cfg.fingerprint).toBe(f.sha);
 const db=openSlackAlertDatabase(cfg);try{expect(db.query('PRAGMA database_list').all()).toMatchObject([{file:join(f.root,'alerts.sqlite')}]);}finally{db.close();}
});
test('wrong hash, producer, workspace, channel or unknown capability is rejected',()=>{
 const good=fixture();expect(()=>loadSlackAlertConfig(good.path,'0'.repeat(64))).toThrow();
 for(const change of [{botId:'BOTHER123'},{appId:'AOTHER123'},{teamId:'TOTHER123'},{channelId:'COTHER123'},{mode:'auto-remediate'},{tools:['run_shell']},{version:2}]){
  const f=fixture({...policy,...change});expect(()=>loadSlackAlertConfig(f.path,f.sha)).toThrow();
 }
});
test('config identity checks reject symlinks, permissive modes and repeated fields',()=>{
 const f=fixture();chmodSync(f.path,0o644);expect(()=>loadSlackAlertConfig(f.path,f.sha)).toThrow();chmodSync(f.path,0o600);
 const link=join(f.root,'alias.json');symlinkSync(f.path,link);expect(()=>loadSlackAlertConfig(link,f.sha)).toThrow();
 const raw=JSON.stringify(policy).replace('"version":1','"version":2,"version":1');writeFileSync(f.path,raw);
 expect(()=>loadSlackAlertConfig(f.path,createHash('sha256').update(raw).digest('hex'))).toThrow();
});
test('database symlinks and unexpected recovery sidecars never reach SQLite',()=>{
 for(const suffix of ['', '-wal','-shm','-journal']){
  const f=fixture(),cfg=loadSlackAlertConfig(f.path,f.sha),victim=join(f.root,'other.sqlite');writeFileSync(victim,'preserve',{mode:0o600});
  symlinkSync(victim,join(f.root,'alerts.sqlite')+suffix);expect(()=>openSlackAlertDatabase(cfg)).toThrow();
 }
});
