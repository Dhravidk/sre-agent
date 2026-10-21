import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32,deflateSync } from 'node:zlib';

export function teamsManifest(env) {
  const guid=(value,name)=>{
    if(!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value||''))throw new Error(name+' must be a configured GUID');
    return value;
  };
  const url=name=>{
    const value=new URL(env[name]);
    if(value.protocol!=='https:'||value.username||value.password)throw new Error(name+' must be an HTTPS URL without credentials');
    return value.href;
  };
  const access=env.TEAMS_APP_MESSAGE_ACCESS||'mentions';
  if(!['mentions','all'].includes(access))throw new Error('TEAMS_APP_MESSAGE_ACCESS must be mentions or all');
  const botId=guid(env.CLIENT_ID,'CLIENT_ID');
  const label=(key,fallback,max)=>{const value=env[key]??fallback;if(typeof value!=='string'||!value.trim()||value.length>max||/[\r\n\0]/.test(value))throw new Error(key+' must be nonempty text of at most '+max+' characters');return value;};
  const version=env.TEAMS_APP_VERSION||'0.2.0';if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))throw new Error('TEAMS_APP_VERSION must be a semantic version');
  const scopes=(env.TEAMS_APP_SCOPES||'personal,team,groupChat').split(',').map(x=>x.trim());
  if(new Set(scopes).size!==scopes.length||scopes.some(x=>!['personal','team','groupChat'].includes(x)))throw new Error('Invalid TEAMS_APP_SCOPES');
  const permissions=[];
  if(access==='all'&&scopes.includes('team'))permissions.push({name:'ChannelMessage.Read.Group',type:'Application'});
  if(access==='all'&&scopes.includes('groupChat'))permissions.push({name:'ChatMessage.Read.Chat',type:'Application'});
  return {
    $schema:'https://developer.microsoft.com/json-schemas/teams/v1.21/MicrosoftTeams.schema.json',
    manifestVersion:'1.21',version,id:guid(env.TEAMS_APP_ID||botId,'TEAMS_APP_ID'),
    developer:{name:env.TEAMS_APP_DEVELOPER||'SRE Engineering',websiteUrl:url('TEAMS_APP_WEBSITE_URL'),privacyUrl:url('TEAMS_APP_PRIVACY_URL'),termsOfUseUrl:url('TEAMS_APP_TERMS_URL')},
    name:{short:label('TEAMS_APP_SHORT_NAME','SRE Agent',30),full:label('TEAMS_APP_LONG_NAME','SRE Incident Investigator',100)},
    description:{short:label('TEAMS_APP_SHORT_DESCRIPTION','Investigate incidents together with the SRE agent.',80),full:label('TEAMS_APP_DESCRIPTION','Link an incident to a chat or channel thread, share responder progress, ask investigation questions, and request policy-checked recovery. '+(access==='all'?'With consent, the bot receives unmentioned messages. It stores new text from allowlisted conversations linked to active incidents, with author and time, in the configured incident database. Those reports inform the configured investigation model. Unbound background conversations are discarded. ':'Only direct messages and mentions are processed. Use update to record responder progress. ')+'Earlier history, attachments, edits, and deletions are not synchronized. A model cannot approve recovery; an authorized operator must use the explicit approval command. See the organization privacy policy for retention and model processing.',4000)},
    icons:{outline:'outline.png',color:'color.png'},accentColor:'#16382E',
    bots:[{botId,scopes,isNotificationOnly:false,supportsFiles:false,commandLists:[{scopes,commands:[
      {title:'incidents',description:'List incidents for this conversation’s service'},
      {title:'join',description:'join <incident-id>: link this thread/chat to one incident'},
      {title:'update',description:'update <text>: record an action, result, or observation'},
      {title:'status',description:'Summarize evidence, responder progress, and next checks'},
      {title:'work',description:'work <key> <state> <details>: track ownership and handoffs'},
      {title:'theory',description:'theory <key> <state> <details>: record a reported hypothesis'},
      {title:'sync',description:'Share the current briefing with linked incident conversations'},
      {title:'ack',description:'ack <briefing-number>: acknowledge reading this group’s update'},
      {title:'rollback',description:'rollback <incident-id>: assess and propose an eligible recovery'},
      {title:'approve',description:'Use the exact approval command from an eligible proposal'}
    ]}]}],
    ...(permissions.length?{webApplicationInfo:{id:botId,resource:'api://'+botId},authorization:{permissions:{resourceSpecific:permissions}}}:{}),
    validDomains:[],
  };
}

// Self-contained package assets and ZIP writer; no registry, graphics service, or cloud calls.
function png(size,outline=false) {
  const pixels=Buffer.alloc(size*(size*4+1));
  for(let y=0;y<size;y++)for(let x=0;x<size;x++) {
    const u=x/size,v=y/size;
    const box=u>.14&&u<.86&&v>.18&&v<.73&&(u<.19||u>.81||v<.23||v>.68);
    const tail=u>.23&&u<.38&&v>=.68&&v<.84&&Math.abs(u+v-1.07)<.035;
    const pulse=u>.28&&u<.72&&Math.abs(v-(u<.42?.46:u<.51?.46-(u-.42)*1.5:u<.60?.325+(u-.51)*2:.505-(u-.60)*.4))<.025;
    const color=box||tail||pulse?[255,255,255,255]:outline?[0,0,0,0]:[22,56,46,255];
    pixels.set(color,y*(size*4+1)+1+x*4);
  }
  const chunk=(type,data)=>{const name=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);name.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([name,data])),out.length-4);return out;};
  const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
function zip(files) {
  const parts=[],directory=[];let offset=0;
  for(const [path,data] of files) {
    const name=Buffer.from(path),checksum=crc32(data),local=Buffer.alloc(30),central=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(33,12);local.writeUInt32LE(checksum,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
    central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(33,14);central.writeUInt32LE(checksum,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
    parts.push(local,name,data);directory.push(central,name);offset+=local.length+name.length+data.length;
  }
  const index=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...parts,index,end]);
}
export function packageTeams(env,{directory='.local/teams-app'}={}) {
  const manifest=teamsManifest(env);
  const files=[['manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n')],['color.png',png(192)],['outline.png',png(32,true)]];
  mkdirSync(directory,{recursive:true});for(const [name,data] of files)writeFileSync(resolve(directory,name),data);
  const path=resolve(directory,'sre-teams.zip');writeFileSync(path,zip(files));return {path,manifest};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const demo=process.argv.includes('--demo');
  const env=demo?{CLIENT_ID:'11111111-1111-4111-8111-111111111111',TEAMS_APP_WEBSITE_URL:'https://example.invalid/sre',TEAMS_APP_PRIVACY_URL:'https://example.invalid/privacy',TEAMS_APP_TERMS_URL:'https://example.invalid/terms',TEAMS_APP_MESSAGE_ACCESS:'all'}:process.env;
  const result=packageTeams(env,{directory:demo?'.local/teams-app-demo':'.local/teams-app'});
  console.log((demo?'DEMO ONLY: placeholder IDs and policy URLs. Do not install.\n':'')+result.path+'\n'+(env.TEAMS_APP_MESSAGE_ACCESS==='all'?'Requests message-read consent. Also enable teams.captureResponderUpdates for the service.':'Mention-only package.'));
}
