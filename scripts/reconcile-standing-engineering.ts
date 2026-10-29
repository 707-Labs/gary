/** Explicit operator CLI. No balances or historical receipts are rewritten. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {loadStandingEngineeringConfig} from '../src/hermes/standing-engineering-config.ts';
import {createStandingEngineeringFundingGuard} from '../src/hermes/engineering-standing-funding.ts';
import {createStandingEngineeringBudget} from '../src/hermes/engineering-standing-budget.ts';
import {SpendLedger} from '../src/spend.ts';
const args=process.argv.slice(2),values=new Map<string,string[]>();
for(let i=0;i<args.length;i++){
 const key=args[i]!;if(!['--config','--config-sha256','--authority','--authority-sha256','--ledger','--evidence','--task','--chat-attempt','--apply'].includes(key))throw Error('unknown option');
 const value=key==='--apply'?'true':args[++i];if(!value||value.startsWith('--'))throw Error('missing value');
 values.set(key,[...(values.get(key)??[]),value]);
}
function one(key:string){const v=values.get(key);if(!v||v.length!==1)throw Error('required single option '+key);return v[0]!;}
const c=loadStandingEngineeringConfig(one('--config'),one('--config-sha256'),one('--authority'),one('--authority-sha256'));
const ledgerPath=one('--ledger'),guard=createStandingEngineeringFundingGuard({authority:c.funding,fundingAuthorityPath:c.fundingAuthorityPath,
 fundingHoldReceiptPath:c.fundingHoldReceiptPath,aggregatePath:c.aggregatePath,ledgerPath});guard();
const ledger=new SpendLedger(ledgerPath);
try{
 const budget=createStandingEngineeringBudget({ledger,authority:c.funding,assertAuthority:guard,terminalJournalPath:c.root+'/engineering.sqlite'});
 const before=budget.status();
 if(values.has('--apply')){
  const evidence=readFileSync(one('--evidence')),ids=(values.get('--chat-attempt')??[]).map(s=>{if(!/^[1-9][0-9]*$/.test(s))throw Error('invalid attempt');return Number(s);});
  const result=budget.reconcileTerminalTasks({taskIds:values.get('--task')??[],historicalChatAttemptIds:ids,
   operatorEvidenceSha256:createHash('sha256').update(evidence).digest('hex')});
  console.log(JSON.stringify({before,...result},null,2));
 }else console.log(JSON.stringify({before,applied:false},null,2));
 budget.close();
}finally{ledger.close();}
