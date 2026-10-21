import { auctionPolicyPath } from './policy-catalog.mjs';

const fullSha=value=>/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value||'');
const paths=data=>(data.files||data.diffs||[]).map(item=>item.filename||item.new_path||item.old_path);

export function comparisonComplete(provider,data,baseSha,headSha) {
  if(provider==='github')return data?.merge_base_commit?.sha===baseSha&&Array.isArray(data.files)&&data.files.length<300&&data.files.every(item=>typeof item.patch==='string');
  return data?.commit?.id===headSha&&data.compare_timeout===false&&Array.isArray(data.diffs)&&data.diffs.every(item=>!item.too_large&&!item.collapsed&&typeof item.diff==='string');
}

export async function bindPolicyEvidence({provider,comparisonKind,baseSha,headSha,data,files,complete,client,signal}) {
  const changed=files||data.files||data.diffs||[];
  const proof={provider,comparisonKind,baseSha,headSha,complete:Boolean(complete),policySources:{path:auctionPolicyPath,complete:false},comparison:data};
  proof.unrecognizedPaths=paths({files:changed}).filter(path=>path!==auctionPolicyPath);
  if(!fullSha(baseSha)||!fullSha(headSha)){proof.policySources.error='Comparison lacks exact immutable base/head SHAs';return proof;}
  if(!complete){proof.policySources.error='Comparison is incomplete; code attribution is withheld';return proof;}
  if(!paths({files:changed}).includes(auctionPolicyPath)){proof.policySources={path:auctionPolicyPath,complete:true,changed:false};return proof;}
  if(typeof client.file!=='function'){proof.policySources.error='Full immutable source reader is unavailable';return proof;}
  try {
    const [base,head]=await Promise.all([client.file(auctionPolicyPath,baseSha,{signal}),client.file(auctionPolicyPath,headSha,{signal})]);
    if(base.path!==auctionPolicyPath||head.path!==auctionPolicyPath||base.sha!==baseSha||head.sha!==headSha||base.complete!==true||head.complete!==true)throw new Error('Policy source identity/coverage does not match the comparison');
    proof.policySources={path:auctionPolicyPath,complete:true,base:base.content,head:head.content};return proof;
  } catch(cause){proof.complete=false;proof.policySources.error='Policy source read failed: '+cause.message;return proof;}
}
