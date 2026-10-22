// These aliases name the same structured log dimension in the current reader
// contracts. Entity names, routes and message text are separate namespaces.
export const logFieldAliases=Object.freeze(Object.fromEntries(Object.entries({
 environment:['deployment.environment','environment','env'],
 region:['cloud.region','region'],
 version:['service.version','release','version','sha'],
 code:['error.code','errorCode','code'],
 level:['loglevel','level','severity'],
}).map(([field,keys])=>[field,Object.freeze(keys)])));

export function logFieldConsistency(record,{emptyIsMissing=false}={}){
 const issues=[],values={};
 for(const[field,keys]of Object.entries(logFieldAliases)){
  const present=keys.filter(key=>Object.hasOwn(record,key)).map(key=>record[key]),max=field==='level'?30:100;
  // Empty classification fields are common on successful requests. They do
  // not contradict each other, but cannot override a nonempty competing alias.
  if(emptyIsMissing&&present.length&&present.every(value=>value==='')){values[field]=[];continue;}
  const text=value=>typeof value==='string'&&value.length>0&&value.length<=max;
  if(present.some(value=>!text(value)))issues.push(field+':type');
  const strings=present.filter(text).map(value=>field==='level'?value.toUpperCase():value);values[field]=strings;
  if(new Set(strings).size>1)issues.push(field+':conflict');
 }
 return {issues,values};
}

export const unverifiedLogFields=context=>Number(context.signalDigest?.coverage?.inconsistentMetadataRecords)>0;
