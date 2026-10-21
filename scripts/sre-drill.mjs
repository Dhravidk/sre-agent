import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runRecoveryDrill } from '../fixtures/recovery-drill.mjs';

const scenario=process.argv[2]||'bid-race';
const directory=resolve('.local/recovery-drills',new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8));
mkdirSync(directory,{recursive:true});
try {
  const result=await runRecoveryDrill({scenario,directory});
  writeFileSync(resolve(directory,'report.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({mode:result.mode,scenario,outcome:result.outcome,codeFindings:result.codeFindings.length,dispatchCount:result.dispatchCount,report:resolve(directory,'report.json')},null,2));
} catch(error) {
  writeFileSync(resolve(directory,'failure.json'),JSON.stringify({scenario,error:error.message,stack:error.stack},null,2)+'\n');
  console.error('Recovery drill failed:',error.message);process.exitCode=1;
}
