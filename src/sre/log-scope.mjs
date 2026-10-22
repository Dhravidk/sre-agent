import {hash} from './security.mjs';

const dimensions=Object.freeze({environment:['deployment.environment','environment','env'],region:['cloud.region','region'],version:['service.version','release','version','sha']});
const text=x=>typeof x==='string'&&x.length>0&&x.length<=100&&x!=='unknown';
const valid=(field,value)=>text(value)&&(field!=='version'||/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value));
const note='Reported host log-monitor scope organizes source observations. It is not access control, cause, provider completeness or current runtime/health proof. Other and unknown scopes remain retained.';

// Only the host monitor's existing issue-key/hash contract establishes this
// display reference. Ticket prose, responder reports and arbitrary scope hints
// do not choose another incident's investigation scope.
export function incidentLogScope(incident,evidence,now=Date.now()){
 const unknown=reason=>({state:'unknown',reason,interpretation:note}),match=/^log-monitor:([A-Za-z0-9][A-Za-z0-9_-]{0,100}):([a-f0-9]{64})$/.exec(incident?.issue_key||'');
 if(!match)return unknown('No host log-monitor scope is bound to this incident identity.');
 const rows=evidence.filter(row=>row.source==='log-monitor'&&row.kind==='problem'&&row.incident_id===incident?.id);if(!rows.length)return unknown('The host monitor scope is outside this evidence window.');
 const latest=Math.max(...rows.map(r=>Number(r.observed_at))),cohort=rows.filter(r=>Number(r.observed_at)===latest);if(!Number.isSafeInteger(latest)||latest<0||latest>now)return unknown('The host monitor observation time is invalid or future dated.');
 for(const row of cohort){const s=row.content?.scope;if(row.content?.monitorId!==match[1]||!s||!Object.keys(dimensions).every(key=>valid(key,s[key]))||hash({environment:s.environment,region:s.region,version:s.version})!==match[2])return unknown('The latest host monitor scope is malformed or disagrees with the incident identity.');}
 const row=[...cohort].sort((a,b)=>a.id.localeCompare(b.id))[0],scope=row.content.scope;return {state:'reported',environment:scope.environment,region:scope.region,version:scope.version,observedAt:latest,evidenceId:row.id,interpretation:note};
}

export function logScopeRelation(reference,record){
 if(reference?.state!=='reported')return 'unknown';let missing=false,different=false;
 for(const[field,aliases]of Object.entries(dimensions)){
  const values=aliases.filter(key=>record?.[key]!==undefined).map(key=>record[key]);
  if(!values.length||values.some(value=>!valid(field,value))||new Set(values).size>1){missing=true;continue;}
  if(values[0]!==reference[field])different=true;
 }
 // Incomplete or contradictory record metadata cannot exclude a competing
 // failure from this scope merely because another dimension differs.
 return missing?'unknown':different?'different':'matching';
}
