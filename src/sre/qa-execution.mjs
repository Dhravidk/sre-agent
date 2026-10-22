import {redact} from './security.mjs';

export const qaExecutionDefaults=Object.freeze({timeoutMs:90000,maxInFlight:1});

// Bound the host's wait without claiming that cancellation stopped a filesystem
// action. An adapter that ignores abort retains its reservation until it settles.
export class QaExecution {
  constructor({adapter,timeoutMs=qaExecutionDefaults.timeoutMs,onLate}) {
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>90000)throw Error('Invalid local QA execution timeout');
    Object.assign(this,{adapter,timeoutMs,onLate});this.calls=new Set();this.audits=new Set();this.closed=false;
  }
  state(){return {limit:1,reserved:this.calls.size,unresolved:[...this.calls].filter(call=>call.submitted&&!call.settled).length,timedOut:[...this.calls].filter(call=>call.reason==='timeout'&&!call.settled).length};}
  reserve(){
    if(this.closed||this.calls.size)return null;
    const call={controller:new AbortController(),submitted:false,settled:false,interrupted:false};
    call.finalized=new Promise(resolve=>call.finalize=resolve);this.calls.add(call);return call;
  }
  interrupt(call,reason){if(call.interrupted)return;call.interrupted=true;call.reason=reason;call.controller.abort();}
  async run(call,input,adapter=this.adapter){
    if(this.closed||call.controller.signal.aborted)return {kind:'interrupted',reason:'shutdown'};
    call.submitted=true;
    const execution=Promise.resolve().then(()=>adapter.execute({...input,signal:call.controller.signal})).then(result=>({kind:'result',result}),error=>({kind:'error',error}));
    execution.then(outcome=>{
      call.settled=true;
      const audit=(async()=>{await call.finalized;try{if(call.interrupted&&!this.closed){await this.onLate?.(input.requestId,outcome,{reason:call.reason,timeoutMs:this.timeoutMs});this.auditError=null;}}finally{this.calls.delete(call);}})();
      this.audits.add(audit);audit.then(()=>this.audits.delete(audit),error=>{this.audits.delete(audit);this.auditError=redact(String(error.message||error)).slice(0,1000);});
    });
    let timer,aborted;
    const interrupted=new Promise(resolve=>{aborted=()=>resolve({kind:'interrupted',reason:call.reason||'shutdown'});call.controller.signal.addEventListener('abort',aborted,{once:true});timer=setTimeout(()=>this.interrupt(call,'timeout'),this.timeoutMs);});
    try{const outcome=await Promise.race([execution,interrupted]);return call.interrupted?{kind:'interrupted',reason:call.reason}:outcome;}
    finally{clearTimeout(timer);call.controller.signal.removeEventListener('abort',aborted);}
  }
  finish(call){if(!call)return;call.finalize();if(!call.submitted||call.settled)this.calls.delete(call);}
  async drainSettled(){await new Promise(resolve=>setImmediate(resolve));await Promise.allSettled([...this.audits]);}
  close(){
    if(!this.closePromise){this.closed=true;for(const call of this.calls)this.interrupt(call,'shutdown');this.closePromise=(async()=>{await Promise.allSettled([...this.calls].map(call=>call.finalized));await this.drainSettled();})();}
    return this.closePromise;
  }
}
