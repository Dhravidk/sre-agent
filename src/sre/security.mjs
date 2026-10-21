import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function verifyGithub(raw, signature, secret) {
  return Boolean(secret) && equalSecret(signature, 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex'));
}
export function verifySigned(raw, headers, secret, now = Date.now()) {
  const timestamp = Number(headers['x-sre-timestamp']);
  if (!secret || !Number.isFinite(timestamp) || Math.abs(now - timestamp) > 300000) return false;
  return equalSecret(headers['x-sre-signature'], 'sha256=' + createHmac('sha256', secret).update(String(timestamp) + '.').update(raw).digest('hex'));
}
export function redact(value, depth = 0) {
  if (depth > 12) return '[depth limited]';
  if (typeof value === 'string') return value.slice(0, 32000)
    .replace(/\b(Bearer|Api-Token|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(password|secret|access_token|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]');
  if (Array.isArray(value)) return value.slice(0, 500).map(x => redact(x, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, item]) => [key, /^(authorization|cookie|set-cookie|password|secret|token|access_token|refresh_token|api[_-]?key|private[_-]?token)$/i.test(key) ? '[redacted]' : redact(item, depth + 1)]));
  return value;
}
export function assertText(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid ' + name);
  return value;
}
export function safeUrl(base, local = false) {
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid API URL');
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('HTTPS API URL required');
  return url.toString().replace(/\/$/, '');
}

export function evidenceCapability(incidentId, secret, now=Date.now()) {
  const body=Buffer.from(JSON.stringify({incidentId,expiresAt:now+300000})).toString('base64url');
  return body+'.'+createHmac('sha256',secret).update(body).digest('hex');
}
export function readEvidenceCapability(token,secret,now=Date.now()) {
  try {
    const [body,signature,...extra]=String(token).split('.');
    if(extra.length || !equalSecret(signature,createHmac('sha256',secret).update(body).digest('hex')))return null;
    const claims=JSON.parse(Buffer.from(body,'base64url').toString());
    return claims.expiresAt>now && typeof claims.incidentId==='string'?claims:null;
  } catch {return null;}
}
