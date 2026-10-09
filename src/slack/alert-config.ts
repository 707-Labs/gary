/** Explicit, hash-pinned host policy. No environment/model supplied recipient or producer. */
import { Database } from 'bun:sqlite';
import { constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname,isAbsolute,normalize,join } from 'node:path';

export interface SlackAlertConfig {
  readonly version:1;
  readonly mode:'draft'|'publish';
  readonly producer:Readonly<{botId:'B0AJNH6K4LF';appId:'A0AK0JCN5PF'}>;
  readonly directory:string;
  readonly fingerprint:string;
}
const reject=():never=>{throw new Error('slack_alert_config_rejected');};
function privatePath(path:string,directory:boolean):void {
  const s=lstatSync(path);
  if(s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o777)!==(directory?0o700:0o600)
    ||(directory?!s.isDirectory():!s.isFile()||s.nlink!==1)||realpathSync(path)!==path)reject();
}
export function loadSlackAlertConfig(path:string,sha256:string):SlackAlertConfig {
  if(!isAbsolute(path)||normalize(path)!==path||/[\0\r\n]/.test(path)||!/^[a-f0-9]{64}$/.test(sha256))reject();
  privatePath(dirname(path),true);privatePath(path,false);
  const before=lstatSync(path),fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let raw:Buffer;
  try {const s=fstatSync(fd);if(s.dev!==before.dev||s.ino!==before.ino||s.size>2048)reject();raw=readFileSync(fd);}
  finally {closeSync(fd);}
  if(createHash('sha256').update(raw).digest('hex')!==sha256)reject();
  const source=raw.toString('utf8'),v=JSON.parse(source),keys=[...source.matchAll(/"([^"\\]*)"\s*:/g)].map(m=>m[1]);
  if(!v||Array.isArray(v)||Object.keys(v).sort().join(',')!=='appId,botId,channelId,mode,teamId,version'
    ||keys.length!==6||new Set(keys).size!==6||v.version!==1||v.teamId!=='T0AA24R7VUZ'||v.channelId!=='C0AKGTZM8KB'
    ||v.botId!=='B0AJNH6K4LF'||v.appId!=='A0AK0JCN5PF'||!['draft','publish'].includes(v.mode))reject();
  return Object.freeze({version:1,mode:v.mode,producer:Object.freeze({botId:v.botId,appId:v.appId}),directory:dirname(path),fingerprint:sha256});
}
/** Only this isolated file is opened; no canonical Gary, spend or conversation database is passed in. */
export function openSlackAlertDatabase(config:SlackAlertConfig):Database {
  privatePath(config.directory,true);
  const file=join(config.directory,'alerts.sqlite');
  try {const fd=openSync(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);closeSync(fd);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  privatePath(file,false);
  // Unexpected recovery files require an operator review; SQLite must not
  // follow a sidecar symlink or perform an unreviewed recovery on open.
  for(const suffix of ['-wal','-shm','-journal']){
    try {lstatSync(file+suffix);reject();}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  const before=lstatSync(file),db=new Database(file,{strict:true});
  try {privatePath(file,false);const after=lstatSync(file);if(before.dev!==after.dev||before.ino!==after.ino)reject();return db;}
  catch(error){db.close();throw error;}
}
