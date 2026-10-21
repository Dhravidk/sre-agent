import test from 'node:test';
import assert from 'node:assert/strict';
import { createSreRuntime } from '../src/sre/server.mjs';
import { loadConfig } from '../src/sre/config.mjs';
import { seedDemo } from '../src/sre/demo.mjs';
import { Rollbacks } from '../src/sre/rollback.mjs';
import { GithubConnector, GitlabConnector } from '../src/sre/connectors.mjs';
import { WorkflowApprovalError } from '../src/sre/workflow-contract.mjs';
import { RequestNotSubmittedError } from '../src/sre/submission.mjs';
import { ApiClient } from '../src/sre/http-client.mjs';

async function setup(provider, options={}) {
  const config=loadConfig({SRE_SQLITE_PATH:':memory:'}),service=config.services[0];
  service.rollback.provider=provider;
  const runtime=await createSreRuntime({config,autoStart:false});
  try {
    const {incidentId}=await seedDemo(runtime.store,service);
    await runtime.worker.runOnce();
    const configuration={base:'https://provider.invalid',repository:service.github.repository,project:service.gitlab.project,tokenEnv:'TOKEN',workflow:'rollback.yml',ref:'main',...options.configuration};
    const Connector=provider==='github'?GithubConnector:GitlabConnector;
    const connector=new Connector(configuration,options);
    const executor=new Rollbacks({store:runtime.store,services:[service],mode:'connected',connectors:new Map([[service.key,{
      [provider]:{deployments:async()=>({items:(await runtime.store.context(incidentId)).deployments,complete:true})},
      rollback:connector,
    }]])});
    const principal={verified:true,tenant:service.teams.tenantId,conversationId:service.teams.conversations[0],userId:'local-operator'};
    const approve=async()=>{
      const proposal=await executor.propose(incidentId,principal);
      assert.equal(proposal.eligible,true,proposal.text);
      await executor.approve(proposal.id,proposal.text.split(' ').at(-1),principal);
      return proposal;
    };
    return {runtime,executor,approve,row:async id=>(await runtime.store.db.query('SELECT * FROM sre_rollbacks WHERE id=?',[id]))[0]};
  } catch(error) {await runtime.close();throw error;}
}

const receipt=provider=>new Response(provider==='github'?null:JSON.stringify({id:77,web_url:'https://provider.invalid/pipelines/77'}),{status:provider==='github'?204:201});
const oauth={tokenUrl:'https://identity.invalid/token',clientIdEnv:'CLIENT_ID',clientSecretEnv:'CLIENT_SECRET'};

for(const provider of ['github','gitlab'])test(provider+': token endpoint throttling blocks deployment and recovery needs fresh approval',async()=>{
  let now,limited=true,tokens=0,writes=0;
  const f=await setup(provider,{configuration:{oauth},env:{CLIENT_ID:'synthetic',CLIENT_SECRET:'synthetic-secret'},clock:async()=>now??Date.now(),fetcher:async url=>{
    if(url===oauth.tokenUrl){tokens++;return new Response(JSON.stringify(limited?{error:'synthetic-quota'}:{access_token:'synthetic-token',token_type:'Bearer',expires_in:300}),{status:limited?429:200,headers:{'content-type':'application/json',...(limited?{'retry-after':'60'}:{})}});}
    writes++;return receipt(provider);
  }});
  try {
    const first=await f.approve();await f.executor.executeNext();assert.equal(tokens,1);assert.equal(writes,0);assert.equal((await f.row(first.id)).status,'blocked');
    now=Date.now()+60001;limited=false;assert.equal(await f.executor.executeNext(),false);assert.equal(writes,0);
    const fresh=await f.approve();await f.executor.executeNext();assert.equal(tokens,2);assert.equal(writes,1);assert.equal((await f.row(fresh.id)).status,'dispatched');assert.equal((await f.row(first.id)).status,'blocked');
  } finally {await f.runtime.close();}
});

for(const provider of ['github','gitlab'])test(provider+': missing credentials block before submission and rotating them requires fresh approval',async()=>{
  const env={};let writes=0;
  const f=await setup(provider,{env,fetcher:async()=>{writes++;return receipt(provider);}});
  try {
    const first=await f.approve();await f.executor.executeNext();
    assert.equal(writes,0);assert.equal((await f.row(first.id)).status,'blocked');
    env.TOKEN='synthetic-rotated-token';
    assert.equal(await f.executor.executeNext(),false);assert.equal(writes,0);
    const fresh=await f.approve();assert.notEqual(fresh.id,first.id);
    await f.executor.executeNext();assert.equal(writes,1);
    assert.equal((await f.row(fresh.id)).status,'dispatched');
    assert.equal((await f.row(first.id)).status,'blocked');
  } finally {await f.runtime.close();}
});

for(const provider of ['github','gitlab'])test(provider+': approval expiring during OAuth blocks immediately before deployment submission',async()=>{
  let connectorNow,expiresAt,tokenCalls=0,writes=0;
  const f=await setup(provider,{
    configuration:{oauth},env:{CLIENT_ID:'synthetic-client',CLIENT_SECRET:'synthetic-secret'},clock:()=>connectorNow??Date.now(),
    fetcher:async url=>{
      if(url.startsWith('https://identity.invalid/')) {
        tokenCalls++;connectorNow=expiresAt+1;
        return new Response(JSON.stringify({access_token:'synthetic-token',token_type:'Bearer',expires_in:300}),{status:200,headers:{'content-type':'application/json'}});
      }
      writes++;return receipt(provider);
    },
  });
  try {
    const proposal=await f.approve();expiresAt=proposal.expiresAt;
    await f.executor.executeNext();
    assert.equal(tokenCalls,1);assert.equal(writes,0);
    assert.equal((await f.row(proposal.id)).status,'blocked');
    assert.match((await f.row(proposal.id)).error,/approval.*expired/i);
  } finally {await f.runtime.close();}
});

test('an approval-shaped response stream failure after submission remains unknown',async()=>{
  let writes=0;
  const f=await setup('github',{env:{TOKEN:'synthetic'},fetcher:async()=>{
    writes++;
    return new Response(new ReadableStream({start(controller){controller.error(new WorkflowApprovalError('Untrusted response stream failure'));}}),{status:200});
  }});
  try {
    const proposal=await f.approve();await f.executor.executeNext();
    assert.equal(writes,1);assert.equal((await f.row(proposal.id)).status,'unknown');
    assert.equal(await f.executor.executeNext(),false);assert.equal(writes,1);
  } finally {await f.runtime.close();}
});

for(const provider of ['github','gitlab'])for(const failure of ['missing-oauth-credentials','token-rejected','token-transport','malformed-token','missing-token'])test(provider+': '+failure+' cannot submit a deployment or expose identity-provider text',async()=>{
  let tokenCalls=0,writes=0;
  const sensitive='synthetic-identity-private-detail';
  const f=await setup(provider,{
    configuration:{oauth},env:failure==='missing-oauth-credentials'?{}:{CLIENT_ID:'synthetic-client',CLIENT_SECRET:sensitive},
    fetcher:async url=>{
      if(url.startsWith('https://identity.invalid/')) {
        tokenCalls++;
        if(failure==='token-rejected')return new Response(sensitive,{status:401});
        if(failure==='token-transport')throw new RequestNotSubmittedError(sensitive);
        if(failure==='malformed-token')return new Response(sensitive,{status:200});
        return new Response(JSON.stringify({detail:sensitive}),{status:200});
      }
      writes++;return receipt(provider);
    },
  });
  try {
    const proposal=await f.approve();await f.executor.executeNext();
    assert.equal(tokenCalls,failure==='missing-oauth-credentials'?0:1);
    assert.equal(writes,0);const row=await f.row(proposal.id);
    assert.equal(row.status,'blocked');assert.match(row.error,/not submitted; authentication failed/);
    assert.ok(!row.error.includes(sensitive));
    const notices=await f.runtime.store.db.query('SELECT text FROM sre_outbox');
    assert.ok(!JSON.stringify(notices).includes(sensitive));
    assert.equal(await f.executor.executeNext(),false);assert.equal(writes,0);
  } finally {await f.runtime.close();}
});

for(const provider of ['github','gitlab'])for(const failure of ['transport-local-error','response-local-error','malformed-receipt','http-401','http-429','http-500'])test(provider+': '+failure+' after the submission boundary is quarantined without retry',async()=>{
  let writes=0;
  const f=await setup(provider,{env:{TOKEN:'synthetic'},fetcher:async()=>{
    writes++;
    if(failure==='transport-local-error')throw new RequestNotSubmittedError('Untrusted transport exception');
    if(failure==='response-local-error')return new Response(new ReadableStream({start(controller){controller.error(new RequestNotSubmittedError('Untrusted response exception'));}}),{status:200});
    if(failure==='malformed-receipt')return new Response('Unparseable receipt',{status:200});
    return new Response('{}',{status:Number(failure.slice(5))});
  }});
  try {
    const proposal=await f.approve();await f.executor.executeNext();
    assert.equal(writes,1);assert.equal((await f.row(proposal.id)).status,'unknown');
    assert.equal(await f.executor.executeNext(),false);assert.equal(writes,1);
    const another=await f.approve();await f.executor.executeNext();
    assert.equal((await f.row(another.id)).status,'blocked');assert.equal(writes,1);
  } finally {await f.runtime.close();}
});

test('invalid local request preparation and an already cancelled request never invoke the deployment transport',async()=>{
  let writes=0;
  const client=new ApiClient({base:'https://provider.invalid',fetcher:async()=>{writes++;return new Response(null,{status:204});}});
  const cyclic={};cyclic.self=cyclic;
  for(const [path,options] of [
    ['//untrusted.invalid',{}],['/dispatch',{body:cyclic}],['/dispatch',{signal:AbortSignal.abort(new Error('Already cancelled'))}],
  ])await assert.rejects(()=>client.request(path,{method:'POST',mutating:true,...options}),error=>error instanceof RequestNotSubmittedError);
  assert.equal(writes,0);
  const rejected=new ApiClient({base:'https://provider.invalid',fetcher:async()=>new Response('{}',{status:401})});
  await assert.rejects(()=>rejected.request('/dispatch',{method:'POST',mutating:true}),error=>error.uncertain===true&&error.status===401);
});
