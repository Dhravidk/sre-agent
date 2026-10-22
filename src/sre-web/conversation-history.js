// Preserve recorded chronology. Reserve the reviewed current snapshot only
// when a backwards timestamp would otherwise put it outside the visible tail.
export function visibleConversation(data){
 const conversation=Array.isArray(data?.conversation)?data.conversation:[],turns=conversation.slice(-12),analysis=data?.incident?.analysis;
 if(data?.assessmentStatus?.state!=='current'||data?.recoveryFence?.active||!analysis||typeof analysis.text!=='string'||typeof analysis.summary!=='string'||typeof analysis.mode!=='string')return {turns,pinnedCurrentId:null};
 const current=conversation.filter(turn=>turn?.role==='assistant'&&turn.matchesCurrentAssessment===true&&Number.isSafeInteger(turn.revision)&&turn.revision===Number(data.incident.revision)&&turn.mode===analysis.mode&&turn.summary===analysis.summary&&turn.text===analysis.text).at(-1);
 if(!current||turns.some(turn=>turn.id===current.id))return {turns,pinnedCurrentId:null};
 return {turns:[...turns.slice(-11),current],pinnedCurrentId:current.id};
}
