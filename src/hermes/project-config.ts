/** Reviewed host configuration; never accepted from a conversation or model. */
import { constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname,isAbsolute,normalize,join } from 'node:path';
import type { ProjectRegistration } from './project-assistant.ts';
import type { WorkProject } from './work-context.ts';

export interface ProjectRuntimeConfig {version:1;teamId:string;ownerUserId:string;memoryPath:string;projects:readonly (ProjectRegistration&WorkProject)[]}
const REPOS:Record<string,{repo:string;teamKey:string}>={
 'gary-role':{repo:'707-Labs/gary',teamKey:'GARY'},
 'mulligan-labs':{repo:'707-Labs/mulligan-labs',teamKey:'ERT'},
 'green-ledger':{repo:'707-Labs/green-ledger',teamKey:'GREEN'},
 'birdup':{repo:'707-Labs/birdup',teamKey:'BIRD'},
};
function reject():never {throw new Error('project_runtime_config_rejected');}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function loadProjectRuntimeConfig(path:string,expectedSha256:string):ProjectRuntimeConfig {
 if(!isAbsolute(path)||normalize(path)!==path||realpathSync(path)!==path||!/^[a-f0-9]{64}$/.test(expectedSha256))reject();
 const parent=lstatSync(dirname(path)),before=lstatSync(path);
 if(!parent.isDirectory()||parent.uid!==process.getuid?.()||(parent.mode&0o777)!==0o700||before.isSymbolicLink()||!before.isFile()||before.nlink!==1||before.uid!==process.getuid?.()||(before.mode&0o777)!==0o600||before.size>48_000)reject();
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let raw:Buffer;
 try{const s=fstatSync(fd);if(s.dev!==before.dev||s.ino!==before.ino||s.size>48_000)reject();raw=readFileSync(fd);}finally{closeSync(fd);}
 if(createHash('sha256').update(raw).digest('hex')!==expectedSha256)reject();
 const v:unknown=JSON.parse(raw.toString('utf8'));
 if(!object(v)||Object.keys(v).sort().join(',')!=='memoryPath,ownerUserId,projects,teamId,version'||v.version!==1||v.teamId!=='T0AA24R7VUZ'||v.ownerUserId!=='U0A9M5W16F8'||v.memoryPath!==join(dirname(path),'project-memory.sqlite')||!Array.isArray(v.projects)||v.projects.length<1||v.projects.length>4)reject();
 const ids=new Set<string>();
 for(const p of v.projects){
  if(!object(p)||typeof p.id!=='string'||ids.has(p.id)||!REPOS[p.id]||p.repo!==REPOS[p.id]!.repo||p.teamKey!==REPOS[p.id]!.teamKey
   ||Object.keys(p).some(k=>!['id','repo','teamKey','label','summary','sharedChannelIds','root','revision','readPaths'].includes(k))
   ||typeof p.label!=='string'||typeof p.summary!=='string'||!Array.isArray(p.sharedChannelIds)||p.sharedChannelIds.some(c=>typeof c!=='string'||!/^C[A-Z0-9]{8,20}$/.test(c)))reject();
  ids.add(p.id);
 }
 return Object.freeze(v) as unknown as ProjectRuntimeConfig;
}
