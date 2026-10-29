import { Database } from 'bun:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpendLedger } from '../../../src/spend.ts';
import { createStandingEngineeringBudget, type StandingEngineeringBudgetAuthority } from '../../../src/hermes/engineering-standing-budget.ts';

/** Disposable canonical ledger; no existing operator authority or live paths. */
export function standingBudgetFixture(taskCapMicros=4_000_000, capMicros=taskCapMicros*2) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'standing-engineering-'))), path=join(root,'spend.sqlite');
  const ledger=new SpendLedger(path), db=new Database(path);
  const authority:StandingEngineeringBudgetAuthority={version:1,poolId:'standing-engineering-pool',campaignId:'standing-engineering-campaign',
    capMicros,taskCapMicros,authoritySha256:'a'.repeat(64),holdReceiptSha256:'b'.repeat(64)};
  let authorized=true;
  const assertAuthority=()=>{if(!authorized)throw Error('revoked_funding');};
  const allocator=createStandingEngineeringBudget({ledger,authority,assertAuthority});
  return {root,path,ledger,db,authority,allocator,assertAuthority,revoke(){authorized=false;},
    input(n=1){return {requestId:'slack-request-'+n,requestHash:String(n).repeat(64).slice(0,64),taskId:'engineering-task-'+n};},
    dispose(){allocator.close();db.close();ledger.close();rmSync(root,{recursive:true,force:true});}};
}
