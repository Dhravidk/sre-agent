// Parse bounded CLI NDJSON without exposing init metadata, tool inputs, raw
// diagnostics or thinking blocks. Completed-JSON test executables remain valid.
export function claudeStream(onProgress=()=>{}){
  const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',result,ended=false;
  const accept=line=>{
    if(!line.trim())return;
    const event=JSON.parse(line);
    if(ended)throw Error('Claude CLI returned data after its result');
    if(event.type==='result'){result=event;ended=true;return;}
    if(event.type==='system'&&event.subtype==='init')onProgress({stage:'analyzing',text:''});
    const delta=event.type==='stream_event'&&event.parent_tool_use_id==null&&event.event?.type==='content_block_delta'?event.event.delta:null;
    if(delta?.type==='text_delta'&&typeof delta.text==='string')onProgress({stage:'analyzing',text:delta.text});
  };
  return {
    push(chunk){pending+=decoder.decode(chunk,{stream:true});let n;while((n=pending.indexOf('\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);accept(line);}},
    finish(){pending+=decoder.decode();if(pending.trim())accept(pending);if(!result)throw Error('Claude CLI returned invalid JSON');return result;}
  };
}
