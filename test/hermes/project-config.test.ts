import {afterEach,expect,test} from 'bun:test';
import {chmodSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadProjectRuntimeConfig} from '../../src/hermes/project-config.ts';
const roots:string[]=[];afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'gary-project-config-')));roots.push(root);chmodSync(root,0o700);const path=join(root,'config.json');
 const value={version:1 as const,teamId:'T0AA24R7VUZ',ownerUserId:'U0A9M5W16F8',memoryPath:join(root,'project-memory.sqlite'),projects:[{id:'mulligan-labs',teamKey:'ERT',repo:'707-Labs/mulligan-labs',label:'Mulligan',summary:'Project data only',sharedChannelIds:['C0CHANNEL1']}]};
 const write=(v:unknown=value)=>{const raw=JSON.stringify(v);writeFileSync(path,raw,{mode:0o600});return createHash('sha256').update(raw).digest('hex');};return{root,path,value,write};}
test('exact hash and private configuration bind project identity, audience and separate memory path',()=>{
 const f=fixture(),hash=f.write();expect(loadProjectRuntimeConfig(f.path,hash)).toEqual(f.value);
 expect(()=>loadProjectRuntimeConfig(f.path,'0'.repeat(64))).toThrow('config_rejected');
 for(const change of [{teamId:'TFOREIGN'}, {ownerUserId:'U0OTHER123'}, {memoryPath:join(f.root,'foreign.sqlite')},
  {projects:[{...f.value.projects[0],repo:'foreign/private'}]}, {projects:[{...f.value.projects[0],teamKey:'BIRD'}]}, {projects:[...f.value.projects,...f.value.projects]}]){
   const hash=f.write({...f.value,...change});expect(()=>loadProjectRuntimeConfig(f.path,hash)).toThrow('config_rejected');
 }
 const current=f.write();chmodSync(f.path,0o644);expect(()=>loadProjectRuntimeConfig(f.path,current)).toThrow('config_rejected');
});
