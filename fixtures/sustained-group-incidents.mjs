import {messyIncidentSuite} from './messy-dynatrace-incidents.mjs';

// Two independently scoped copies of the five decision classes. This expands
// concurrency and source/room isolation, not the number of novel defect types.
export function sustainedGroupSuite({seed=91573,recordsPerService=30000,now=Date.now()}={}){
  const profiles=new Map(),services=[],cases=[],groups=[];
  for(let cohort=0;cohort<2;cohort++){
    const suite=messyIncidentSuite({seed:seed+cohort,recordsPerService,now,namespace:'scope-'+(cohort+1),independentDependencyProbe:true});
    for(const [key,profile]of suite.profiles)profiles.set(key,profile);
    services.push(...suite.services);
    for(const c of suite.cases)cases.push({...c,id:'case-'+String(cases.length+1).padStart(2,'0')});
  }
  for(const [index,c]of cases.entries()){
    const service=services.find(s=>s.key===c.serviceKey),rooms=[];
    for(let n=0;n<(index===0?14:2);n++){
      const group={id:'group-'+String(groups.length).padStart(2,'0'),caseId:c.id,serviceKey:c.serviceKey,name:'Evaluation group '+groups.length};
      groups.push(group);rooms.push({id:group.id,name:group.name});
    }
    service.teams.maxIncidentConversations=32;
    service.teams.conversations.push(...rooms.map(room=>room.id));
    (service.teams.collaborationGroups||=[]).push({key:c.id,name:'Shared evaluation '+c.id,conversations:rooms});
  }
  return {seed,now,profiles,services,cases,groups,hotGroup:groups[0]};
}
