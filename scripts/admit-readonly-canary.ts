/** Deliberate operator entrypoint. Default is read-only preview; --apply grants no model execution. */
import { admitReadonlyCanary } from '../src/hermes/readonly-canary-budget.ts';

if(import.meta.main){
  const flags=new Map<string,string>();let apply=false;
  const allowed=new Set(['--aggregate','--ledger','--audit-dir','--run-id','--campaign-id','--allocation-id','--expected-sha256']);
  const args=process.argv.slice(2);
  for(let i=0;i<args.length;i++){
    const key=args[i]!;if(key==='--apply'&&!apply){apply=true;continue;}
    if(!allowed.has(key)||flags.has(key)||!args[i+1]||args[i+1]!.startsWith('--'))throw new Error('invalid admission flags');
    flags.set(key,args[++i]!);
  }
  if(flags.size!==allowed.size)throw new Error('usage: bun scripts/admit-readonly-canary.ts --aggregate ABS_JSON --ledger ABS_EXISTING_SQLITE --audit-dir ABS_PRIVATE_DIR --run-id ID --campaign-id NEW_ID --allocation-id local:NEW_ID --expected-sha256 HASH [--apply]');
  const result=admitReadonlyCanary({aggregatePath:flags.get('--aggregate')!,ledgerPath:flags.get('--ledger')!,auditDir:flags.get('--audit-dir')!,
    runId:flags.get('--run-id')!,campaignId:flags.get('--campaign-id')!,allocationId:flags.get('--allocation-id')!,expectedAggregateSha256:flags.get('--expected-sha256')!,apply});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
