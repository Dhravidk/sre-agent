import {createSreRuntime} from '../src/sre/server.mjs';
import {validateConfig} from '../src/sre/config.mjs';
import {GitlabConnector} from '../src/sre/connectors.mjs';
import {boundedContext} from '../src/sre/model-context.mjs';
import {RulesReasoner} from '../src/sre/reasoner.mjs';
import {rehearsalProfile} from './sre-rehearsal.mjs';
import {devActivity} from '../src/sre/demo.mjs';
import {diagnosticGit,diagnosticRecords,diagnosticSourcePath} from './sre-diagnostic-corpus.mjs';
import {hash} from '../src/sre/security.mjs';
import {resolve} from 'node:path';

// This exercises the real host and read-only GitLab connector with fictional
// provider/Teams transport. It deliberately has no model or QA adapter option.
export async function replayDiagnosticCorpus(corpus,gold,{databasePath=':memory:',databaseFactory}={}){
  if(resolve(databasePath)===resolve('.local/sre.sqlite'))throw Error('Use a dedicated diagnostic evaluation database');
  const raw=rehearsalProfile(),template=structuredClone(raw.services[0]),at=Date.now()-1000,calls=[],sent=[],connectors=new Map();
  raw.services=corpus.cases.map((entry,index)=>{
    if(entry.path!==diagnosticSourcePath)throw Error('Diagnostic replay accepts only the authored source path');
    const service=structuredClone(template);service.key='diagnostic-'+String(index+1).padStart(2,'0');service.name='Fictional '+entry.name;service.environment='testing';service.logMonitors=[{id:'case-observations',codes:[entry.code],minCount:3,windowSeconds:900}];
    service.dynatrace={...service.dynatrace,enabled:false,entityId:'SERVICE-DIAGNOSTIC-'+index};service.github={...service.github,enabled:false};service.servicenow={...service.servicenow,enabled:false};service.jira={...service.jira,enabled:false};service.rollback={...service.rollback,enabled:false,provider:'gitlab'};
    service.gitlab={enabled:false,base:'https://gitlab-diagnostic-fixture.invalid',project:entry.project,tokenEnv:'DIAGNOSTIC_FIXTURE_READER',sourceInspection:{enabled:true}};
    service.teams={...service.teams,conversations:['bidding','platform','workers'].map(room=>service.key+'-'+room),captureResponderUpdates:true};service.teams.alertConversationId=service.teams.conversations[0];service.teams.collaborationGroups=[{key:service.key+'-response',name:'Fictional diagnostic response',conversations:service.teams.conversations.map((id,n)=>({id,name:['Bidding','Platform','Worker desk'][n]}))}];
    const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}}),records=diagnosticRecords(entry,gold.find(value=>value.caseId===entry.id),at);
    const client=new GitlabConnector(service.gitlab,{env:{DIAGNOSTIC_FIXTURE_READER:'fictional-reader-no-access'},retries:0,fetcher:async(url,options)=>{
      const parsed=new URL(url),root='/api/v4/projects/'+encodeURIComponent(entry.project);if(options.method!=='GET'||!parsed.pathname.startsWith(root+'/'))throw Error('Diagnostic connector requires scoped read-only fixture routes');
      calls.push({caseId:entry.id,method:options.method,path:parsed.pathname,query:parsed.search});
      if(parsed.pathname===root+'/deployments')return reply([entry.revisions.base,entry.revisions.observed].map((sha,n)=>({id:100+n,sha,environment:{name:service.environment},status:'success',created_at:new Date(at-(n?300000:900000)).toISOString(),updated_at:new Date(at-(n?300000:900000)).toISOString()})));
      if(parsed.pathname===root+'/repository/compare'){
        if(parsed.searchParams.get('from')!==entry.revisions.base||parsed.searchParams.get('to')!==entry.revisions.observed)throw Error('Diagnostic comparison requires its exact admitted pair');
        const diff=await diagnosticGit(corpus,entry.id,['diff','--no-ext-diff',entry.revisions.base,entry.revisions.observed,'--',entry.path],{raw:true}),title=await diagnosticGit(corpus,entry.id,['show','-s','--format=%s',entry.revisions.observed]);return reply({commit:{id:entry.revisions.observed,title,parent_ids:[entry.revisions.base]},compare_timeout:false,diffs:[{old_path:entry.path,new_path:entry.path,new_file:false,deleted_file:false,renamed_file:false,too_large:false,collapsed:false,diff}]});
      }
      if(parsed.pathname.startsWith(root+'/repository/files/')){
        const path=decodeURIComponent(parsed.pathname.slice((root+'/repository/files/').length)),sha=parsed.searchParams.get('ref');if(path!==entry.path||![entry.revisions.base,entry.revisions.observed].includes(sha))throw Error('Diagnostic source request escaped the delivered revision/path');
        if(entry.denyObservedSource&&sha===entry.revisions.observed)return reply({message:'Controlled source permission denial'},403);
        const bytes=await diagnosticGit(corpus,entry.id,['show',sha+':'+path],{raw:true});return reply({file_path:path,commit_id:sha,encoding:'base64',size:Buffer.byteLength(bytes),content:Buffer.from(bytes).toString('base64')});
      }
      if(parsed.pathname.endsWith('/merge_requests')&&parsed.pathname.includes('/repository/commits/'))return reply([]);
      throw Error('Unexpected diagnostic fixture route');
    }});
    connectors.set(service.key,{gitlab:client,dynatraceLogs:{logs:async()=>({records:structuredClone(records),complete:true,interpretation:'Exactly three authored request observations; fictional provider contract, not global health or real Dynatrace acceptance.'})}});return service;
  });
  const config=validateConfig(raw,{SRE_SQLITE_PATH:databasePath,SRE_CLAUDE_BIN:'/nonexistent-diagnostic-corpus-claude',SRE_TEAMS_MODE:'off'}),inputs=new Map(),latestInputs=new Map(),rules=new RulesReasoner(),reasoner={investigate:async(context,options)=>{const input={request:options?.question||'Investigate the observed request behavior. Cite exact source where supported, explain competing explanations and missing evidence, and coordinate the reported work without claiming a fix or recovery.',incident:boundedContext(context)};if(!inputs.has(context.incident.service_key))inputs.set(context.incident.service_key,input);latestInputs.set(context.incident.service_key,input);return rules.investigate(context,options);}};let r,sequence=0;
  const open=async()=>{r=await createSreRuntime({config,db:await databaseFactory?.(),connectors,reasoner,autoStart:false,sender:{send:async(reference,text)=>{sent.push({room:reference.conversation.id,text});return{id:'diagnostic-send-'+ ++sequence,simulation:true};}}});};await open();
  const settle=async()=>{for(let n=0;n<150;n++){const[row]=await r.store.db.query("SELECT COUNT(*) AS n FROM sre_jobs WHERE status IN ('pending','running')");if(!Number(row.n))return;await r.investigate();}throw Error('Diagnostic replay work did not settle');};
  const deliver=async()=>{for(let n=0;n<100;n++){await r.deliver();await r.outbox.drainSettled();const[row]=await r.store.db.query("SELECT COUNT(*) AS n FROM sre_outbox WHERE status IN ('pending','sending') AND conversation_key IS NOT NULL");if(!Number(row.n))return;}throw Error('Fictional diagnostic Teams outbox did not drain');};
  const message=async(service,room,text,user)=>{const value=devActivity(text,service,{id:'diagnostic-message-'+ ++sequence,conversationId:room,conversationType:'channel',userId:user,displayName:user+' · fictional diagnostic responder'});await r.router.accept(value.activity,value.reference);await r.router.processOnce();};
  let cases=[];
  try{
    const [existing]=await r.store.db.query('SELECT COUNT(*) AS n FROM sre_events');if(Number(existing.n))throw Error('Diagnostic replay requires a fresh dedicated database');
    for(const [index,entry]of corpus.cases.entries()){
      const service=config.services[index],records=diagnosticRecords(entry,gold.find(value=>value.caseId===entry.id),at),detection=await r.logDetector.observe(service,'dynatrace',{records,complete:true});
      const detected=detection.incidents.length===1;let id=detection.incidents[0];
      if(!id)id=(await r.store.ingest({id:hash(['diagnostic-control',entry.id]),source:'operator-api',serviceKey:service.key,kind:'problem',issueKey:'DIAGNOSTIC-CONTROL-'+index,status:'OPEN',at,payload:{title:'Requested routine review: '+entry.name,synthetic:true,manualReview:true}})).incidentId;
      await r.store.addEvidence(id,'dynatrace','logs',{records,complete:true,synthetic:true,interpretation:'Observed trusted first-party checks through fictional provider transport; bounded request sample only.'},at);
      await r.casework.importDirectory(service.key,{source:'Authored diagnostic ownership fixture',observedAt:at,expiresAt:at+86400000,entries:[{id:service.key+'-owner',name:'Fictional service owner',team:'Application responders',contact:service.key+'@example.invalid',role:'service-owner',paths:[]}]});
      const rooms=service.teams.conversations.map((root,n)=>root+';messageid='+String(9000000000001+index*10+n));
      for(const room of rooms)await message(service,room,'join '+id,'local-operator');
      if(detected){await message(service,rooms[0],'report blocked OBSERVATION-'+index+': request failures remain; compare the retained request IDs and exact deployed source.','avery');await message(service,rooms[1],'report recovered PROBES-'+index+': only liveness probes are green; business behavior has not been verified.','noor');}
      else await message(service,rooms[0],'report investigating CONTROL-'+index+': routine review only; no threshold alert was detected.','avery');
      await message(service,rooms[2],'work request-traces active WORKER-'+index+': tracing the observed request IDs; no fix has been attempted.','sam');
      await message(service,rooms[1],'work request-traces active PLATFORM-'+index+': also tracing those IDs; ownership needs coordination.','noor');
      await message(service,rooms[0],'theory release-change proposed RELEASE-THEORY-'+index+': compare the recent code change with the affected requests before assigning cause.','avery');
      await message(service,rooms[1],'theory upstream-behavior proposed UPSTREAM-THEORY-'+index+': compare dependency behavior and probe scope before blaming code.','noor');
      cases.push({id:entry.id,incidentId:id,serviceKey:service.key,rooms,detected,reviewKind:detected?'log-threshold-candidate':'explicit-operator-control'});
    }
    await settle();await deliver();
  }catch(error){await r.close();throw error;}
  return{get r(){return r;},config,cases,calls,sent,settle,deliver,message,
    restart:async()=>{if(databasePath===':memory:'&&!databaseFactory)throw Error('Reopen requires a durable dedicated database');await r.close();await open();},
    lateWorkerUpdate:async()=>{const entry=cases[0],service=config.services[0];await message(service,entry.rooms[2],'update LATE-WORKER: the earlier fix was discussion only. No patch or deployment has been executed; ownership of the trace review is still unconfirmed.','sam');await message(service,entry.rooms[1],'I missed the worker update. Has anyone actually implemented a fix, and which work still needs an owner?','noor');await settle();await deliver();},
    packets:async({latest=false}={})=>{const packets=[];for(const entry of cases){const context=await r.store.context(entry.incidentId),input=(latest?latestInputs:inputs).get(entry.serviceKey);if(!input)throw Error('No host assessment input was observed');packets.push({caseId:entry.id,input,plan:await r.casework.createPlan(entry.incidentId),assessment:context.incident.analysis,contacts:await r.casework.contacts(entry.incidentId),collaboration:context.collaboration});}return packets;},
    close:()=>r.close()};
}
