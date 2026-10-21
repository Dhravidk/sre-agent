import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runProcessRecoveryDrill } from '../fixtures/process-recovery-drill.mjs';

const [scenario='credit-timeout',...flags]=process.argv.slice(2);
if(flags.some(flag=>!['--lost-response','--same-sha-race','--expired-approval','--credential-rotation'].includes(flag)))throw new Error('Use sre:process-drill <scenario> [--lost-response | --same-sha-race | --expired-approval | --credential-rotation]');
const directory=resolve('.local/deployment-drills',new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8));
const result=await runProcessRecoveryDrill({scenario,directory,lostDispatchResponse:flags.includes('--lost-response'),sameShaRace:flags.includes('--same-sha-race'),expiredApproval:flags.includes('--expired-approval'),credentialRotation:flags.includes('--credential-rotation')});
console.log(JSON.stringify({mode:result.mode,scenario,outcome:result.outcome,dispatchCount:result.dispatchCount,processes:result.processes.length,report:directory+'/report.json',limitations:result.limitations},null,2));
