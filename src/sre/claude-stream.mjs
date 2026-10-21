// Parse bounded CLI NDJSON without exposing init metadata, tool inputs, raw
// diagnostics or thinking blocks. Completed-JSON test executables remain valid.
export function claudeStream(onProgress=()=>{}){
  const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',result,ended=false,partialText=false;
  const eventTypes={},known=new Set(['system','assistant','user','stream_event','result']);
  const accept=line=>{
    if(!line.trim())return;
    const event=JSON.parse(line);
    const type=known.has(event?.type)?event.type:'other',entry=eventTypes[type]||{count:0,bytes:0};entry.count++;entry.bytes+=Buffer.byteLength(line);eventTypes[type]=entry;
    if(ended)throw Error('Claude CLI returned data after its result');
    if(event.type==='result'){result=event;ended=true;return;}
    if(event.type==='system'&&event.subtype==='init')onProgress({stage:'analyzing',text:''});
    const delta=event.type==='stream_event'&&event.parent_tool_use_id==null&&event.event?.type==='content_block_delta'?event.event.delta:null;
    if(delta?.type==='text_delta'&&typeof delta.text==='string'){partialText=true;onProgress({stage:'analyzing',text:delta.text});}
    // Normal stream-json emits a complete message for each finished block.
    // Token-level partial events also repeat that completed block; support
    // both formats without duplicating text or exposing thinking/tool inputs.
    if(event.type==='assistant'&&event.parent_tool_use_id==null&&Array.isArray(event.message?.content)){
      const blocks=event.message.content.filter(block=>block.type==='text'&&typeof block.text==='string');
      if(blocks.length&&!partialText)for(const block of blocks)onProgress({stage:'analyzing',text:block.text});
      if(blocks.length)partialText=false;
    }
  };
  return {
    metrics(){return structuredClone(eventTypes);},
    push(chunk){pending+=decoder.decode(chunk,{stream:true});let n;while((n=pending.indexOf('\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);accept(line);}},
    finish(){pending+=decoder.decode();if(pending.trim())accept(pending);if(!result)throw Error('Claude CLI returned invalid JSON');return result;}
  };
}
