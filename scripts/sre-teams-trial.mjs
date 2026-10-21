import {readFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSreRuntime} from '../src/sre/server.mjs';
import {seedDemo} from '../src/sre/demo.mjs';
import {teamsTrialConfig,teamsTrialGateway,trialForwardingAllowed,gateTrialDeliveries,trialNoticeSender} from '../src/sre/teams-trial.mjs';

process.chdir(fileURLToPath(new URL('../',import.meta.url)));
const settingsPath=resolve(process.env.SRE_TEAMS_TRIAL_SETTINGS||'.local/live-teams-trial/settings.json');
const settings=JSON.parse(readFileSync(settingsPath,'utf8'));
const config=teamsTrialConfig(settings,process.env);
const directory=resolve(settings.directory||'.local/live-teams-trial');mkdirSync(directory,{recursive:true,mode:0o700});
const runtime=await createSreRuntime({config,connectors:new Map([[config.services[0].key,{}]])});
const trialEnabled=()=>trialForwardingAllowed(resolve(directory,'forwarding.json'),settings);
gateTrialDeliveries(runtime.outbox,trialEnabled);
const sender=runtime.outbox.sender;
runtime.outbox.sender=trialNoticeSender(sender);
let gateway,readiness;
try {
  const [existing]=await runtime.store.db.query('SELECT id FROM sre_incidents WHERE service_key=? ORDER BY started_at LIMIT 1',[config.services[0].key]);
  const incidentId=existing?.id||(await seedDemo(runtime.store,config.services[0])).incidentId;
  await new Promise((resolve,reject)=>{runtime.server.once('error',reject);runtime.server.listen(config.port,'127.0.0.1',resolve);});
  gateway=teamsTrialGateway({upstream:'http://127.0.0.1:'+runtime.teamsAddress.port+'/api/messages',enabled:trialEnabled,organizationAccess:settings.admission==='tenant'});
  await new Promise((resolve,reject)=>{gateway.once('error',reject);gateway.listen(settings.gatewayPort??3979,'127.0.0.1',resolve);});
  readiness={trial:'real Teams transport / fictional provider evidence',admission:settings.admission||'allowlist',agentMode:'rules',deploymentExecution:false,incidentId,console:'http://127.0.0.1:'+runtime.server.address().port,bot:'http://127.0.0.1:'+runtime.teamsAddress.port,gateway:'http://127.0.0.1:'+gateway.address().port,webhookForwarding:'closed unless an exact, unexpired local grant exists'};
} catch(error) {await runtime.close();if(gateway?.listening)await new Promise(resolve=>gateway.close(resolve));throw error;}
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{if(stopping)return;stopping=true;await new Promise(resolve=>gateway.close(resolve));await runtime.close();});
console.log(JSON.stringify(readiness));
