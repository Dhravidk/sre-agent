import {hash} from './security.mjs';
import {StorageError} from './database.mjs';

export const contactWindowText=view=>[...(view.source?['Directory source: '+view.source+(view.directoryId?' · '+view.directoryId:'')+'.']:[]),...(Number.isSafeInteger(view.observedAt)?['Directory observed: '+new Date(view.observedAt).toISOString()+'.']:[]),...(Number.isSafeInteger(view.validUntil)?['Contact recommendations valid until '+new Date(view.validUntil).toISOString()+'. Recheck the current directory before contacting an owner.']:[])];
export function contactsText(view){return ['Who to contact (directory evidence, not an automatic page):',...contactWindowText(view),...view.contacts.map(c=>c.name+' · '+c.team+' · '+c.role+' · '+c.contact+' — '+c.reason+'; source '+c.directoryId+(c.role==='on-call'?'; shift '+new Date(c.startsAt).toISOString()+' to '+new Date(c.endsAt).toISOString():'')),...view.unknowns].join('\n');}

export function briefText(value,bytes){
 const text=String(value??'').replace(/[\r\n]+/g,' ');if(Buffer.byteLength(text,'utf8')<=bytes)return text;
 let result='',size=0;for(const character of text){const next=Buffer.byteLength(character,'utf8');if(size+next>bytes-3)break;result+=character;size+=next;}return result+'…';
}
export function contactsBriefText(view){
 const contacts=view.contacts||[],ordered=contacts.map((contact,index)=>({contact,index})).sort((a,b)=>({'on-call':0,'component-owner':1,'service-owner':2,escalation:3}[a.contact.role]??4)-({'on-call':0,'component-owner':1,'service-owner':2,escalation:3}[b.contact.role]??4)||a.index-b.index),selected=ordered.slice(0,3).map(x=>x.contact);
 return ['Who to contact (directory evidence, not an automatic page):','Directory '+briefText(view.directoryId||'unknown',100)+' · '+briefText(view.state||'unknown',40)+(Number.isSafeInteger(view.observedAt)?'; observed '+new Date(view.observedAt).toISOString():'')+(Number.isSafeInteger(view.validUntil)?'; valid until '+new Date(view.validUntil).toISOString():'')+'.',
  ...selected.map(c=>briefText(c.name,80)+' · '+briefText(c.team,80)+' · '+briefText(c.role,40)+' · '+briefText(c.contact,120)+' — '+briefText(c.reason,140)+(c.role==='on-call'?'; shift ends '+new Date(c.endsAt).toISOString():'')),
  ...(view.unknowns||[]).slice(0,3).map(text=>'Unknown: '+briefText(text,160)),
  'Showing '+selected.length+'/'+contacts.length+' contacts and '+Math.min(3,(view.unknowns||[]).length)+'/'+(view.unknowns||[]).length+' ownership unknowns. Excerpts only; use contacts or the console for full current ownership evidence. Recheck before contacting anyone.'].join('\n');
}
export function contactMessageText(view,format='full'){if(!['full','brief'].includes(format))throw new Error('Unknown contact rendering format');return format==='brief'?contactsBriefText(view):contactsText(view);}

// Review-in-progress wording alone should not send another ownership notice.
export const contactNoticeVersion=view=>hash([view.state,view.source,(view.contacts||[]).map(c=>[c.id,c.name,c.team,c.role,c.contact,[...(c.paths||[])].sort(),c.startsAt,c.endsAt]).sort((a,b)=>a[0].localeCompare(b[0])),[...(view.unknowns||[])].sort()]);
export const boundTeamsText=text=>Buffer.byteLength(text,'utf8')>14000?Array.from(text).slice(0,3200).join('')+'\n[Message shortened. The full assessment is saved in the incident console.]':text;

export async function recordContactMessage(q,id,incidentId,text,contacts,now,format='full'){
 const sectionText=contactMessageText(contacts,format),sectionStart=text.lastIndexOf(sectionText);
 // A retained analysis can have contact data while its new reply contains no
 // contact section. Only the exact host-rendered section is managed here.
 if(sectionStart<0)return;
 if(!incidentId||!/^[a-f0-9]{64}$/.test(contacts.version||''))throw Error('Generated contacts need a matching incident and version');
 const [row]=await q('SELECT text FROM sre_outbox WHERE id=?',[id]);
 if(row?.text!==text)return; // Reusing an id never rewrites its earlier body/provenance.
 const value={version:1,incidentId,originalHash:hash(text),sectionStart,sectionText,contacts,format};
 await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?) ON CONFLICT DO NOTHING',['outbox-contact:'+id,JSON.stringify(value),now]);
}

export async function readContactMessage(q,message){
 const [row]=await q('SELECT value FROM sre_checkpoints WHERE id=?',['outbox-contact:'+message.id]);
 if(!row)return null;
 try{
  const value=JSON.parse(row.value);
  if(value.version!==1||value.incidentId!==message.incident_id||value.originalHash!==hash(message.text)||!Number.isSafeInteger(value.sectionStart)||value.sectionStart<0||typeof value.sectionText!=='string'||value.sectionText!==contactMessageText(value.contacts,value.format??'full')||message.text.slice(value.sectionStart,value.sectionStart+value.sectionText.length)!==value.sectionText||!/^[a-f0-9]{64}$/.test(value.contacts.version))throw Error();
  return value;
 }catch{throw new StorageError(Error('Invalid generated contact-message provenance'));}
}
