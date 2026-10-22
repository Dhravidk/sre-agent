import {hash} from './security.mjs';

const citationFields=new Set(['evidenceId','evidenceIds','contraryEvidenceIds','corroboratingEvidenceIds','statusEvidenceId','releaseEvidenceId','handoffEvidenceId']);
const identityFields=new Set(['path','sha','provider','roomKey','kind','targetSha','candidateSha','changeAssessment','confidence','likelihood']);

// Invocation-local short references reduce repeated schema/output tokens. The
// host retains the inverse binding; source bytes and immutable identities do
// not change. An alias from another snapshot cannot select an incident record.
export function citationTransport(snapshot){
  const prefix='ref_'+hash(snapshot).slice(0,12)+'_',forward=new Map(),reverse=new Map();
  for(const [n,row]of snapshot.evidence.entries()){
    if(typeof row.id!=='string'||forward.has(row.id))throw Error('Model evidence identities must be unique');
    const alias=prefix+(n+1);forward.set(row.id,alias);reverse.set(alias,row.id);
  }
  const wire=structuredClone(snapshot),encode=id=>forward.get(id)??id;
  function metadata(value){
    if(!value||typeof value!=='object')return;
    for(const [key,item]of Object.entries(value)){
      if(citationFields.has(key))value[key]=Array.isArray(item)?item.map(encode):encode(item);
      else metadata(item);
    }
  }
  for(const [key,value]of Object.entries(wire))if(!['evidence','logTriageBatches'].includes(key))metadata(value);
  for(const row of wire.evidence){
    row.id=encode(row.id);
    if(row.source==='dynatrace'&&row.kind==='log_triage'&&typeof row.content?.derivedFrom==='string')row.content.derivedFrom=encode(row.content.derivedFrom);
  }
  for(const batch of Object.values(wire.logTriageBatches||{}))batch.derivedFrom=encode(batch.derivedFrom);
  const decode=id=>{if(!reverse.has(id))throw Error('Investigation cited evidence outside this incident');return reverse.get(id);};
  const pattern=new RegExp('\\b'+prefix+'[1-9]\\d*\\b','g');
  function restore(value,key=''){
    if(citationFields.has(key))return Array.isArray(value)?value.map(decode):decode(value);
    if(typeof value==='string')return identityFields.has(key)?value:value.replace(pattern,alias=>reverse.get(alias)??alias);
    if(Array.isArray(value))return value.map(item=>restore(item));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,restore(v,k)]));
    return value;
  }
  return {wire,restore,bindings:Object.fromEntries(reverse)};
}

export function investigationInvocationInput(snapshot,{question,requests}={}){
  const transport=citationTransport(snapshot),input=JSON.stringify({...(requests?{requestBatch:requests}:{}),request:question||'Investigate this incident and explain impact, hypotheses, missing evidence and safe recovery options.',incident:transport.wire});
  return {...transport,input};
}
