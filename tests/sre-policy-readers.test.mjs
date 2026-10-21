import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GithubConnector,GitlabConnector } from '../src/sre/connectors.mjs';
import { bindPolicyEvidence,comparisonComplete } from '../src/sre/policy-evidence.mjs';
import { auctionPolicyPath,reviewPolicySources } from '../src/sre/policy-catalog.mjs';
import { IncidentWorker } from '../src/sre/worker.mjs';

const baseSha='a'.repeat(40),headSha='b'.repeat(40),targetSha='c'.repeat(40);
const baseline=readFileSync(new URL('../src/auction/rules.mjs',import.meta.url),'utf8');
const faulty=baseline.replace('checkVersion: true','checkVersion: false');
const response=data=>new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
const configuration={repository:'test/auction',base:'https://provider.invalid',project:'17',tokenEnv:'TOKEN'};
const connector=(provider,fetcher)=>new (provider==='github'?GithubConnector:GitlabConnector)(configuration,{env:{TOKEN:'synthetic-token'},fetcher});
const file=(provider,content='policy ☃')=>({type:'file',path:auctionPolicyPath,file_path:auctionPolicyPath,commit_id:headSha,encoding:'base64',content:Buffer.from(content).toString('base64'),size:Buffer.byteLength(content)});

for(const provider of ['github','gitlab']) {
  test(provider+' source reader uses the exact immutable ref, verifies UTF-8 byte count and never follows download links',async()=>{
    const calls=[],data=file(provider);data.content=data.content.slice(0,4)+'\n'+data.content.slice(4);data.download_url='https://untrusted.invalid/executable';
    const client=connector(provider,async(url,options)=>{calls.push(url);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');return response(data);});
    assert.deepEqual(await client.file(auctionPolicyPath,headSha),{path:auctionPolicyPath,sha:headSha,content:'policy ☃',complete:true});
    assert.equal(calls.length,1);assert.equal(new URL(calls[0]).searchParams.get('ref'),headSha);
    assert.ok(decodeURIComponent(calls[0]).includes(auctionPolicyPath));
    await assert.rejects(()=>client.file(auctionPolicyPath,'main'),/Full commit SHA/);
    for(const path of ['../rules.mjs','src/../rules.mjs','/src/rules.mjs','src//rules.mjs','src/rules.mjs?ref=main'])await assert.rejects(()=>client.file(path,headSha),/Invalid repository/);
    assert.equal(calls.length,1);
  });
  test(provider+' source reader rejects oversized, truncated, malformed, noncanonical and non-UTF-8 responses',async()=>{
    for(const mutate of [
      value=>{value.size=65537;},
      value=>{value.size++;},
      value=>{value.encoding='none';},
      value=>{value.content='A=AA';value.size=1;},
      value=>{value.content='Zh==';value.size=1;},
      value=>{value.content='/w==';value.size=1;},
      value=>{value.size=-1;},
      value=>{value.size=1.5;},
      value=>{value.content=' '.repeat(100001);value.size=0;},
      value=>{value.path=value.file_path='other.mjs';},
      value=>{if(provider==='github')value.type='symlink';else value.commit_id=baseSha;},
    ]){const value=file(provider);mutate(value);await assert.rejects(()=>connector(provider,async()=>response(value)).file(auctionPolicyPath,headSha));}
  });
}
test('comparison coverage rejects unknown ancestry, GitHub caps, GitLab timeouts and omitted diffs',()=>{
  const gh={merge_base_commit:{sha:baseSha},files:[{filename:auctionPolicyPath,patch:'+ changed'}]};
  assert.equal(comparisonComplete('github',gh,baseSha,headSha),true);
  for(const data of [{...gh,merge_base_commit:{sha:targetSha}},{...gh,files:Array(300).fill(gh.files[0])},{...gh,files:[{filename:auctionPolicyPath}]}])assert.equal(comparisonComplete('github',data,baseSha,headSha),false);
  const gl={commit:{id:headSha},compare_timeout:false,diffs:[{new_path:auctionPolicyPath,diff:'+ changed',collapsed:false,too_large:false}]};
  assert.equal(comparisonComplete('gitlab',gl,baseSha,headSha),true);
  for(const data of [{...gl,commit:{id:targetSha}},{...gl,compare_timeout:true},{...gl,compare_timeout:undefined},{...gl,diffs:[{diff:'x',collapsed:true}]},{...gl,diffs:[{diff:'x',too_large:true}]},{...gl,diffs:[{}]}])assert.equal(comparisonComplete('gitlab',data,baseSha,headSha),false);
});
test('source enrichment binds both exact SHAs and withholds partial, mutable or mismatched reads',async()=>{
  const calls=[],request={provider:'github',comparisonKind:'deployment',baseSha,headSha,data:{files:[{filename:auctionPolicyPath,patch:'+ changed'}]},complete:true,client:{file:async(path,sha)=>{calls.push([path,sha]);return {path,sha,content:sha===baseSha?baseline:faulty,complete:true};}}};
  const proof=await bindPolicyEvidence(request);
  assert.equal(proof.policySources.complete,true);assert.equal(reviewPolicySources(proof.policySources).findings.length,1);
  assert.deepEqual(calls,[[auctionPolicyPath,baseSha],[auctionPolicyPath,headSha]]);
  for(const override of [
    {complete:false},
    {headSha:'main'},
    {client:{}},
    {client:{file:async(path,sha)=>({path,sha:targetSha,content:baseline,complete:true})}},
    {client:{file:async()=>{throw new Error('Synthetic file-read failure');}}},
  ]){const rejected=await bindPolicyEvidence({...request,...override});assert.equal(rejected.policySources.complete,false);}
  const unchanged=await bindPolicyEvidence({...request,data:{files:[{filename:'src/auction/service.mjs',patch:'+ changed'}]}});
  assert.equal(unchanged.policySources.changed,false);assert.deepEqual(unchanged.unrecognizedPaths,['src/auction/service.mjs']);
});
test('GitHub rejects changed PR head or target branch while collecting native review evidence',async()=>{
  for(const field of ['head','base']) {
    let metadata=0;
    const client=connector('github',async url=>{
      if(url.includes('/files?'))return response([{filename:auctionPolicyPath,patch:'+ changed'}]);
      if(url.endsWith('/pulls/42')){metadata++;return response({head:{sha:metadata===2&&field==='head'?targetSha:headSha},base:{sha:metadata===2&&field==='base'?targetSha:baseSha},changed_files:1});}
      throw new Error('Unexpected request '+url);
    });
    await assert.rejects(()=>client.pull(42,{expectedSha:headSha}),/changed while collecting/);
  }
});
test('GitLab checks event head, changing head/base, explicit file count and diff flags',async()=>{
  const metadata={iid:8,sha:headSha,diff_refs:{head_sha:headSha,base_sha:baseSha,start_sha:baseSha},changes_count:'1'};
  for(const scenario of ['valid','wrong-event-head','moving-head','moving-base','overflow-count','missing-count','collapsed','too-large']) {
    let reads=0;
    const client=connector('gitlab',async url=>{
      if(url.includes('/diffs?'))return response([{new_path:auctionPolicyPath,diff:'+ changed',collapsed:scenario==='collapsed',too_large:scenario==='too-large'}]);
      reads++;const data=structuredClone(metadata);
      if(scenario==='moving-head'&&reads===2)data.diff_refs.head_sha=targetSha;
      if(scenario==='moving-base'&&reads===2)data.diff_refs.base_sha=targetSha;
      if(scenario==='overflow-count')data.changes_count='1000+';
      if(scenario==='missing-count')delete data.changes_count;
      return response(data);
    });
    if(['wrong-event-head','moving-head','moving-base'].includes(scenario))await assert.rejects(()=>client.mergeRequest(8,{expectedSha:scenario==='wrong-event-head'?targetSha:headSha}),/changed/);
    else assert.equal((await client.mergeRequest(8,{expectedSha:headSha})).complete,scenario==='valid');
  }
});
test('worker reviews an immutable merge-base/head pair without attributing target-only changes to the topic branch',async()=>{
  for(const alreadyBad of [false,true]) {
    const calls=[],context={incident:{id:'inc-branch',service_key:'auction',started_at:Date.now()},deployments:[],evidence:[{id:'event',source:'github',kind:'problem',content:{number:42,sha:headSha,baseSha:targetSha}}]};
    const client={
      deployments:async()=>({items:[],complete:true}),
      pull:async(number,{expectedSha})=>{assert.equal(number,42);assert.equal(expectedSha,headSha);return {pull:{head:{sha:headSha},base:{sha:targetSha}},files:[{filename:auctionPolicyPath,patch:'+ changed'}],complete:true};},
      compare:async(base,head)=>{calls.push(['compare',base,head]);return {merge_base_commit:{sha:baseSha},files:[{filename:auctionPolicyPath,patch:'+ changed'}]};},
      file:async(path,sha)=>{calls.push(['file',sha]);return {path,sha,content:sha===baseSha&&!alreadyBad?baseline:faulty,complete:true};},
    };
    const store={clock:()=>Date.now(),coordinationNow:async()=>Date.now(),addEvidence:async(id,source,kind,content)=>context.evidence.push({id:kind,source,kind,content}),ingest:async()=>{},context:async()=>context};
    const worker=new IncidentWorker({store,services:[{key:'auction',environment:'local'}],connectors:new Map([['auction',{github:client}]])});
    await worker.collect(context);
    const proof=context.evidence.find(item=>item.kind==='code_review').content;
    assert.equal(proof.baseSha,baseSha);assert.equal(proof.comparison.requestedBaseSha,targetSha);
    assert.deepEqual(calls.filter(item=>item[0]==='compare'),[['compare',targetSha,headSha],['compare',baseSha,headSha]]);
    assert.deepEqual(calls.filter(item=>item[0]==='file'),[['file',baseSha],['file',headSha]]);
    assert.equal(reviewPolicySources(proof.policySources).findings.length,alreadyBad?0:1);
  }
});
