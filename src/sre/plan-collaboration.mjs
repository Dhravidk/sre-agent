import {redact} from './security.mjs';

export const planCollaborationLimits=Object.freeze({jsonBytes:48000,markdownBytes:32000,rooms:8,issues:24,issueBytes:8000,reports:6,stateReports:8,work:8,theories:8,initialExcerpt:120,excerpt:260});
const list=value=>Array.isArray(value)?value:[];
const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const short=(value,limit)=>{const chars=Array.from(redact(String(value??'')).replace(/\s+/gu,' ').trim());return chars.length>limit?chars.slice(0,limit).join('')+'…':chars.join('');};
const md=value=>String(value??'').replace(/[\\`*_{}\[\]<>|#]/g,'\\$&');
const time=value=>Number.isSafeInteger(value)&&value>=0?new Date(value).toISOString():'unknown source time';
const interpretation='Participant statements are unverified reports, not agreement, task completion, cause, QA approval or recovery proof. Excerpts and retained evidence IDs do not import earlier chat history.';
const kinds=['reports','stateReports','work','theories'];

function entry(source,kind,limit){
 const result={evidenceId:source.evidenceId,at:source.at,author:short(source.author,60),text:short(source.text,limit),verified:false};
 for(const key of ['participantKey','state','key','currentForAuthor','stale'])if(source[key]!==undefined)result[key]=source[key];
 if(kind==='work'||kind==='theories')result.kind=kind==='work'?'work':'theory';
 return result;
}

// This is a ticket projection of already scoped SQL collaboration windows.
// It cannot supply missing source history, action authority or new recipients.
export function planCollaborationSnapshot(original){
 const sources=list(original?.rooms).slice(0,planCollaborationLimits.rooms);
 const rooms=sources.map(room=>({key:room.key,name:short(room.name,80),reportedStatus:room.reportedStatus??null,statusCurrentForAuthor:room.statusCurrentForAuthor??null,statusStale:room.statusStale===true,stateReports:[],reports:[],work:[],theories:[],reportAuthorsAvailable:Math.max(count(room.reportAuthorsAvailable),list(room.reports).length+count(room.omittedReportAuthors)),omittedReportAuthors:0,omittedStateReports:0,omittedItems:0}));
 const value={version:1,quotePolicy:'one excerpt per source in each conversation',rooms,issues:[],nextStep:short(original?.nextStep,320),interpretation,coverage:{selection:'retained authorized conversation windows',completeHistory:false,roomsAvailable:list(original?.rooms).length,roomsOmitted:Math.max(0,list(original?.rooms).length-rooms.length),issuesAvailable:list(original?.issues).length,issuesOmitted:0,omittedReports:0,omittedStateReports:0,omittedItems:0,textIsExcerpt:true}};
 const coverage=()=>{
  for(const [i,room]of rooms.entries()){
   const source=sources[i];room.omittedReportAuthors=count(source.omittedReportAuthors)+list(source.reports).length-room.reports.length;
   room.omittedStateReports=count(source.omittedStateReports)+list(source.stateReports).length-room.stateReports.length;
   room.omittedItems=count(source.omittedItems)+list(source.work).length+list(source.theories).length-room.work.length-room.theories.length;
  }
  value.coverage.issuesOmitted=value.coverage.issuesAvailable-value.issues.length;
  value.coverage.omittedReports=rooms.reduce((n,r)=>n+r.omittedReportAuthors,0);
  value.coverage.omittedStateReports=rooms.reduce((n,r)=>n+r.omittedStateReports,0);
  value.coverage.omittedItems=rooms.reduce((n,r)=>n+r.omittedItems,0);
 };
 const within=()=>{coverage();return bytes(value)<=planCollaborationLimits.jsonBytes&&Buffer.byteLength(planCollaborationMarkdown(value).join('\n'),'utf8')<=planCollaborationLimits.markdownBytes;};
 // Reserve one warning of each kind before repeated task-specific warnings.
 const ranks=new Map(),issues=list(original?.issues).map((issue,index)=>{const rank=ranks.get(issue.code)||0;ranks.set(issue.code,rank+1);return{issue,index,rank};}).sort((a,b)=>a.rank-b.rank||a.index-b.index);
 for(const {issue}of issues){
  if(value.issues.length>=planCollaborationLimits.issues)break;
  const candidate={code:short(issue.code,64),text:short(issue.text,240)};
  for(const key of ['roomKey','itemKey','generation','delivery'])if(issue[key]!==undefined)candidate[key]=issue[key];
  value.issues.push(candidate);if(bytes(value.issues)>planCollaborationLimits.issueBytes||!within())value.issues.pop();
 }
 // Round-robin room/category lanes protect a quiet conversation before more
 // detail or a second entry from a busy room. Enlarge retained excerpts last.
 const retained=[];
 for(let rank=0;rank<8;rank++)for(const kind of kinds)for(const [i,room]of rooms.entries()){
  const source=list(sources[i][kind])[rank];if(!source||rank>=planCollaborationLimits[kind])continue;
  const candidate=entry(source,kind,planCollaborationLimits.initialExcerpt);room[kind].push(candidate);
  if(within())retained.push({source,kind,room,candidate});else room[kind].pop();
 }
 for(const {source,kind,room,candidate}of retained){
  const index=room[kind].indexOf(candidate),expanded=entry(source,kind,planCollaborationLimits.excerpt);room[kind][index]=expanded;
  if(!within())room[kind][index]=candidate;
 }
 coverage();return value;
}

export function planCollaborationMarkdown(view){
 const lines=[view.interpretation];
 if(view.nextStep)lines.push('Coordination next step: '+md(view.nextStep));
 for(const issue of view.issues)lines.push('- Coordination check ['+md(issue.code)+']: '+md(issue.text));
 for(const room of view.rooms){
  const categorized=new Set([...room.stateReports,...room.work,...room.theories].map(item=>item.evidenceId));
  lines.push('- '+md(room.name)+': '+md(room.reportedStatus||'no state report')+'.'+(room.statusCurrentForAuthor===false?' Historical claim; responder updated elsewhere.':'')+(room.statusStale?' Latest state claim is old.':'')+' Conversation reference `'+md(room.key)+'`.');
  for(const report of room.stateReports)lines.push('- State claim in '+md(room.name)+': '+md(report.author)+' reports '+md(report.state)+' at '+time(report.at)+'; unverified'+(report.currentForAuthor===false?'; historical claim, responder updated elsewhere':'')+(report.stale?', old report':'')+'; evidence `'+md(report.evidenceId)+'`; excerpt: “'+md(report.text)+'”.');
  for(const report of room.reports.filter(report=>!categorized.has(report.evidenceId)))lines.push('- Report in '+md(room.name)+': '+md(report.author)+' at '+time(report.at)+'; unverified; evidence `'+md(report.evidenceId)+'`; excerpt: “'+md(report.text)+'”.');
  for(const kind of ['work','theories'])for(const item of room[kind])lines.push('- '+(kind==='work'?'Work':'Theory')+' claim in '+md(room.name)+': '+md(item.key)+' '+md(item.state)+' by '+md(item.author)+' at '+time(item.at)+'; unverified'+(item.currentForAuthor===false?'; historical claim, responder updated elsewhere':'')+(item.stale?'; old report':'')+'; evidence `'+md(item.evidenceId)+'`; excerpt: “'+md(item.text)+'”.');
  lines.push('- Coverage in '+md(room.name)+': '+room.reports.length+'/'+(room.reports.length+room.omittedReportAuthors)+' latest participant reports, '+room.stateReports.length+'/'+(room.stateReports.length+room.omittedStateReports)+' participant state claims and '+(room.work.length+room.theories.length)+'/'+(room.work.length+room.theories.length+room.omittedItems)+' work/theory window items shown. Further history may exist.');
 }
 const c=view.coverage;lines.push('Collaboration coverage: '+view.rooms.length+'/'+c.roomsAvailable+' conversations and '+view.issues.length+'/'+c.issuesAvailable+' coordination warnings shown. '+c.omittedReports+' participant reports, '+c.omittedStateReports+' state claims and '+c.omittedItems+' ledger items are outside these displayed conversation windows. Sources shared by several categories are quoted once. Excerpts may shorten source text. Request missing evidence; silence is not agreement or recovery.');
 return lines;
}
