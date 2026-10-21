export function fictionalDirectory(now=Date.now()) {
  return {source:'Fictional organization chart and shift roster',observedAt:now,expiresAt:now+86400000,entries:[
    {id:'avery',name:'Avery Chen',team:'Bidding',role:'component-owner',paths:['src/auction'],contact:'avery@example.invalid'},
    {id:'noor',name:'Noor Patel',team:'Platform',role:'on-call',paths:[],contact:'noor@example.invalid',startsAt:now-60000,endsAt:now+8*3600000},
    {id:'sam-owner',name:'Sam Rivera',team:'Auction Engineering',role:'service-owner',paths:[],contact:'auction-engineering@example.invalid'},
    {id:'robin',name:'Robin Blake',team:'Operations',role:'escalation',paths:[],contact:'incident-lead@example.invalid'},
  ]};
}
