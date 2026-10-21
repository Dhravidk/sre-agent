// A detail response and an action belong to one selection generation. A → B → A
// is a new selection, even though the incident ID returns to its earlier value.
export function createIncidentView({load,render,pending=()=>{},onError=()=>{}}) {
  let selected=null,generation=0,sequence=0,ready=false,inFlight;
  const matches=intent=>intent?.incidentId===selected&&intent?.generation===generation;
  const current=request=>matches(request)&&request.sequence===sequence;
  function refresh({fresh=false}={}) {
    if(!selected)return Promise.resolve(false);
    if(inFlight&&!fresh)return inFlight.promise;
    const request={incidentId:selected,generation,sequence:++sequence};
    // Defer load so the in-flight record exists even for a synchronous failure.
    request.promise=Promise.resolve().then(()=>load(request.incidentId)).then(data=>{
      if(!current(request))return false;
      if(data?.incident?.id!==request.incidentId)throw Error('The incident response does not match the selected investigation.');
      ready=true;render(data);return true;
    }).catch(error=>{
      if(current(request)){ready=false;onError(error,request.incidentId);}
      return false;
    }).finally(()=>{if(inFlight===request)inFlight=undefined;});
    inFlight=request;
    return request.promise;
  }
  return {
    select(incidentId) {
      if(incidentId!==selected){selected=incidentId;generation++;ready=false;inFlight=undefined;pending(incidentId);}
      return refresh();
    },
    refresh,
    capture(expectedIncidentId) {
      if(!selected||!ready||expectedIncidentId&&expectedIncidentId!==selected)throw Error('Wait for the selected incident to load and review its context before sending an action.');
      return Object.freeze({incidentId:selected,generation});
    },
    isCurrent:intent=>ready&&matches(intent),
  };
}
