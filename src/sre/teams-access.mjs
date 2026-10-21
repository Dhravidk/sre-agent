// Organization admission expands where responders can talk to the bot. It does
// not expand rollback approval, which still requires an explicit room and user.
export const teamsRoot=id=>String(id||'').split(';messageid=')[0];
export const tenantAdmission=teams=>teams?.admission==='tenant';
export function activityTeamId(activity) {
  return activity.conversation?.conversationType==='channel'&&typeof activity.channelData?.team?.id==='string'?activity.channelData.team.id:null;
}
export function teamsConversationAllowed(teams,id) {
  const root=teamsRoot(id);
  // Adding a bot to a chat between two people uses groupChat capability, but
  // Teams retains that chat's @unq.gbl.spaces ID. It is not a personal bot chat.
  return !!root&&(teams?.conversations?.includes(root)||tenantAdmission(teams)&&/^19:[^\s;]+@(?:thread\.(?:tacv2|v2)|unq\.gbl\.spaces)$/.test(root));
}
export function teamsActivityAllowed(teams,activity) {
  if(!teamsConversationAllowed(teams,activity.conversation?.id))return false;
  if(!tenantAdmission(teams))return true;
  const type=activity.conversation?.conversationType,root=teamsRoot(activity.conversation?.id);
  return type==='channel'&&root.endsWith('@thread.tacv2')&&!!activityTeamId(activity)||type==='groupChat'&&(root.endsWith('@thread.v2')||root.endsWith('@unq.gbl.spaces'));
}
export function validateTeamsAdmission(teams) {
  if(teams.admission!==undefined&&!['allowlist','tenant'].includes(teams.admission))throw Error('teams.admission must be allowlist or tenant');
  if(!Array.isArray(teams.conversations)||teams.conversations.some(id=>typeof id!=='string'||!id||id.length>512))throw Error('teams.conversations must contain conversation IDs');
  if(!tenantAdmission(teams)) {
    if(teams.tenantSharing!==undefined)throw Error('teams.tenantSharing requires tenant admission');
    return;
  }
  if(!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(teams.tenantId||''))throw Error('Tenant admission requires an exact Teams tenant GUID');
  const group=teams.tenantSharing;
  if(!group||!/^[-a-z0-9_]{1,64}$/.test(group.key||'')||typeof group.name!=='string'||!group.name.trim()||group.name.length>80||/[\r\n\0]/.test(group.name))throw Error('Tenant admission requires a named teams.tenantSharing group');
  if(teams.captureResponderUpdates)throw Error('Tenant admission accepts mentions only; background message capture must stay off');
}

export function requireTenantMember(activity,member,tenant) {
  // This object comes from the authenticated Bot Connector member endpoint,
  // never activity text, mentions, or a caller-provided principal.
  if(!activity.from?.aadObjectId||!member||member.aadObjectId!==activity.from.aadObjectId||member.tenantId!==tenant||!['user','owner'].includes(member.userRole))throw Error('An authenticated member of the configured Teams tenant is required');
}
