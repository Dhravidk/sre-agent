import { randomUUID } from 'node:crypto';
import { Auction } from './auction/service.mjs';
import { scenarios, publicScenarios } from './scenarios.mjs';
import { Store } from './core/store.mjs';
import { diagnose, reviewDiff, answerQuestion } from './core/engine.mjs';
import { seedPilot, pilotDiff, loadRelease } from '../scripts/seed-pilot.mjs';

export class Lab {
  constructor({ store = new Store(), clock = Date.now } = {}) {
    this.store=store; this.baseClock=clock; this.offset=0; this.clock=()=>this.baseClock()+this.offset;
    this.auction=new Auction({clock:this.clock}); this.manifest=seedPilot(); this.activeRelease='baseline'; this.sequence=0; this.busy=false;
  }
  envelope(type, data={}) { return { id:randomUUID(),source:'lab',tenant:'synthetic',service:'auction-api',environment:'local',at:this.clock(),type,...data }; }
  async initialize() {
    // Runtime state is reconstructed from the last successful deployment after restart.
    const latest=this.store.read().deployments.filter(x=>x.service==='auction-api' && x.status==='success').sort((a,b)=>b.at-a.at)[0];
    if(latest && Object.values(this.manifest.releases).some(x=>x.sha===latest.sha)) {
      this.auction.rules=await loadRelease(latest.sha);
      this.activeRelease=this.auction.rules.policy.release;
    } else this.recordBaseline();
  }
  recordBaseline() {
    this.store.event(this.envelope('deployment',{id:'baseline-'+randomUUID(),at:this.clock()-120000,status:'success',sha:this.manifest.baseline,artifact:'fixture-git:'+this.manifest.baseline,healthy:true,rollbackCompatible:true}));
  }
  snapshot() { return { mode:'offline', model:'scripted rules', cloudCalls:0, activeRelease:this.activeRelease, now:this.clock(), telemetry:this.auction.telemetry(), scenarios:publicScenarios(), repository:this.manifest, ...this.store.read() }; }
  async deploy(id) {
    const scenario=scenarios.find(x=>x.id===id); if(!scenario) throw new Error('Unknown scenario');
    this.offset=0; this.auction.reset();
    this.auction.rules=await loadRelease(this.manifest.releases[id].sha);
    this.activeRelease=id;
    const release=this.manifest.releases[id];
    const diff=pilotDiff(release.sha); const review={...reviewDiff(diff),id:randomUUID(),scenario:id,sha:release.sha,ticket:scenario.ticket,diff,at:this.clock()};
    this.store.update(state=>{ state.reviews.push(review); return state; });
    if(id!=='dependency-outage') this.store.event(this.envelope('deployment',{...release,status:'success',healthy:id==='healthy-release'}));
    else this.auction.creditDown=true;
    return review;
  }
  async traffic() {
    const id=this.activeRelease;
    const lot=this.auction.lots[0];
    if(id==='bid-race') {
      const starting=lot.currentBidCents;
      await Promise.all([
        this.auction.bid(lot.id,starting+30000,'North Dealer',randomUUID(),5),
        this.auction.bid(lot.id,starting+20000,'South Dealer',randomUUID(),40),
      ]);
    } else if(id==='late-bid') {
      this.offset=Math.max(this.offset,lot.endsAt-this.baseClock()+1);
      await this.auction.bid(lot.id,lot.currentBidCents+10000,'North Dealer',randomUUID());
    } else if(id==='catalog-latency' || id==='healthy-release' || id==='baseline') {
      for(let i=0;i<3;i++) await this.auction.catalog();
    } else {
      for(let i=0;i<3;i++) await this.auction.bid(lot.id,lot.currentBidCents+10000,'North Dealer',randomUUID());
    }
    return this.monitor();
  }
  monitor() {
    const metrics=this.auction.telemetry(); const diagnosis=diagnose(metrics);
    if(diagnosis.signal==='UNKNOWN') return { detected:false,metrics };
    const problemId='LOCAL-'+this.activeRelease;
    const event=this.envelope('problem',{source:'dynatrace-fixture',problemId,status:'OPEN',metrics});
    this.store.event(event);
    return {detected:true,problemId,event,metrics};
  }
  async run(id) {
    if(this.busy) throw new Error('Another scenario is running');
    this.busy=true;
    try { const review=await this.deploy(id); const outcome=await this.traffic(); return {review,...outcome}; }
    finally { this.busy=false; }
  }
  async reset() {
    if(this.busy) throw new Error('A scenario is running');
    this.store.reset(); this.offset=0; this.activeRelease='baseline';
    this.auction.rules=await loadRelease(this.manifest.baseline); this.auction.reset(); this.recordBaseline();
    return this.snapshot();
  }
  ask(text) {
    const response=answerQuestion(this.store.read(),text);
    this.store.update(state=>{state.messages.push({id:randomUUID(),at:this.clock(),status:'local',text:'YOU: '+text},{id:randomUUID(),at:this.clock(),status:'local',text:response});return state;});
    return {text:response,mode:'scripted'};
  }
}
