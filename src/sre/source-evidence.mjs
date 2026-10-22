const sha=value=>/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value||'');
const path=value=>typeof value==='string'&&value.length<=512&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&/^[A-Za-z0-9_.-]+$/.test(part));
export const sourceEvidenceLimits=Object.freeze({files:4,fileBytes:1500,diffCharacters:600});

// Collect ordinary application files through the existing immutable reader.
// Execute nothing, and keep failed/omitted reads explicit.
export async function bindSourceEvidence({provider,comparisonKind,baseSha,headSha,data,files,complete,client,signal,priorityReferences=[]}){
  const changed=files||data.files||data.diffs||[],name=f=>f.filename||f.new_path||f.old_path||f.path,priorities=new Map();
  for(const [index,ref]of priorityReferences.entries())if(path(ref.path)&&!priorities.has(ref.path))priorities.set(ref.path,index);
  const changedNames=new Set(changed.map(name)),referenced=[...priorities.keys()].filter(p=>!changedNames.has(p)).slice(0,2).map(p=>({path:p,referenceOnly:true}));
  const selected=[...changed,...referenced].sort((a,b)=>(priorities.get(name(a))??Infinity)-(priorities.get(name(b))??Infinity)).slice(0,sourceEvidenceLimits.files),selectedChanges=selected.filter(f=>!f.referenceOnly);
  const proof={provider,comparisonKind,baseSha,headSha,complete:Boolean(complete),sourceFiles:[],sourceCoverage:{available:changed.length,selected:selected.length,omitted:Math.max(0,changed.length-selectedChanges.length),referencedOutsideComparison:selected.length-selectedChanges.length,errors:[]},comparison:{files:selectedChanges.map(f=>({path:name(f),diff:String(f.patch||f.diff||'').slice(0,sourceEvidenceLimits.diffCharacters)}))}};
  // Keep only the discovered review number, not unbounded provider metadata.
  // The collector uses this identity to follow later heads through casework.
  if(comparisonKind==='review'){
    const number=provider==='github'?data.review?.pull?.number:data.mergeRequest?.iid;
    if(Number.isSafeInteger(number)&&number>0){
      if(provider==='github')proof.comparison.review={pull:{number}};
      else if(provider==='gitlab')proof.comparison.mergeRequest={iid:number};
    }
  }
  if(!sha(baseSha)||!sha(headSha)||!complete||typeof client.file!=='function'){
    proof.sourceCoverage.errors.push('A complete comparison, immutable base/head and source reader are required.');return proof;
  }
  // Sequential bounded reads avoid multiplying provider pressure by file count.
  for(const f of selected){
    if(signal?.aborted)throw signal.reason;
    const name=f.filename||f.new_path||f.old_path||f.path;
    if(!path(name)||f.deleted_file||f.status==='removed'){proof.sourceCoverage.errors.push('Source unavailable for '+String(name).slice(0,100));continue;}
    try{
      const file=await client.file(name,headSha,{signal});
      if(file.path!==name||file.sha!==headSha||file.complete!==true||typeof file.content!=='string')throw Error();
      const lines=file.content.split('\n'),hunk=String(f.patch||f.diff||'').match(/@@ -\d+(?:,\d+)? \+(\d+)/),focus=priorityReferences.find(ref=>ref.path===name&&Number.isSafeInteger(ref.line)&&ref.line>0),start=Math.max(0,Math.min(lines.length-1,Number(focus?.line||hunk?.[1]||1)-16));
      let content='',end=start;
      while(end<lines.length&&Buffer.byteLength(content+lines[end]+'\n')<=sourceEvidenceLimits.fileBytes){content+=lines[end]+'\n';end++;}
      if(!content){proof.sourceCoverage.errors.push('Source line exceeds the excerpt budget: '+name);continue;}
      proof.sourceFiles.push({path:name,sha:headSha,startLine:start+1,content,complete:start===0&&end===lines.length,totalLines:lines.length,changed:!f.referenceOnly});
    }catch{if(signal?.aborted)throw signal.reason;proof.sourceCoverage.errors.push('Immutable source read failed or mismatched: '+name);}
  }
  return proof;
}
