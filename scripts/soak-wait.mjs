import {setTimeout as delay} from 'node:timers/promises';

// A suspended supervisor cannot observe the child or measure its recovery SLA.
// Give the resumed child one bounded observation window, retaining the gap so
// the caller cannot count this run as uninterrupted uptime.
export async function waitForObservation(label,read,{timeout=30000,interval=500,maxGapMs=10000,clock=Date.now,sleep=delay,onGap=()=>{},onStart=()=>{},alive=()=>true,stopping=()=>false}={}) {
  let previous=clock(),deadline=previous+timeout,last,resumes=0;
  onStart();
  const interrupted=(from,to)=>{
    onGap({label,from,to,gapMs:to-from});
    if(++resumes>1)throw new Error(label+' observation was interrupted repeatedly');
    deadline=to+timeout;
  };
  for(;;) {
    const now=clock(),gap=now-previous;
    if(gap>maxGapMs)interrupted(previous,now);
    if(stopping())throw Object.assign(new Error('Soak interrupted by stop request'),{interrupted:true});
    if(!alive())throw new Error('Child terminated while waiting for '+label);
    let value;try{value=await read();}catch(error){last=error;}
    const after=clock();if(after-now>maxGapMs)interrupted(now,after);
    if(value)return value;
    if(after>=deadline)throw new Error(label+' was not observed before its deadline'+(last?': '+last.message:''));
    previous=after;await sleep(interval);
  }
}
