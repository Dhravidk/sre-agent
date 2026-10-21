import { timingSafeEqual } from 'node:crypto';
import { eveChannel } from 'eve/channels/eve';
import type { AuthFn } from 'eve/channels/auth';

const serviceAuth: AuthFn<Request> = (request) => {
  const expected=process.env.EVE_TOKEN;
  const actual=request.headers.get('authorization')?.replace(/^Bearer /,'');
  if(!expected||!actual)return null;
  const a=Buffer.from(actual);const b=Buffer.from(expected);
  if(a.length!==b.length||!timingSafeEqual(a,b))return null;
  return {authenticator:'sre-worker',principalId:'sre-worker',principalType:'service'};
};
export default eveChannel({auth:[serviceAuth]});
