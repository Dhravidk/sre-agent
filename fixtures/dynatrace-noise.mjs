// Authored telemetry for evaluation only. Expected answers are never passed to
// Claude. Optional source is a separately retrieved immutable GitLab snapshot.
import {riskScope} from '../src/sre/analytic-risk.mjs';

export function noisyLogCase({usefulPercent=1,count=10000,variant='regression',structuredHints=true,source:provided,now=Date.now()}={}){
  if(![1,5,10].includes(usefulPercent)||!Number.isSafeInteger(count)||count<1000||count>100000||!['regression','incompatible','dependency'].includes(variant))throw Error('Invalid noisy-log evaluation case');
  const head=provided?.headSha||'d'.repeat(40),base=provided?.baseSha||'e'.repeat(40),path=provided?.sourceFiles?.find(f=>f.content.includes('amountCents * 100'))?.path||'services/bidding/amount-ledger.mjs';
  const source=provided?structuredClone(provided):{provider:'gitlab',comparisonKind:'deployment',baseSha:base,headSha:head,complete:true,comparison:{files:[{path,diff:'@@ -1,4 +1,4 @@\n export function applyBid(lot, amountCents) {\n-  lot.currentBidCents = amountCents;\n+  lot.currentBidCents = amountCents * 100;\n   lot.bids.push({amountCents});\n }'}]},sourceFiles:[{path,sha:head,startLine:1,complete:true,totalLines:4,content:'export function applyBid(lot, amountCents) {\n  lot.currentBidCents = amountCents * 100;\n  lot.bids.push({amountCents});\n}\n'}]};
  if(variant==='dependency'){
    if(provided)throw Error('The dependency control uses authored corrected source, not a modified external snapshot');
    source.sourceFiles[0].content=source.sourceFiles[0].content.replace('amountCents * 100','amountCents');
    source.comparison.files[0].diff='@@ -1 +1 @@\n-// bid ledger\n+// bid ledger documentation';
  }
  const file=source.sourceFiles.find(f=>f.path===path),line=file.startLine+Math.max(0,file.content.split('\n').findIndex(s=>s.includes('amountCents * 100')));
  const useful=Math.round(count*usefulPercent/100),records=[];
  for(let n=0;n<count-useful;n++){
    const noisy=n%20===0,at=now-40000+n%20000,trace='trace-noise-'+String(n).padStart(8,'0');
    records.push({timestamp:new Date(at).toISOString(),'service.name':'bid-ledger','deployment.environment':'evaluation','cloud.region':n%2?'eu':'us','service.version':head,loglevel:noisy?'ERROR':n%17===0?'WARN':'INFO','error.code':noisy?'EXPECTED_TEST_REJECTION':undefined,'http.response.status_code':noisy?409:200,'http.route':noisy?'/validation-probe':'/health',content:(noisy?'Synthetic negative validation probe rejected as expected.':'Routine health request completed.')+' trace='+trace,'trace.id':trace});
  }
  // The useful observations are all beyond the old first-2,000-record window.
  for(let n=0;n<useful;n++){
    const older=n%5===0,trace='trace-business-'+String(n).padStart(8,'0'),at=older?now-200000+n:now-15000+n;
    const common={timestamp:new Date(at).toISOString(),'service.name':'bid-ledger','deployment.environment':'evaluation','cloud.region':n%2?'eu':'us','service.version':older?base:head,'http.route':'/bids','trace.id':trace,'request.id':'request-'+String(n).padStart(8,'0')};
    if(variant==='dependency')records.push({...common,loglevel:'ERROR','error.code':'CREDIT_PROVIDER_UNAVAILABLE','http.response.status_code':503,content:'Credit-provider returned HTTP 503 before any lot mutation on this request. trace='+trace,stack:'at creditClient.request (services/credit/client.mjs:27)'});
    else records.push({...common,loglevel:'INFO','error.code':older?undefined:'AMOUNT_INVARIANT_MISMATCH','http.response.status_code':201,content:'Accepted bid inputAmountCents=150000; storedCurrentBidCents='+(older?'150000':'15000000')+'; bidHistoryAmountCents=150000; trace='+trace,...(older?{}:{'code.filepath':path,stack:'at applyBid ('+path+':'+line+')'})});
  }
  if(!structuredHints)for(const record of records)if(record['http.route']==='/bids'){delete record['error.code'];delete record['code.filepath'];delete record.stack;}
  const row=(id,source,kind,content)=>({id,source,kind,observed_at:now,content});
  const evidence=[
    row('dt-noise','dynatrace','logs',{synthetic:true,complete:true,records,coverage:{syntheticPopulation:count,from:now-900000,to:now,queryAcceptance:'Not queried from Dynatrace; authored log population.'}}),
    row('dt-problem','dynatrace','problem',{synthetic:true,problemId:'evaluation-'+variant,status:'OPEN',title:variant==='dependency'?'Bid requests fail with upstream 503':'Accepted bids have inconsistent monetary amounts',environment:'evaluation',at:now-60000}),
    row('jira-amounts','jira','ticket',{synthetic:true,key:'BID-219',fields:{summary:'Preserve bid amounts in cents',description:'API amountCents, stored currentBidCents and bid history amountCents are all integers in cents and must agree for an accepted bid. Expected validation-probe 409s are not customer failures. Verify concurrent bids and closed lots independently.'}}),
    row('confluence-units','confluence','documentation',{synthetic:true,id:'bid-amount-contract',version:4,title:'Bid ledger money and recovery contract',body:{storage:{value:'<p>The API, lot state and bid history use cents. Conversion to display currency happens only in presentation. HTTP 201 alone does not prove business correctness.</p><p>Replacing a binary does not repair persisted amounts. Identify affected rows, review idempotent data repair, and verify old and new releases against an independent business invariant. The credit provider is a separate dependency; check both releases.</p>'}}}),
    row('gitlab-amounts','gitlab','release_diff',{...source,synthetic:!provided,sourceScope:provided?'Actual read-only GitLab fictional sandbox source; deployment and telemetry in this case are authored.':'Authored immutable source for evaluation.'})
  ];
  const common={provider:'gitlab',project:'evaluation-project',environment:'evaluation',schemaVersion:1,dependencyFingerprint:'credit-v1',configurationFingerprint:'config-1',featureFlagsFingerprint:'flags-1'};
  const deployments=[{...common,sha:head,at:now-120000,artifact:'sha256:'+'1'.repeat(64),rollbackCompatible:variant!=='incompatible',dataRollbackSafe:variant!=='incompatible',schemaVersion:variant==='incompatible'?2:1},{...common,sha:base,at:now-360000,artifact:'sha256:'+'2'.repeat(64),healthy:true,healthVerifiedAt:now-180000}];
  const context={incident:{id:'inc_1234567890abcdef9876',service_key:'dynatrace-development',issue_key:'noise:'+variant+':'+usefulPercent,title:'Fictional noisy telemetry: '+variant,status:'open',revision:1,started_at:now-60000,updated_at:now,analysis:null},session:{agent_id:'dynatrace-evaluation'},evidence,deployments,assessmentHistory:[],collaboration:{enabled:false,rooms:[],issues:[]}};
  context.riskScope=riskScope(context,{environment:'evaluation',rollback:{provider:'gitlab'}},now);
  return {context,raw:evidence[0].content,expected:{path:variant==='dependency'?null:path,line,head,base,useful,count,variant,usefulPercent,structuredHints}};
}
