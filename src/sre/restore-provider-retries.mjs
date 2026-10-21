import { assertText,hash,redact } from './security.mjs';
import { StorageError } from './database.mjs';
import { configuredRetryDescriptor,providerRetryGate } from './provider-retry.mjs';

const conflict=message=>Object.assign(new Error(message),{status:409});
const stableId=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9._:-]{1,160}$/.test(value))throw new Error('A stable restore/request ID is required');};
const record=(value,fields)=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!fields.includes(key)))throw new Error('Unexpected provider retry recovery fields');
};
const epoch=value=>Number.isSafeInteger(value)&&value>=0;
function evidenceLinks(values) {
  if(!Array.isArray(values)||!values.length||values.length>10)throw new Error('Link the independently retained provider evidence');
  return values.map(value=>{
    assertText(value,'provider evidence URL',4000);
    try {const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password)throw new Error();}
    catch {throw new Error('Provider evidence requires HTTPS URLs without embedded credentials');}
    return value;
  });
}

// A local operator reviews independent facts. This never invents missing waits,
// authenticates provider records, clears an action fence or shortens a deadline.
export async function restoreProviderRetries(store,services,input) {
  record(input,['restoreId','requestId','reason','reviewedAt','evidenceUrls','facts','actor']);
  const {restoreId,requestId,reviewedAt,actor}=input;stableId(restoreId);stableId(requestId);
  assertText(input.reason,'provider retry recovery reason',1000);
  if(actor?.kind!=='local-operator')throw new Error('Provider retry recovery requires a local operator');
  const operator=assertText(actor.id,'local operator identity',512),evidenceUrls=evidenceLinks(input.evidenceUrls);
  if(!epoch(reviewedAt))throw new Error('Provider retry review time must be epoch milliseconds');
  if(!Array.isArray(input.facts)||!input.facts.length||input.facts.length>50)throw new Error('Provide between one and fifty reviewed provider retry facts');
  const buckets=new Set(),facts=input.facts.map(fact=>{
    record(fact,['serviceKey','connector','kind','scopeHash','observedAt','until','status']);
    if(!['api','oauth'].includes(fact.kind))throw new Error('Provider retry fact kind must be api or oauth');
    assertText(fact.serviceKey,'retry service key',200);
    const service=services.find(item=>item.key===fact.serviceKey);if(!service)throw new Error('Provider retry fact is outside the selected service configuration');
    const gate=providerRetryGate(store,configuredRetryDescriptor(service,fact.connector,fact.kind,{allowDisabled:true}));
    if(!gate||fact.scopeHash!==gate.scopeHash)throw new Error('Provider retry fact does not match the configured shared bucket');
    if(buckets.has(gate.scopeHash))throw new Error('Consolidate duplicate bucket facts before review');buckets.add(gate.scopeHash);
    if(!epoch(fact.observedAt)||fact.observedAt>reviewedAt||!epoch(fact.until)||fact.until<=fact.observedAt||!Number.isInteger(fact.status)||fact.status<100||fact.status>599)throw new Error('Invalid observed provider retry deadline/status');
    return {serviceKey:fact.serviceKey,connector:fact.connector,kind:fact.kind,scopeHash:gate.scopeHash,observedAt:fact.observedAt,until:fact.until,status:fact.status};
  });
  const body={restoreId,requestId,reason:redact(input.reason.trim()),operator,reviewedAt,evidenceUrls,facts};
  const bodyHash=hash({...body,originalReasonHash:hash(input.reason)}),receiptKey='recovery:database-restore:provider-retries:'+hash([restoreId,requestId]);
  return store.db.transaction(async q=>{
    const fence=await store.restoreFence(q,{lock:true});
    if(!fence||fence.restoreId!==restoreId)throw conflict('Provider retry facts require the matching prepared database restore');
    const [prior]=await q('SELECT value FROM sre_checkpoints WHERE id=?',[receiptKey]);
    if(prior) {
      let receipt;try{
        receipt=JSON.parse(prior.value);record(receipt,['version',...Object.keys(body),'bodyHash','appliedAt','authority','providerVerified','effective']);
        if(receipt.version!==1||receipt.restoreId!==restoreId||receipt.requestId!==requestId||receipt.authority!=='local_operator_attestation'||receipt.providerVerified!==false||!/^[a-f0-9]{64}$/.test(receipt.bodyHash))throw new Error();
      }
      catch{throw new StorageError(new Error('Invalid provider retry recovery receipt'));}
      if(receipt.bodyHash!==bodyHash)throw conflict('Provider retry request ID was reused with different facts or configuration');
      if(JSON.stringify(Object.fromEntries(Object.keys(body).map(key=>[key,receipt[key]])))!==JSON.stringify(body)||!epoch(receipt.appliedAt)||!Array.isArray(receipt.effective)||receipt.effective.length!==facts.length)throw new StorageError(new Error('Provider retry recovery receipt does not match its request'));
      try{for(const [index,effect] of receipt.effective.entries()) {
        record(effect,['scopeHash','observedAt','active','until','status']);
        if(effect.scopeHash!==facts[index].scopeHash||!epoch(effect.observedAt)||typeof effect.active!=='boolean'||(effect.active?(!epoch(effect.until)||effect.until<=effect.observedAt||!Number.isInteger(effect.status)||effect.status<100||effect.status>599):(effect.until!==null||effect.status!==null)))throw new Error();
      }}catch{throw new StorageError(new Error('Invalid provider retry recovery effect receipt'));}
      return {...receipt,duplicate:true};
    }
    if(!fence.active)throw conflict('New provider retry facts require an active restore hold');
    const fresh=now=>{if(reviewedAt<fence.preparedAt||reviewedAt>now||now-reviewedAt>600000)throw new Error('Provider retry review must be fresh and follow restore preparation');};
    fresh(await store.coordinationNow(q));
    for(const fact of facts)await store.deferProviderRetry(fact.scopeHash,fact.until,fact.status,q);
    const appliedAt=await store.coordinationNow(q);fresh(appliedAt);
    const effective=[];
    for(const fact of facts) {
      const hold=await store.providerRetry(fact.scopeHash,q);
      effective.push({scopeHash:fact.scopeHash,observedAt:hold?hold.until-hold.retryAfterMs:await store.coordinationNow(q),active:Boolean(hold),until:hold?.until??null,status:hold?.status??null});
    }
    const receipt={version:1,...body,bodyHash,appliedAt,authority:'local_operator_attestation',providerVerified:false,effective};
    await q('INSERT INTO sre_checkpoints(id,value,updated_at) VALUES(?,?,?)',[receiptKey,JSON.stringify(receipt),appliedAt]);
    fresh(await store.coordinationNow(q));return {...receipt,duplicate:false};
  });
}
