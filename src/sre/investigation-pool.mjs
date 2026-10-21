import {IncidentWorker} from './worker.mjs';

// SQL admits the work, including across independent hosts. This pool only keeps
// available local slots busy; it is never the capacity or incident-scope gate.
export class InvestigationPool {
  constructor(options){
    this.workers=Array.from({length:options.store.investigationConcurrency},()=>new IncidentWorker(options));
    this.active=new Map();this.errors=[];this.closed=false;
  }
  get running(){return this.active.size>0;}
  wake(){
    if(this.closed||this.paused)return;
    for(const worker of this.workers){
      if(this.active.has(worker))continue;
      const call=worker.runOnce().then(done=>{
        this.active.delete(worker);
        // Refill this slot without waiting for another incident's slow model.
        if(done&&!this.closed)this.wake();
        return done;
      },error=>{this.active.delete(worker);if(this.errors.length<this.workers.length)this.errors.push(error);return false;});
      this.active.set(worker,call);
    }
  }
  async runOnce(){
    this.wake();const calls=[...this.active.values()];
    const completed=await Promise.all(calls);
    if(this.errors.length)throw this.errors.shift();
    return completed.some(Boolean);
  }
  async idle(){
    while(this.active.size)await Promise.all([...this.active.values()]);
    if(this.errors.length)throw this.errors.shift();
  }
  pause(){this.paused=true;}
  resume(){this.paused=false;this.wake();}
  stop(){this.closed=true;for(const worker of this.workers)worker.stop();}
  async close(){this.stop();await Promise.all(this.workers.map(worker=>worker.close()));await this.idle();}
}
