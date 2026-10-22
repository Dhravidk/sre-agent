export const sourceDiscoveryLimits=Object.freeze({projects:4,hints:2,records:2000,operations:16,filesPerProbe:2,treePages:2,treePageSize:100});
export const discoveryProject=value=>typeof value==='string'&&value.length<=128&&(/^[1-9]\d*$/.test(value)||/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(value))&&value.split('/').every(part=>part!=='.'&&part!=='..');
export const discoverySha=value=>typeof value==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
export const discoveryTag=value=>typeof value==='string'&&value.length<=128&&/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
export function discoveryConfiguration(service){
 const value=service?.gitlab?.discovery;if(value===undefined)return null;
 if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.enabled!=='boolean'||Object.keys(value).some(key=>!['enabled','projects','hints','allowTags','history'].includes(key))||['allowTags','history'].some(key=>value[key]!==undefined&&typeof value[key]!=='boolean'))throw Error('gitlab.discovery requires an explicit enabled boolean and only projects, hints, allowTags and history');
 if(!value.enabled&&value.projects===undefined&&value.hints===undefined)return null;
 if(!Array.isArray(value.projects)||!value.projects.length||value.projects.length>sourceDiscoveryLimits.projects||value.projects.some(project=>!discoveryProject(project))||new Set(value.projects).size!==value.projects.length)throw Error('Source discovery requires one to four distinct explicitly approved GitLab project selectors');
 const fields=['serviceField','revisionField','pathField','lineField'],hints=value.hints;
 if(!hints||typeof hints!=='object'||Array.isArray(hints)||Object.keys(hints).length!==5||Object.keys(hints).some(key=>![...fields,'serviceValue'].includes(key))||fields.some(key=>typeof hints[key]!=='string'||!/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(hints[key]))||new Set(fields.map(key=>hints[key])).size!==fields.length||typeof hints.serviceValue!=='string'||!hints.serviceValue.trim()||hints.serviceValue.length>200)throw Error('Source discovery requires reviewed distinct flat hint fields and the expected log service value');
 return value.enabled?{projects:[...value.projects],hints:Object.fromEntries(['serviceField','serviceValue','revisionField','pathField','lineField'].map(key=>[key,hints[key]])),allowTags:value.allowTags===true,...(value.history===true?{history:true}:{})}:null;
}
import {hash} from './security.mjs';

export function discoveryScope(service){const configuration=discoveryConfiguration(service);return configuration?{...configuration,scopeKey:hash([service.key,service.tenant,service.environment,service.gitlab.base,[...configuration.projects].sort(),configuration.hints,configuration.allowTags,...(configuration.history?['history-v1']:[])]),environment:service.environment}:null;}
