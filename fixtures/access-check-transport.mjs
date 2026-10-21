import { appendFileSync } from 'node:fs';

// Loaded only by isolated CLI tests. Every request is synthetic and no fallback
// transport exists. Keep credential headers and response bodies out of the log.
const scenario=process.env.SRE_ACCESS_CASE,log=process.env.SRE_ACCESS_CALLS_FILE;
if(!scenario||!log)throw new Error('Access-check fixture supervisor required');
const head='a'.repeat(40),base='b'.repeat(40),ci='c'.repeat(32),sysId='d'.repeat(32),path='src/auction/rules.mjs';
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
globalThis.fetch=async(input,options={})=>{
  const url=new URL(input),method=options.method||'GET';
  appendFileSync(log,JSON.stringify({method,path:url.pathname,activeInventory:Boolean(url.searchParams.get('sysparm_query')?.includes('state!=')||url.searchParams.get('problemSelector')?.includes('open'))})+'\n');
  if(url.origin!=='https://sre-access-fixture.invalid')throw new Error('Foreign fixture request refused');
  if(method!=='GET'&&!(method==='POST'&&url.pathname.endsWith('/query:execute')))throw new Error('Deployment or unrelated mutation refused');
  const now=Date.now(),problem={problemId:'P-ACCESS',status:'OPEN',affectedEntities:[{entityId:{id:'SERVICE-ACCESS'}}],startTime:now-10000,title:'Synthetic test problem'};
  const incident={sys_id:sysId,cmdb_ci:ci,state:'2',sys_created_on:new Date(now-10000).toISOString(),sys_updated_on:new Date(now-1000).toISOString(),number:'INC-ACCESS'};
  if(url.pathname==='/repos/fixture/auction')return reply({id:17,full_name:scenario==='github-wrong-scope'?'unrelated/private':'fixture/auction'});
  if(url.pathname==='/api/v4/projects/17')return reply({id:17,path_with_namespace:'fixture/auction'});
  if(url.pathname.endsWith('/deployments')) {
    if(scenario.endsWith('deployment-denied'))return reply({message:'private-synthetic-provider-detail'},403);
    if(scenario==='github-empty-deployments')return reply([]);
    return reply(url.pathname.startsWith('/repos/')?[{id:7,sha:head,environment:'staging',created_at:new Date(now-10000).toISOString()}]:[{id:7,sha:head,environment:{name:'staging'},status:'success',updated_at:new Date(now-10000).toISOString()}]);
  }
  if(url.pathname.endsWith('/statuses'))return reply([{state:'success',environment:'staging',created_at:new Date(now-1000).toISOString()}]);
  if(url.pathname==='/repos/fixture/auction/pulls/42')return scenario==='github-sibling-cancel'?reply({},401):reply({number:42,changed_files:1,head:{sha:head},base:{sha:base}});
  if(url.pathname==='/repos/fixture/auction/pulls/42/files') {
    if(scenario==='github-sibling-cancel')return new Promise((resolve,reject)=>{
      const abort=()=>{appendFileSync(log,JSON.stringify({event:'aborted',method,path:url.pathname})+'\n');reject(new Error('private-synthetic-abandoned-read'));};
      if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});
    });
    return reply([{filename:path,patch:'+ synthetic change'}]);
  }
  if(url.pathname.endsWith('/check-runs'))return scenario==='github-checks-denied'?reply({},403):scenario==='github-malformed-checks'?reply({total_count:0,check_runs:'invalid'}):reply({total_count:1,check_runs:[{head_sha:head,conclusion:'success'}]});
  if(url.pathname.endsWith('/status'))return reply({sha:scenario==='github-wrong-status-head'?base:head,state:'success'});
  if(url.pathname.includes('/compare/'))return reply({merge_base_commit:{sha:base},files:[{filename:path,patch:'+ synthetic change'}]});
  if(url.pathname.startsWith('/repos/fixture/auction/contents/')) {
    if(scenario==='github-source-denied')return reply({message:'private-synthetic-provider-detail'},403);
    const content='export const accessProbe = true;\n';return reply({type:'file',path,size:Buffer.byteLength(content),encoding:'base64',content:Buffer.from(content).toString('base64')});
  }
  if(url.pathname.endsWith('/pulls')&&url.pathname.includes('/commits/'))return reply([{number:42}]);
  if(url.pathname==='/api/v4/projects/17/merge_requests/42')return reply({iid:42,sha:head,changes_count:'1',diff_refs:scenario==='gitlab-missing-review-refs'?{}:{head_sha:head,base_sha:base,start_sha:base},head_pipeline:{id:9,sha:head,status:'success'}});
  if(url.pathname.endsWith('/diffs'))return reply([{new_path:path,old_path:path,diff:'+ synthetic change'}]);
  if(url.pathname.endsWith('/merge_requests')&&url.pathname.includes('/repository/commits/'))return reply([{iid:42}]);
  if(url.pathname.endsWith('/repository/compare'))return reply({commit:{id:head},compare_timeout:false,diffs:[{new_path:path,diff:'+ synthetic change'}]});
  if(url.pathname.includes('/repository/files/')) {
    const content='export const accessProbe = true;\n';return reply({file_path:path,commit_id:url.searchParams.get('ref'),size:Buffer.byteLength(content),encoding:'base64',content:Buffer.from(content).toString('base64')});
  }
  if(url.pathname==='/api/v2/problems') {
    if(scenario==='dynatrace-partial')return reply({problems:[],warnings:['Synthetic partial result']});
    return reply({problems:[problem]});
  }
  if(url.pathname==='/api/v2/problems/P-ACCESS')return reply(problem);
  if(url.pathname==='/api/v2/metrics/query') {
    const end=Date.parse(url.searchParams.get('to'));return reply({result:[{data:[{timestamps:[end-120000,end-60000,end],values:scenario==='metric-invalid'?[100,null,110]:[100,105,110]}]}]});
  }
  if(url.pathname==='/api/now/table/incident') {
    if(scenario==='servicenow-active-denied'&&url.searchParams.get('sysparm_query')?.includes('state!='))return reply({message:'private-synthetic-provider-detail'},403);
    return reply({result:[incident]});
  }
  if(url.pathname==='/api/now/table/incident/'+sysId)return reply({result:incident});
  if(url.pathname.endsWith('/query:execute'))return reply({state:'SUCCEEDED',result:{records:scenario==='grail-truncated'?Array.from({length:200},()=>({timestamp:new Date(now-1000).toISOString(),content:'Synthetic log'})):[],metadata:{}}});
  if(url.pathname==='/rest/api/3/issue/SA-1')return reply({key:'SA-1',description:'private-synthetic-ticket-body'});
  throw new Error('private-synthetic-unexpected-fixture-operation');
};
