export const routeWaitReason='No installed and authorized Teams conversation';
export const routeWaitDelayMs=claims=>Math.min(300000,15000*2**Math.min(5,Math.max(0,Number(claims)-1)));
export const alertConversationId=teams=>teams.alertConversationId||(teams.conversations.length===1?teams.conversations[0]:null);
