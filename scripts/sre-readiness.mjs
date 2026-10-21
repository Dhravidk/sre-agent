import { readFileSync } from 'node:fs';
import { assessReadiness } from '../src/sre/readiness.mjs';

const config=JSON.parse(readFileSync(process.env.SRE_CONFIG||'config/sre.local.json','utf8'));
const result=assessReadiness(config,process.env);
if(process.argv.includes('--json'))console.log(JSON.stringify(result,null,2));
else {
  console.log('SRE setup readiness ('+result.mode+'; offline inspection, zero network calls)');
  for(const check of result.checks)console.log(check.service+' / '+check.source+': '+(check.enabled?'enabled':'disabled')+'; '+(check.credentialMode?'auth '+check.credentialMode+'; ':'')+(check.configurationReady?'configuration present; live access unverified':'needs '+check.missing.join(', ')));
  if(result.core.missing.length)console.log('Connected runtime: '+result.core.missing.join(', '));
  console.log(result.note);
}
if(process.argv.includes('--strict')&&(!result.core.configurationReady||result.checks.some(check=>check.enabled&&!check.configurationReady)))process.exitCode=1;
